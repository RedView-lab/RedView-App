import type { ProjectDocument } from '@/features/itineraryPanel/lib/project/layers';

import {
  PROTOCOL_VERSION,
  type ClientMessage,
  type MotionFields,
  type PresenceUpdate,
  type ServerMessage,
} from '../protocol';
import type { CollabRealtime, MotionEvent } from '../realtime';
import { CollabClient, type CollabDeniedReason } from './collabClient';
import type { Rejection } from './syncEngine';

/**
 * Connexion WebSocket d'un client de co-édition : `hello` → `welcome`, lots
 * regroupés à ≈ 30 Hz, reconnexion avec attente exponentielle + aléa (un
 * redémarrage du serveur, code 1012, reconnecte vite mais pas tous en même
 * temps), battement de cœur (connexion à moitié morte détectée en < 45 s).
 * Les refus définitifs (accès retiré, projet supprimé, version) arrêtent la
 * session (`denied`).
 *
 * La connexion s'ouvre quand le store se branche au client (`bind`) : son
 * état provisoire est alors connu, et le premier `welcome` le remplace.
 */

export interface CollabConnectionOptions {
  /** `wss://…/multiplayer`. */
  url: string;
  projectId: string;
  /** JWT Appwrite frais (redemandé à chaque connexion : il expire après 15 min). */
  getToken(): Promise<string>;
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
const PING_INTERVAL_MS = 20_000;
const SILENCE_TIMEOUT_MS = 45_000;
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
  private attempt = 0;
  private unauthorized = 0;
  private started = false;
  private stopped = false;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private flushTimer: ReturnType<typeof setTimeout> | null = null;
  private flushQueued = false;
  private lastFlushAt = 0;
  private pingTimer: ReturnType<typeof setInterval> | null = null;
  private lastMessageAt = 0;

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
    void this.open();
  }

  /** Fin de session (projet fermé) : les lots non envoyés sont abandonnés avec la session. */
  stop(): void {
    this.stopped = true;
    this.clearTimers();
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
      token = await this.options.getToken();
    } catch {
      this.scheduleReconnect();
      return;
    }
    if (this.stopped) return;
    const socket = new this.WebSocketImpl(this.options.url);
    this.socket = socket;
    this.welcomed = false;
    socket.onopen = () => {
      if (socket !== this.socket) return;
      this.lastMessageAt = Date.now();
      const resume = this.client.helloFields();
      const seed = this.client.engine.isReady ? undefined : this.options.seed?.();
      this.helloPresenceVersion = this.presenceVersion;
      this.rawSend({
        type: 'hello',
        v: PROTOCOL_VERSION,
        projectId: this.options.projectId,
        token,
        presence: this.currentPresence(),
        ...resume,
        ...(seed ? { seed } : {}),
      });
      this.pingTimer = setInterval(() => this.heartbeat(), PING_INTERVAL_MS);
    };
    socket.onmessage = (event: MessageEvent) => {
      if (socket !== this.socket) return;
      this.lastMessageAt = Date.now();
      let message: ServerMessage;
      try {
        message = JSON.parse(String(event.data)) as ServerMessage;
      } catch {
        return;
      }
      if (message.type === 'welcome') {
        this.welcomed = true;
        this.attempt = 0;
        this.unauthorized = 0;
      }
      if (message.type === 'error' && message.code === 'unauthorized') this.unauthorized += 1;
      this.client.receive(message);
      if (message.type === 'welcome' && this.presenceVersion !== this.helloPresenceVersion) this.sendPresence();
    };
    socket.onclose = (event: CloseEvent) => {
      if (socket !== this.socket) return;
      this.socket = null;
      this.welcomed = false;
      if (this.pingTimer) clearInterval(this.pingTimer);
      this.pingTimer = null;
      if (this.stopped) return;
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

  private heartbeat(): void {
    if (Date.now() - this.lastMessageAt > SILENCE_TIMEOUT_MS) {
      this.restart(0);
      return;
    }
    this.send({ type: 'ping', t: Date.now() });
  }

  /** Ferme la connexion courante et se reconnecte après `delayMs`. */
  private restart(delayMs: number): void {
    const socket = this.socket;
    this.socket = null;
    this.welcomed = false;
    if (this.pingTimer) clearInterval(this.pingTimer);
    this.pingTimer = null;
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

  private rawSend(message: ClientMessage): void {
    const socket = this.socket;
    if (!socket || socket.readyState !== this.WebSocketImpl.OPEN) return;
    socket.send(JSON.stringify(message));
  }

  private clearTimers(): void {
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    if (this.flushTimer) clearTimeout(this.flushTimer);
    if (this.pingTimer) clearInterval(this.pingTimer);
    if (this.presenceTimer) clearTimeout(this.presenceTimer);
    this.reconnectTimer = null;
    this.flushTimer = null;
    this.pingTimer = null;
    this.presenceTimer = null;
  }
}
