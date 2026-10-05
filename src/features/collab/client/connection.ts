import type { ProjectDocument } from '@/features/itineraryPanel/lib/project/layers';

import { PROTOCOL_VERSION, type ClientMessage, type PresenceState, type ServerMessage } from '../protocol';
import { CollabClient } from './collabClient';
import type { Rejection } from './syncEngine';

/**
 * Connexion WebSocket d'un client de co-édition : `hello` → `welcome`, lots
 * regroupés à ≈ 30 Hz, reconnexion avec attente exponentielle + aléa (un
 * redémarrage du serveur, code 1012, reconnecte vite mais pas tous en même
 * temps), battement de cœur (connexion à moitié morte détectée en < 45 s).
 * Les refus définitifs (accès retiré, projet supprimé, version) arrêtent la
 * session (`denied`).
 */

export interface CollabConnectionOptions {
  /** `wss://…/multiplayer`. */
  url: string;
  projectId: string;
  /** JWT Appwrite frais (redemandé à chaque connexion : il expire après 15 min). */
  getToken(): Promise<string>;
  presence?(): PresenceState;
  /** Développement : document qui crée la salle d'un projet local inconnu du serveur. */
  seed?(): ProjectDocument | undefined;
  WebSocketImpl?: typeof WebSocket;
  clientId?: string;
  onRejection?(rejection: Rejection): void;
}

const FLUSH_DELAY_MS = 33;
const PING_INTERVAL_MS = 20_000;
const SILENCE_TIMEOUT_MS = 45_000;
const BACKOFF_BASE_MS = 500;
const BACKOFF_MAX_MS = 15_000;
/** Refus définitifs : inutile de réessayer. */
const TERMINAL_CODES = new Set([4403, 4404, 4426]);
const MAX_UNAUTHORIZED_RETRIES = 3;

function createClientId(): string {
  return globalThis.crypto.randomUUID();
}

export class CollabConnection {
  readonly client: CollabClient;
  private readonly options: CollabConnectionOptions;
  private readonly WebSocketImpl: typeof WebSocket;
  private socket: WebSocket | null = null;
  private welcomed = false;
  private attempt = 0;
  private unauthorized = 0;
  private stopped = false;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private flushTimer: ReturnType<typeof setTimeout> | null = null;
  private pingTimer: ReturnType<typeof setInterval> | null = null;
  private lastMessageAt = 0;

  constructor(options: CollabConnectionOptions) {
    this.options = options;
    this.WebSocketImpl = options.WebSocketImpl ?? globalThis.WebSocket;
    this.client = new CollabClient({
      clientId: options.clientId ?? createClientId(),
      onRejection: options.onRejection,
      transport: {
        isOnline: () => this.welcomed && this.socket?.readyState === this.WebSocketImpl.OPEN,
        send: (message) => this.send(message),
        requestFlush: () => this.scheduleFlush(),
        resync: () => this.restart(0),
      },
    });
  }

  start(): void {
    this.stopped = false;
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

  /** Présence changée (itinéraire actif…) : envoyée si en ligne. */
  updatePresence(): void {
    const presence = this.options.presence?.();
    if (presence) this.client.setPresence(presence);
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
      this.rawSend({
        type: 'hello',
        v: PROTOCOL_VERSION,
        projectId: this.options.projectId,
        token,
        presence: this.options.presence?.(),
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
      if (message.type === 'error') {
        if (message.code === 'unauthorized') this.unauthorized += 1;
        if (message.code === 'forbidden' || message.code === 'not-found' || message.code === 'version') {
          this.client.denied(message.code);
        }
      }
      this.client.receive(message);
    };
    socket.onclose = (event: CloseEvent) => {
      if (socket !== this.socket) return;
      this.socket = null;
      this.welcomed = false;
      if (this.pingTimer) clearInterval(this.pingTimer);
      this.pingTimer = null;
      if (this.stopped) return;
      if (TERMINAL_CODES.has(event.code) || (event.code === 4401 && this.unauthorized >= MAX_UNAUTHORIZED_RETRIES)) {
        this.client.denied(event.code === 4401 ? 'unauthorized' : event.reason || String(event.code));
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

  private scheduleFlush(): void {
    if (this.flushTimer) return;
    this.flushTimer = setTimeout(() => {
      this.flushTimer = null;
      this.client.flush();
    }, FLUSH_DELAY_MS);
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
    this.reconnectTimer = null;
    this.flushTimer = null;
    this.pingTimer = null;
  }
}
