import type { DerivedKind } from '@/features/itineraryPanel/context/ProjectStore/collab';

import { itineraryIdOf, itineraryObjectId } from '../model/paths';
import {
  PROTOCOL_VERSION,
  type ClientMessage,
  type MotionState,
  type PeerInfo,
  type PresenceState,
  type SequencedBatch,
  type ServerMessage,
} from '../protocol';
import { LeaseTable } from './leases';
import { mergeMotion, MotionBucket, sanitizeMotion } from './motion';
import { estimateBatchChars, type RoomState } from './roomState';

/**
 * Salle de co-édition d'un projet, sans réseau ni stockage : le serveur
 * temps réel (server/multiplayer) y branche ses WebSocket et son journal, le
 * simulateur de tests ses clients et son réseau simulés.
 *
 * Un seul fil d'exécution (boucle d'événements) : les lots sont appliqués un
 * par un dans l'ordre d'arrivée, qui devient l'ordre de tous.
 */

export interface SendOptions {
  /**
   * Message éphémère (`motion`) : le transport peut le sauter sous
   * contre-pression plutôt que de le mettre en file (le suivant le remplace).
   */
  volatile?: boolean;
}

export interface RoomPeer {
  readonly clientId: string;
  readonly userId: string;
  /**
   * Nom vérifié par le serveur (compte Appwrite) : il remplace celui que le
   * client met dans sa présence (avatars, curseurs, « suivre »), qu'il ne
   * choisit donc pas. Absent : nom de la présence (développement, tests).
   */
  readonly name?: string;
  send(message: ServerMessage, options?: SendOptions): void;
}

/** Sort d'un message `motion` (mesures du serveur). */
export type MotionOutcome = 'relayed' | 'rate-limited' | 'invalid';

export interface RoomOptions {
  /** Instance de la salle (aléatoire à chaque chargement). */
  epoch: string;
  now(): number;
  /** Lot accepté, à journaliser ; le serveur appelle `markDurable` une fois écrit. */
  onBatch?(batch: SequencedBatch): void;
  /** Lots gardés en mémoire pour rattraper une reconnexion sans renvoyer l'état complet. */
  catchUpLimit?: number;
  /** Taille (≈ octets JSON) de ces lots ; au-delà, l'état complet coûte moins (cf. `setCatchUpBudget`). */
  catchUpBudgetBytes?: number;
  /** Séquence déjà durable au chargement (point de sauvegarde + journal relu). */
  durableSeq?: number;
  /** Message `motion` relayé, jeté (débit) ou invalide : mesures du serveur. */
  onMotion?(outcome: MotionOutcome): void;
}

export interface JoinRequest {
  epoch: string | null;
  lastSeq: number | null;
  /** Telle qu'envoyée par le client (`hello`) : nettoyée par la salle. */
  presence?: unknown;
}

const DEFAULT_CATCH_UP_LIMIT = 2_000;
const DEFAULT_CATCH_UP_BUDGET_BYTES = 256 * 1024;
const MAX_PRESENCE_CHARS = 2_048;
const MAX_NAME_CHARS = 80;
const VOLATILE: SendOptions = { volatile: true };

interface Member {
  peer: RoomPeer;
  presence: PresenceState;
  /** Dernier état `motion` (caméra, pointeur, graphique), donné aux arrivants. */
  motion: MotionState | null;
  motionBucket: MotionBucket;
}

export class Room {
  readonly state: RoomState;
  readonly epoch: string;
  private readonly options: RoomOptions;
  private readonly members = new Map<string, Member>();
  private readonly leases = new LeaseTable();
  private readonly recent: SequencedBatch[] = [];
  /** Taille estimée de chaque lot de `recent`, dans le même ordre. */
  private readonly recentBytes: number[] = [];
  private recentTotalBytes = 0;
  private catchUpBudget: number;
  private durable: number;
  private peersDirty = false;
  /** Dernier numéro de Spotlight donné (le plus récent l'emporte chez les clients). */
  private lastSpotlight = 0;

  constructor(state: RoomState, options: RoomOptions) {
    this.state = state;
    this.epoch = options.epoch;
    this.options = options;
    this.durable = options.durableSeq ?? state.seq;
    this.catchUpBudget = options.catchUpBudgetBytes ?? DEFAULT_CATCH_UP_BUDGET_BYTES;
  }

  /** Budget du rattrapage par lots (le serveur le règle sur la taille du document). */
  setCatchUpBudget(bytes: number): void {
    this.catchUpBudget = bytes;
    this.trimRecent();
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

  /**
   * Ce client peut-il entrer sous ce `clientId` ? Non s'il appartient à un
   * autre utilisateur (lots déjà écrits sous cet id, ou connexion en cours) :
   * il éjecterait son titulaire et ferait passer ses lots pour des doublons.
   */
  canJoin(peer: RoomPeer): boolean {
    const owner = this.state.clientOwner(peer.clientId);
    if (owner !== undefined && owner !== peer.userId) return false;
    const current = this.members.get(peer.clientId);
    return !current || current.peer.userId === peer.userId;
  }

  /** Arrivée d'un client authentifié (le serveur a vérifié son jeton et ses droits, et `canJoin`). */
  join(peer: RoomPeer, request: JoinRequest): void {
    // Même client sur une nouvelle connexion : l'ancienne est remplacée.
    const previous = this.members.get(peer.clientId);
    if (previous && previous.peer !== peer) this.leave(peer.clientId);
    const motions = this.motionList(peer.clientId);
    const member: Member = { peer, presence: {}, motion: null, motionBucket: new MotionBucket() };
    member.presence = this.sanitizePresence(request.presence, member);
    this.members.set(peer.clientId, member);
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
      ...(motions.length > 0 ? { motions } : {}),
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

  /** Message d'un client ; avec `peer`, seulement s'il vient de sa connexion courante (jamais d'une remplacée). */
  handle(clientId: string, message: ClientMessage, peer?: RoomPeer): void {
    const member = this.members.get(clientId);
    if (!member || (peer && member.peer !== peer)) return;
    switch (message.type) {
      case 'batch':
        this.handleBatch(member.peer, message);
        return;
      case 'lease':
        this.handleLease(member.peer, message);
        return;
      case 'presence':
        member.presence = this.sanitizePresence(message.presence, member);
        this.peersDirty = true;
        return;
      case 'motion':
        this.handleMotion(member, message);
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
    const bytes = estimateBatchChars(batch.ops, batch.blobs);
    this.recent.push(batch);
    this.recentBytes.push(bytes);
    this.recentTotalBytes += bytes;
    this.trimRecent();
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

  /** Plus vieux lots retirés au-delà du nombre ou de la taille permis (une reconnexion plus ancienne reçoit l'état complet). */
  private trimRecent(): void {
    const limit = this.options.catchUpLimit ?? DEFAULT_CATCH_UP_LIMIT;
    let drop = 0;
    let total = this.recentTotalBytes;
    while (drop < this.recent.length && (this.recent.length - drop > limit || total > this.catchUpBudget)) {
      total -= this.recentBytes[drop];
      drop += 1;
    }
    if (drop === 0) return;
    this.recent.splice(0, drop);
    this.recentBytes.splice(0, drop);
    this.recentTotalBytes = total;
  }

  /**
   * Caméra, pointeur, survol du graphique : relayé tout de suite aux autres
   * (pas de regroupement au tick : chaque milliseconde compte pour suivre),
   * jamais à l'émetteur, jamais journalisé. Au-delà du débit permis, jeté.
   */
  private handleMotion(member: Member, message: unknown): void {
    if (!member.motionBucket.take(this.options.now())) {
      this.options.onMotion?.('rate-limited');
      return;
    }
    const motion = sanitizeMotion(message);
    if (!motion) {
      this.options.onMotion?.('invalid');
      return;
    }
    const { clientId } = member.peer;
    member.motion = mergeMotion(member.motion, clientId, motion);
    const relayed: ServerMessage = { type: 'motion', from: clientId, ...motion };
    for (const other of this.members.values()) {
      if (other !== member) other.peer.send(relayed, VOLATILE);
    }
    this.options.onMotion?.('relayed');
  }

  private motionList(exceptClientId: string): MotionState[] {
    const motions: MotionState[] = [];
    for (const [clientId, { motion }] of this.members) {
      if (motion && clientId !== exceptClientId) motions.push(motion);
    }
    return motions;
  }

  /**
   * Présence envoyée par un client (n'importe quoi) → champs connus, bornés ;
   * le nom est celui vérifié par le serveur quand il est connu.
   * Spotlight : `true` reçoit un numéro (gardé tant qu'il reste allumé) ; un
   * numéro déjà donné (reconnexion du présentateur, même après un
   * redémarrage) est repris s'il n'est pas dans le futur.
   */
  private sanitizePresence(presence: unknown, member: Member): PresenceState {
    const previous = member.presence.spotlight ?? null;
    const out = sanitizePresenceFields(presence);
    if (member.peer.name) out.name = member.peer.name.slice(0, MAX_NAME_CHARS);
    const source = presence !== null && typeof presence === 'object' ? presence as Record<string, unknown> : {};
    const resumed = source.spotlight;
    if (typeof resumed === 'number' && Number.isSafeInteger(resumed) && resumed > 0 && resumed <= this.options.now()) {
      out.spotlight = previous ?? resumed;
    } else if (source.spotlight === true || typeof resumed === 'number') {
      out.spotlight = previous ?? this.nextSpotlight();
    } else if (source.spotlight === false || source.spotlight === null) {
      out.spotlight = null;
    } else if (previous) {
      // Champ absent : le Spotlight en cours reste allumé.
      out.spotlight = previous;
    }
    return JSON.stringify(out).length > MAX_PRESENCE_CHARS ? {} : out;
  }

  /**
   * Numéro de Spotlight : instant de la salle (ms), strictement croissant —
   * jamais celui d'une présentation d'avant un redémarrage (déjà proposée,
   * peut-être déclinée, chez les clients).
   */
  private nextSpotlight(): number {
    this.lastSpotlight = Math.max(this.lastSpotlight + 1, Math.floor(this.options.now()));
    return this.lastSpotlight;
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

/** Ids de client acceptés (mêmes règles que le serveur : server/multiplayer/connection.ts). */
const CLIENT_ID_PATTERN = /^[A-Za-z0-9_-]{1,128}$/;

/** Champs de présence sans état de la salle (le Spotlight est numéroté par `Room`). */
function sanitizePresenceFields(presence: unknown): PresenceState {
  if (presence === null || typeof presence !== 'object') return {};
  const source = presence as Record<string, unknown>;
  const out: PresenceState = {};
  if (typeof source.name === 'string') out.name = source.name.slice(0, MAX_NAME_CHARS);
  if (typeof source.color === 'string' && /^#[0-9a-f]{6}$/i.test(source.color)) out.color = source.color;
  if (typeof source.activeItineraryId === 'string' || source.activeItineraryId === null) {
    out.activeItineraryId = typeof source.activeItineraryId === 'string' ? source.activeItineraryId.slice(0, 200) : null;
  }
  if (typeof source.activeMode === 'string' || source.activeMode === null) {
    out.activeMode = typeof source.activeMode === 'string' ? source.activeMode.slice(0, 40) : null;
  }
  if (source.following === null || (typeof source.following === 'string' && CLIENT_ID_PATTERN.test(source.following))) {
    out.following = source.following as string | null;
  }
  return out;
}
