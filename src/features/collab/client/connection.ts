import type { ProjectDocument } from '@/features/itineraryPanel/lib/project/layers';

import {
  PROTOCOL_VERSION,
  projectSocketUrl,
  socketProtocols,
  type ClientMessage,
  type MotionFields,
  type PresenceUpdate,
  type ServerMessage,
} from '../protocol';
import type { CollabRealtime, MotionEvent } from '../realtime';
import { canDeflateWire, canInflateWire, deflateWire, inflateWire, WIRE_COMPRESS_MIN_CHARS } from '../wire';
import { CollabClient, type CollabDeniedReason } from './collabClient';
import type { Rejection } from './syncEngine';

/**
 * Connexion WebSocket d'un client de co-édition : `hello` → `welcome`, lots
 * regroupés à ≈ 30 Hz, reconnexion avec attente exponentielle + aléa (un
 * redémarrage du serveur, code 1012, reconnecte vite mais pas tous en même
 * temps), battement de cœur (connexion à moitié morte détectée en < 30 s,
 * ≈ 4 s au retour de l'onglet, du réseau ou d'une mise en veille). Les refus
 * définitifs (accès retiré, projet supprimé, version) arrêtent la session
 * (`denied`).
 *
 * La connexion s'ouvre quand le store se branche au client (`bind`) : son
 * état provisoire est alors connu, et le premier `welcome` le remplace. Le
 * jeton est présenté à l'ouverture (sous-protocole, protocol.ts), puis relevé
 * toutes les `REAUTH_INTERVAL_MS` : le serveur ferme (4401) une connexion dont
 * le jeton a expiré, et on se reconnecte alors avec un jeton neuf.
 */

export interface CollabConnectionOptions {
  /** `wss://…/multiplayer`. */
  url: string;
  projectId: string;
  /**
   * JWT Appwrite (réutilisé tant qu'il est frais, jwtCache.ts) ; `fresh` :
   * le précédent a été refusé (4401), en créer un autre.
   */
  getToken(options?: { fresh?: boolean }): Promise<string>;
  /** Présence de base (nom affiché) ; `updatePresence` y ajoute l'état courant (suivi, Spotlight…). */
  presence?(): PresenceUpdate;
  /** Développement : document qui crée la salle d'un projet local inconnu du serveur. */
  seed?(): ProjectDocument | undefined;
  WebSocketImpl?: typeof WebSocket;
  clientId?: string;
  onRejection?(rejection: Rejection): void;
  /** Lots que le serveur n'a peut-être pas écrits changés (copie sur l'appareil). */
  onUnsyncedChange?(): void;
}

const FLUSH_DELAY_MS = 33;
/** La salle regroupe la présence à 10 Hz : inutile d'en envoyer plus. */
const PRESENCE_MIN_INTERVAL_MS = 100;
/** Message éphémère (`motion`) sauté au-delà : il passerait derrière des lots en attente. */
const MAX_VOLATILE_BUFFERED_BYTES = 64 * 1024;
const PING_INTERVAL_MS = 15_000;
/**
 * Ping resté sans réponse (ni aucun autre message) au-delà : connexion morte.
 * Compté depuis l'envoi du ping, pas depuis le dernier message : dans un
 * onglet en arrière-plan depuis 5 min, Chrome ne réveille plus les minuteries
 * qu'une fois par minute, et un silence compté depuis le dernier message
 * concluait à une connexion morte à chaque réveil (reconnexion chaque minute).
 */
const PONG_TIMEOUT_MS = 10_000;
/** Vérification tout de suite (onglet revenu, réseau revenu, sortie de veille) : réponse attendue sous ce délai. */
const PROBE_TIMEOUT_MS = 4_000;
const PROBE_MIN_INTERVAL_MS = 2_000;
/**
 * Connexion pas encore accueillie (`welcome`) au-delà : abandonnée et
 * recommencée (réseau mort pendant l'ouverture : le navigateur peut attendre
 * des minutes ; le serveur, lui, ferme une connexion muette après 10 s).
 */
const WELCOME_TIMEOUT_MS = 20_000;
/**
 * Relève du jeton : bien avant son expiration (un JWT Appwrite vit 15 min et
 * le cache le reprend 10 min, jwtCache.ts) ; dans un onglet en arrière-plan,
 * les minuteries peuvent prendre une minute de retard.
 */
const REAUTH_INTERVAL_MS = 4 * 60_000;
const BACKOFF_BASE_MS = 500;
const BACKOFF_MAX_MS = 15_000;
/** Refus définitifs (code de fermeture → raison) : inutile de réessayer. */
const TERMINAL_CODES = new Map<number, CollabDeniedReason>([
  [4403, 'forbidden'],
  [4404, 'not-found'],
  [4426, 'version'],
]);
const MAX_UNAUTHORIZED_RETRIES = 3;

function createClientId(): string {
  return globalThis.crypto.randomUUID();
}

export class CollabConnection implements CollabRealtime {
  readonly client: CollabClient;
  private readonly options: CollabConnectionOptions;
  /** État de présence ajouté à la présence de base (`options.presence`). */
  private localPresence: Partial<PresenceUpdate> = {};
  private presenceTimer: ReturnType<typeof setTimeout> | null = null;
  private lastPresenceAt = 0;
  /** Présence changée depuis le `hello` : renvoyée au `welcome` (avant, rien ne part). */
  private presenceVersion = 0;
  private helloPresenceVersion = 0;
  private readonly WebSocketImpl: typeof WebSocket;
  private socket: WebSocket | null = null;
  private welcomed = false;
  /** Le serveur de la connexion courante lit les messages compressés (`welcome.compress`, wire.ts). */
  private serverInflates = false;
  /** Envois en attente d'une compression, dans l'ordre : un message suivant ne la double jamais. */
  private outbound: { socket: WebSocket; chain: Promise<void> } | null = null;
  private attempt = 0;
  private unauthorized = 0;
  private started = false;
  private stopped = false;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private flushTimer: ReturnType<typeof setTimeout> | null = null;
  private flushQueued = false;
  private lastFlushAt = 0;
  private pingTimer: ReturnType<typeof setInterval> | null = null;
  private authTimer: ReturnType<typeof setInterval> | null = null;
  /** Messages reçus sur la connexion courante : un ping a sa réponse dès que ce nombre bouge. */
  private received = 0;
  /** Ping sans réponse en cours (null : aucun) et `received` à son envoi. */
  private pingSentAt: number | null = null;
  private pingMark = 0;
  private probeTimer: ReturnType<typeof setTimeout> | null = null;
  private welcomeTimer: ReturnType<typeof setTimeout> | null = null;
  private lastProbeAt = Number.NEGATIVE_INFINITY;
  private readonly onWake = () => this.probe();
  private readonly onVisibility = () => {
    if (typeof document !== 'undefined' && document.visibilityState === 'visible') this.probe();
  };

  constructor(options: CollabConnectionOptions) {
    this.options = options;
    this.WebSocketImpl = options.WebSocketImpl ?? globalThis.WebSocket;
    this.client = new CollabClient({
      clientId: options.clientId ?? createClientId(),
      onRejection: options.onRejection,
      onUnsyncedChange: options.onUnsyncedChange,
      // Store branché : la session a son état provisoire, on peut se connecter.
      onBind: () => this.start(),
      transport: {
        isOnline: () => this.welcomed && this.socket?.readyState === this.WebSocketImpl.OPEN,
        send: (message) => this.send(message),
        requestFlush: () => this.scheduleFlush(),
        resync: () => this.restart(0),
      },
    });
  }

  /** Ouvre la connexion (une fois ; sans effet après `stop`). */
  start(): void {
    if (this.started || this.stopped) return;
    this.started = true;
    // Retour de l'onglet, du réseau, d'une mise en veille : la connexion peut être
    // morte sans fermeture (le système ne le dit qu'au bout de minutes).
    if (typeof window !== 'undefined') {
      window.addEventListener('online', this.onWake);
      window.addEventListener('pageshow', this.onWake);
    }
    if (typeof document !== 'undefined') {
      document.addEventListener('visibilitychange', this.onVisibility);
      document.addEventListener('resume', this.onWake);
    }
    void this.open();
  }

  /** Fin de session (projet fermé) : les lots non envoyés sont abandonnés avec la session. */
  stop(): void {
    this.stopped = true;
    this.clearTimers();
    if (typeof window !== 'undefined') {
      window.removeEventListener('online', this.onWake);
      window.removeEventListener('pageshow', this.onWake);
    }
    if (typeof document !== 'undefined') {
      document.removeEventListener('visibilitychange', this.onVisibility);
      document.removeEventListener('resume', this.onWake);
    }
    const socket = this.socket;
    this.socket = null;
    this.welcomed = false;
    socket?.close(1000, 'closed');
    this.client.dispose();
  }

  get clientId(): string {
    return this.client.clientId;
  }

  /**
   * Présence changée (itinéraire actif, suivi, Spotlight…) : fusionnée, envoyée
   * au plus à 10 Hz si en ligne, et toujours redonnée au `hello` suivant.
   */
  updatePresence(patch: Partial<PresenceUpdate> = {}): void {
    this.localPresence = { ...this.localPresence, ...patch };
    this.presenceVersion += 1;
    if (this.presenceTimer) return;
    const wait = PRESENCE_MIN_INTERVAL_MS - (Date.now() - this.lastPresenceAt);
    if (wait <= 0) {
      this.sendPresence();
      return;
    }
    this.presenceTimer = setTimeout(() => {
      this.presenceTimer = null;
      this.sendPresence();
    }, wait);
  }

  subscribeMotion(listener: (event: MotionEvent) => void): () => void {
    return this.client.subscribeMotion(listener);
  }

  sendMotion(t: number, fields: MotionFields): boolean {
    return this.client.sendMotion(t, fields);
  }

  canSendVolatile(): boolean {
    const socket = this.socket;
    return !!socket && this.welcomed && socket.bufferedAmount < MAX_VOLATILE_BUFFERED_BYTES;
  }

  private currentPresence(): PresenceUpdate {
    return { ...this.options.presence?.(), ...this.localPresence };
  }

  private sendPresence(): void {
    this.lastPresenceAt = Date.now();
    this.client.setPresence(this.currentPresence());
  }

  private async open(): Promise<void> {
    if (this.stopped) return;
    let token: string;
    try {
      // Jeton refusé à la tentative précédente (4401) : un nouveau, pas celui en cache.
      token = await this.options.getToken({ fresh: this.unauthorized > 0 });
    } catch {
      this.scheduleReconnect();
      return;
    }
    if (this.stopped) return;
    const socket = new this.WebSocketImpl(projectSocketUrl(this.options.url, this.options.projectId), socketProtocols(token));
    socket.binaryType = 'arraybuffer';
    this.socket = socket;
    this.welcomed = false;
    this.serverInflates = false;
    /** Messages reçus en attente d'une décompression, dans l'ordre (wire.ts). */
    let inbound: Promise<void> | null = null;
    this.welcomeTimer = setTimeout(() => {
      this.welcomeTimer = null;
      if (socket === this.socket && !this.welcomed) this.restart(0);
    }, WELCOME_TIMEOUT_MS);
    socket.onopen = () => {
      if (socket !== this.socket) return;
      this.received = 0;
      this.pingSentAt = null;
      const resume = this.client.helloFields();
      const seed = this.client.engine.isReady ? undefined : this.options.seed?.();
      this.helloPresenceVersion = this.presenceVersion;
      this.rawSend({
        type: 'hello',
        v: PROTOCOL_VERSION,
        presence: this.currentPresence(),
        ...resume,
        ...(seed ? { seed } : {}),
        ...(canInflateWire() ? { compress: true } : {}),
      });
      this.pingTimer = setInterval(() => this.heartbeat(), PING_INTERVAL_MS);
    };
    socket.onmessage = (event: MessageEvent) => {
      if (socket !== this.socket) return;
      this.received += 1;
      const data: unknown = event.data;
      // Trame texte sans décompression en cours : traitée tout de suite (caméra et curseur à 30 Hz).
      if (typeof data === 'string' && !inbound) {
        this.receiveText(socket, data);
        return;
      }
      const next = (inbound ?? Promise.resolve()).then(async () => {
        let text: string;
        try {
          text = typeof data === 'string' ? data : await inflateWire(data as ArrayBuffer | Blob);
        } catch {
          // Trame illisible : l'état n'est plus sûr, on repart d'une connexion neuve.
          if (socket === this.socket) this.restart(0);
          return;
        }
        if (socket !== this.socket) return;
        try {
          this.receiveText(socket, text);
        } catch (error) {
          // Comme pour un message traité tout de suite : l'erreur remonte, les suivants passent.
          setTimeout(() => {
            throw error;
          });
        }
      });
      inbound = next;
      void next.finally(() => {
        if (inbound === next) inbound = null;
      });
    };
    socket.onclose = (event: CloseEvent) => {
      if (socket !== this.socket) return;
      this.socket = null;
      this.welcomed = false;
      this.clearHeartbeat();
      if (this.stopped) return;
      // Jeton refusé (ou expiré sans relève) : le suivant sera neuf ; au-delà de quelques refus, session expirée.
      if (event.code === 4401) this.unauthorized += 1;
      const denied = TERMINAL_CODES.get(event.code)
        ?? (event.code === 4401 && this.unauthorized >= MAX_UNAUTHORIZED_RETRIES ? 'unauthorized' : null);
      if (denied) {
        this.client.denied(denied);
        this.client.disconnected(false);
        return;
      }
      this.client.disconnected(true);
      this.scheduleReconnect(event.code);
    };
  }

  /** Relève du jeton sur la connexion courante (un échec attend la relève suivante, ou la fermeture 4401). */
  private async reauthenticate(socket: WebSocket): Promise<void> {
    let token: string;
    try {
      token = await this.options.getToken();
    } catch {
      return;
    }
    if (socket === this.socket && this.welcomed) this.rawSend({ type: 'auth', token });
  }

  private heartbeat(): void {
    if (this.pingUnanswered(PONG_TIMEOUT_MS)) {
      this.restart(0);
      return;
    }
    this.sendPing();
  }

  /** Un ping attend sa réponse depuis plus de `ms` (aucun message reçu depuis son envoi). */
  private pingUnanswered(ms: number): boolean {
    return this.pingSentAt !== null && this.received === this.pingMark && Date.now() - this.pingSentAt >= ms;
  }

  /** Ping, sauf si le précédent attend encore sa réponse (son heure d'envoi fait foi). */
  private sendPing(): void {
    // Avant `welcome`, le serveur ignore tout (WELCOME_TIMEOUT_MS veille).
    if (!this.welcomed) return;
    if (this.pingSentAt !== null && this.received === this.pingMark) return;
    const now = Date.now();
    this.pingSentAt = now;
    this.pingMark = this.received;
    this.rawSend({ type: 'ping', t: now });
  }

  /**
   * Onglet revenu au premier plan, réseau revenu, page sortie de veille : en
   * attente d'une nouvelle tentative, on se reconnecte tout de suite ; en
   * ligne, un ping doit revenir sous `PROBE_TIMEOUT_MS` (sinon la connexion
   * était morte : on en ouvre une autre).
   */
  private probe(): void {
    if (!this.started || this.stopped) return;
    const now = Date.now();
    if (now - this.lastProbeAt < PROBE_MIN_INTERVAL_MS) return;
    this.lastProbeAt = now;
    if (!this.socket) {
      if (!this.reconnectTimer) return;
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
      void this.open();
      return;
    }
    if (!this.welcomed) return;
    this.sendPing();
    if (this.probeTimer) clearTimeout(this.probeTimer);
    this.probeTimer = setTimeout(() => {
      this.probeTimer = null;
      if (this.socket && this.pingUnanswered(PROBE_TIMEOUT_MS)) this.restart(0);
    }, PROBE_TIMEOUT_MS);
  }

  private clearHeartbeat(): void {
    if (this.pingTimer) clearInterval(this.pingTimer);
    if (this.authTimer) clearInterval(this.authTimer);
    this.authTimer = null;
    if (this.probeTimer) clearTimeout(this.probeTimer);
    if (this.welcomeTimer) clearTimeout(this.welcomeTimer);
    this.pingTimer = null;
    this.probeTimer = null;
    this.welcomeTimer = null;
    this.pingSentAt = null;
  }

  /** Ferme la connexion courante et se reconnecte après `delayMs`. */
  private restart(delayMs: number): void {
    const socket = this.socket;
    this.socket = null;
    this.welcomed = false;
    this.clearHeartbeat();
    socket?.close(4000, 'resync');
    this.client.disconnected(true);
    if (this.stopped) return;
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      void this.open();
    }, delayMs);
  }

  private scheduleReconnect(code?: number): void {
    if (this.stopped || this.reconnectTimer) return;
    const exponential = Math.min(BACKOFF_MAX_MS, BACKOFF_BASE_MS * 2 ** this.attempt);
    // Redémarrage du serveur : on revient vite, étalés sur 1,5 s.
    const delay = code === 1012 && this.attempt === 0 ? 300 + Math.random() * 1_200 : exponential * (0.5 + Math.random() * 0.5);
    this.attempt += 1;
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      void this.open();
    }, delay);
  }

  /**
   * Envoi au front montant : la première modification après un temps calme
   * part tout de suite (fin de la tâche courante, pour regrouper les écritures
   * synchrones d'une même action) ; une rafale est regroupée à ≈ 30 Hz.
   */
  private scheduleFlush(): void {
    if (this.flushTimer || this.flushQueued) return;
    const wait = FLUSH_DELAY_MS - (Date.now() - this.lastFlushAt);
    if (wait <= 0) {
      this.flushQueued = true;
      queueMicrotask(() => {
        this.flushQueued = false;
        this.flushNow();
      });
      return;
    }
    this.flushTimer = setTimeout(() => {
      this.flushTimer = null;
      this.flushNow();
    }, wait);
  }

  private flushNow(): void {
    this.lastFlushAt = Date.now();
    this.client.flush();
  }

  private send(message: ClientMessage): void {
    if (!this.welcomed) return;
    this.rawSend(message);
  }

  /** Un message du serveur (JSON, décompressé s'il le fallait), dans l'ordre d'arrivée. */
  private receiveText(socket: WebSocket, text: string): void {
    let message: ServerMessage;
    try {
      message = JSON.parse(text) as ServerMessage;
    } catch {
      return;
    }
    if (message.type === 'welcome') {
      this.welcomed = true;
      this.serverInflates = message.compress === true;
      if (this.welcomeTimer) clearTimeout(this.welcomeTimer);
      this.welcomeTimer = null;
      this.attempt = 0;
      this.unauthorized = 0;
      if (this.authTimer) clearInterval(this.authTimer);
      this.authTimer = setInterval(() => void this.reauthenticate(socket), REAUTH_INTERVAL_MS);
    }
    this.client.receive(message);
    if (message.type === 'welcome' && this.presenceVersion !== this.helloPresenceVersion) this.sendPresence();
  }

  /**
   * Envoi : un gros message (segments de tracé) part compressé si le serveur
   * le lit (wire.ts) ; tant qu'une compression est en cours, les messages
   * suivants l'attendent (l'ordre des lots est celui du serveur).
   */
  private rawSend(message: ClientMessage): void {
    const socket = this.socket;
    if (!socket || socket.readyState !== this.WebSocketImpl.OPEN) return;
    const json = JSON.stringify(message);
    const compress = this.serverInflates && json.length >= WIRE_COMPRESS_MIN_CHARS && canDeflateWire();
    const pending = this.outbound?.socket === socket ? this.outbound.chain : null;
    if (!compress && !pending) {
      socket.send(json);
      return;
    }
    const work = async () => {
      let data: string | ArrayBuffer = json;
      if (compress) {
        try {
          data = await deflateWire(json);
        } catch {
          // Compression impossible : le texte passe aussi.
        }
      }
      if (socket === this.socket && socket.readyState === this.WebSocketImpl.OPEN) socket.send(data);
    };
    // Après un envoi qui a échoué aussi : la file ne s'arrête jamais.
    const chain = (pending ?? Promise.resolve()).then(work, work);
    const entry = { socket, chain };
    this.outbound = entry;
    void chain.finally(() => {
      if (this.outbound === entry) this.outbound = null;
    });
  }

  private clearTimers(): void {
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    if (this.flushTimer) clearTimeout(this.flushTimer);
    if (this.presenceTimer) clearTimeout(this.presenceTimer);
    this.clearHeartbeat();
    this.reconnectTimer = null;
    this.flushTimer = null;
    this.presenceTimer = null;
  }
}
