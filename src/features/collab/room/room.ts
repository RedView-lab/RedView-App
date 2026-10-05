import type { DerivedKind } from '@/features/itineraryPanel/context/ProjectStore/collab';

import { itineraryIdOf, itineraryObjectId } from '../model/paths';
import {
  PROTOCOL_VERSION,
  type ClientMessage,
  type PeerInfo,
  type PresenceState,
  type SequencedBatch,
  type ServerMessage,
} from '../protocol';
import { LeaseTable } from './leases';
import type { RoomState } from './roomState';

/**
 * Salle de co-édition d'un projet, sans réseau ni stockage : le serveur
 * temps réel (server/multiplayer) y branche ses WebSocket et son journal, le
 * simulateur de tests ses clients et son réseau simulés.
 *
 * Un seul fil d'exécution (boucle d'événements) : les lots sont appliqués un
 * par un dans l'ordre d'arrivée, qui devient l'ordre de tous.
 */

export interface RoomPeer {
  readonly clientId: string;
  readonly userId: string;
  send(message: ServerMessage): void;
}

export interface RoomOptions {
  /** Instance de la salle (aléatoire à chaque chargement). */
  epoch: string;
  now(): number;
  /** Lot accepté, à journaliser ; le serveur appelle `markDurable` une fois écrit. */
  onBatch?(batch: SequencedBatch): void;
  /** Lots gardés en mémoire pour rattraper une reconnexion sans renvoyer l'état complet. */
  catchUpLimit?: number;
  /** Séquence déjà durable au chargement (point de sauvegarde + journal relu). */
  durableSeq?: number;
}

export interface JoinRequest {
  epoch: string | null;
  lastSeq: number | null;
  presence?: PresenceState;
}

const DEFAULT_CATCH_UP_LIMIT = 2_000;
const MAX_PRESENCE_CHARS = 2_048;

interface Member {
  peer: RoomPeer;
  presence: PresenceState;
}

export class Room {
  readonly state: RoomState;
  readonly epoch: string;
  private readonly options: RoomOptions;
  private readonly members = new Map<string, Member>();
  private readonly leases = new LeaseTable();
  private readonly recent: SequencedBatch[] = [];
  private durable: number;
  private peersDirty = false;

  constructor(state: RoomState, options: RoomOptions) {
    this.state = state;
    this.epoch = options.epoch;
    this.options = options;
    this.durable = options.durableSeq ?? state.seq;
  }

  get memberCount(): number {
    return this.members.size;
  }

  get durableSeq(): number {
    return this.durable;
  }

  isConnected(clientId: string): boolean {
    return this.members.has(clientId);
  }

  /** Arrivée d'un client authentifié (le serveur a vérifié son jeton et ses droits). */
  join(peer: RoomPeer, request: JoinRequest): void {
    // Même client sur une nouvelle connexion : l'ancienne est remplacée.
    const previous = this.members.get(peer.clientId);
    if (previous && previous.peer !== peer) this.leave(peer.clientId);
    this.members.set(peer.clientId, { peer, presence: sanitizePresence(request.presence) });
    const catchUp = this.catchUpFor(request);
    peer.send({
      type: 'welcome',
      v: PROTOCOL_VERSION,
      epoch: this.epoch,
      clientId: peer.clientId,
      userId: peer.userId,
      seq: this.state.seq,
      durableSeq: this.durable,
      clientSeq: this.state.lastClientSeqOf(peer.clientId),
      ...(catchUp ? { catchUp } : { snapshot: this.state.snapshot() }),
      peers: this.peerList(),
      leases: this.leases.list(),
    });
    this.peersDirty = true;
  }

  /** Départ d'un client ; avec `peer`, seulement si c'est bien sa connexion courante (une ancienne qui se ferme tard ne compte pas). */
  leave(clientId: string, peer?: RoomPeer): void {
    const member = this.members.get(clientId);
    if (!member || (peer && member.peer !== peer)) return;
    this.members.delete(clientId);
    if (this.leases.releaseClient(clientId)) this.broadcastLeases();
    this.peersDirty = true;
  }

  handle(clientId: string, message: ClientMessage): void {
    const member = this.members.get(clientId);
    if (!member) return;
    switch (message.type) {
      case 'batch':
        this.handleBatch(member.peer, message);
        return;
      case 'lease':
        this.handleLease(member.peer, message);
        return;
      case 'presence':
        member.presence = sanitizePresence(message.presence);
        this.peersDirty = true;
        return;
      case 'ping':
        member.peer.send({ type: 'pong', t: message.t });
        return;
      default:
        member.peer.send({ type: 'error', code: 'bad-request', message: 'unknown-message' });
    }
  }

  /** Lots jusqu'à `seq` écrits dans le journal. */
  markDurable(seq: number): void {
    if (seq <= this.durable) return;
    this.durable = Math.min(seq, this.state.seq);
    this.broadcast({ type: 'durable', seq: this.durable });
  }

  /** Appelé régulièrement (≈ 10 Hz) : baux expirés, présence regroupée. */
  tick(): void {
    if (this.leases.expire(this.options.now())) this.broadcastLeases();
    if (this.peersDirty) {
      this.peersDirty = false;
      this.broadcast({ type: 'peers', peers: this.peerList() });
    }
  }

  private handleBatch(peer: RoomPeer, message: Extract<ClientMessage, { type: 'batch' }>): void {
    if (!Number.isSafeInteger(message.clientSeq) || message.clientSeq <= 0) {
      peer.send({ type: 'error', code: 'bad-request', message: 'bad-client-seq' });
      return;
    }
    const blobs = isStringRecord(message.blobs) ? message.blobs : null;
    if (!blobs) {
      peer.send({ type: 'reject', clientSeq: message.clientSeq, reason: 'bad-blobs' });
      return;
    }
    const outcome = this.state.applyClientBatch(
      { clientId: peer.clientId, clientSeq: message.clientSeq, ops: message.ops, blobs },
      peer.userId,
      this.options.now(),
    );
    if (outcome.kind === 'duplicate') {
      peer.send({ type: 'duplicate', clientSeq: message.clientSeq });
      return;
    }
    if (outcome.kind === 'rejected') {
      peer.send({ type: 'reject', clientSeq: message.clientSeq, reason: outcome.reason, missingBlobs: outcome.missingBlobs });
      return;
    }
    const { batch } = outcome;
    this.recent.push(batch);
    const limit = this.options.catchUpLimit ?? DEFAULT_CATCH_UP_LIMIT;
    if (this.recent.length > limit) this.recent.splice(0, this.recent.length - limit);
    this.options.onBatch?.(batch);
    this.broadcast({ type: 'batch', batch });
    this.dropLeasesOfDeletedItineraries(batch);
  }

  private handleLease(peer: RoomPeer, message: Extract<ClientMessage, { type: 'lease' }>): void {
    const { kind, itineraryId } = message;
    if (!isDerivedKind(kind) || typeof itineraryId !== 'string' || !this.state.store.has(itineraryObjectId(itineraryId))) {
      peer.send({ type: 'lease-denied', kind, itineraryId, retryAfterMs: 60_000 });
      return;
    }
    const now = this.options.now();
    switch (message.action) {
      case 'request': {
        const decision = this.leases.request(kind, itineraryId, peer, now, {
          author: this.state.lastInputAuthor(kind, itineraryId),
          isConnected: (clientId) => this.members.has(clientId),
        });
        if (!decision.granted) {
          peer.send({ type: 'lease-denied', kind, itineraryId, retryAfterMs: Math.max(50, decision.retryAfterMs) });
        } else if (decision.changed) {
          this.broadcastLeases();
        } else {
          peer.send({ type: 'leases', leases: this.leases.list() });
        }
        return;
      }
      case 'renew':
        if (!this.leases.renew(kind, itineraryId, peer.clientId, now)) peer.send({ type: 'leases', leases: this.leases.list() });
        return;
      case 'release':
        if (this.leases.release(kind, itineraryId, peer.clientId)) this.broadcastLeases();
        return;
      default:
        peer.send({ type: 'error', code: 'bad-request', message: 'bad-lease-action' });
    }
  }

  /** Lots manquants d'un client qui se reconnecte à la même instance ; null : état complet. */
  private catchUpFor(request: JoinRequest): SequencedBatch[] | null {
    if (request.epoch !== this.epoch || request.lastSeq === null || !Number.isSafeInteger(request.lastSeq)) return null;
    if (request.lastSeq > this.state.seq) return null;
    if (request.lastSeq === this.state.seq) return [];
    const first = this.recent[0];
    if (!first || first.seq > request.lastSeq + 1) return null;
    return this.recent.filter((batch) => batch.seq > request.lastSeq!);
  }

  private dropLeasesOfDeletedItineraries(batch: SequencedBatch): void {
    let changed = false;
    for (const op of batch.ops) {
      if (op.t !== 'd') continue;
      const itineraryId = itineraryIdOf(op.id);
      if (itineraryId && op.id === itineraryObjectId(itineraryId)) changed = this.leases.dropItinerary(itineraryId) || changed;
    }
    if (changed) this.broadcastLeases();
  }

  private peerList(): PeerInfo[] {
    return [...this.members.values()].map(({ peer, presence }) => ({ clientId: peer.clientId, userId: peer.userId, presence }));
  }

  private broadcastLeases(): void {
    this.broadcast({ type: 'leases', leases: this.leases.list() });
  }

  private broadcast(message: ServerMessage): void {
    for (const { peer } of this.members.values()) peer.send(message);
  }
}

const DERIVED_KINDS: readonly DerivedKind[] = ['route', 'prediction', 'poi'];

function isDerivedKind(value: unknown): value is DerivedKind {
  return DERIVED_KINDS.includes(value as DerivedKind);
}

function isStringRecord(value: unknown): value is Record<string, string> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return false;
  return Object.values(value).every((entry) => typeof entry === 'string');
}

function sanitizePresence(presence: unknown): PresenceState {
  if (presence === null || typeof presence !== 'object') return {};
  const source = presence as Record<string, unknown>;
  const out: PresenceState = {};
  if (typeof source.name === 'string') out.name = source.name.slice(0, 80);
  if (typeof source.color === 'string' && /^#[0-9a-f]{6}$/i.test(source.color)) out.color = source.color;
  if (typeof source.activeItineraryId === 'string' || source.activeItineraryId === null) {
    out.activeItineraryId = typeof source.activeItineraryId === 'string' ? source.activeItineraryId.slice(0, 200) : null;
  }
  if (typeof source.activeMode === 'string' || source.activeMode === null) {
    out.activeMode = typeof source.activeMode === 'string' ? source.activeMode.slice(0, 40) : null;
  }
  return JSON.stringify(out).length > MAX_PRESENCE_CHARS ? {} : out;
}
