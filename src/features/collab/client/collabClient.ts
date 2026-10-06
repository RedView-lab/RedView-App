import type {
  CollabChangeCause,
  CollabLocalChange,
  PreSessionChange,
  ProjectCollabLink,
} from '@/features/itineraryPanel/context/ProjectStore/collab';
import type { ProjectDocument } from '@/features/itineraryPanel/lib/project/layers';

import { diffDocument, storeFromDocument } from '../model/diff';
import { Materializer } from '../model/materialize';
import { applyOps, type Op } from '../model/ops';
import type { ClientMessage, LeaseInfo, MotionFields, PeerInfo, PresenceUpdate, ServerMessage } from '../protocol';
import type { MotionEvent } from '../realtime';
import { BROWSER_CLOCK, LeaseGate, type GateClock } from './leaseGate';
import { SyncEngine, type Rejection } from './syncEngine';
import { UndoHistory } from './undoHistory';

/**
 * Client de co-édition, sans réseau : la connexion WebSocket (connection.ts)
 * et le simulateur de tests branchent leur transport. Implémente le contrat du
 * ProjectStore (`ProjectCollabLink`) :
 *  - branchement (`bind`) dès la création de la session : le document
 *    affiché devient l'état provisoire, les écritures faites depuis sont
 *    rejouées ; tout ce que l'utilisateur modifie pendant la connexion part
 *    avec ses lots, rejoués sur l'état du serveur au premier `welcome` ;
 *  - document local poussé → différence avec l'état visible → opérations
 *    appliquées tout de suite, envoyées par lots ;
 *  - lots distants → état visible reconstruit → document rematérialisé
 *    (seuls les objets changés sont reconstruits ; le reste garde les
 *    références de l'application) ;
 *  - annuler / rétablir par éditeur (undoHistory.ts) ;
 *  - porte des calculs dérivés par baux (leaseGate.ts).
 */

export interface CollabTransport {
  /** Connexion ouverte et `welcome` reçu dessus. */
  isOnline(): boolean;
  send(message: ClientMessage): void;
  /** Envoi des lots en attente bientôt (regroupement ≈ 30 Hz). */
  requestFlush(): void;
  /** État incohérent : se reconnecter pour repartir d'un état sûr. */
  resync(): void;
}

export type CollabStatus = 'connecting' | 'online' | 'offline' | 'denied';

/** Refus définitif du serveur : accès retiré, projet supprimé, version, session expirée. */
export type CollabDeniedReason = 'forbidden' | 'not-found' | 'version' | 'unauthorized';

export interface CollabState {
  status: CollabStatus;
  /** Premier état reçu : le document de la session est connu. */
  ready: boolean;
  peers: PeerInfo[];
  leases: LeaseInfo[];
  /** Modifications locales pas encore acquittées. */
  unsynced: number;
  /** Raison d'un refus d'accès (`denied`). */
  deniedReason?: CollabDeniedReason;
  /** Ce client et son utilisateur tels que la salle les connaît (dès le premier `welcome`). */
  self: { clientId: string; userId: string } | null;
}

export interface CollabClientOptions {
  clientId: string;
  transport: CollabTransport;
  clock?: GateClock;
  onRejection?(rejection: Rejection): void;
  /** Store branché : la connexion peut s'ouvrir (son état provisoire est connu). */
  onBind?(): void;
  /** Les lots que le serveur n'a peut-être pas écrits ont pu changer (copie sur l'appareil). */
  onUnsyncedChange?(): void;
}

type DocumentListener = (document: ProjectDocument, cause: CollabChangeCause) => void;

export class CollabClient implements ProjectCollabLink {
  readonly clientId: string;
  readonly engine: SyncEngine;
  readonly computeGate: LeaseGate;
  private readonly transport: CollabTransport;
  private readonly clock: GateClock;
  private readonly options: CollabClientOptions;
  private readonly materializer = new Materializer();
  private readonly history = new UndoHistory();
  private document: ProjectDocument | null = null;
  private bound = false;
  private readonly documentListeners = new Set<DocumentListener>();
  private readonly historyListeners = new Set<() => void>();
  private readonly stateListeners = new Set<() => void>();
  private readonly motionListeners = new Set<(event: MotionEvent) => void>();
  private state: CollabState = { status: 'connecting', ready: false, peers: [], leases: [], unsynced: 0, self: null };

  constructor(options: CollabClientOptions) {
    this.clientId = options.clientId;
    this.options = options;
    this.transport = options.transport;
    this.clock = options.clock ?? BROWSER_CLOCK;
    this.engine = new SyncEngine(options.clientId);
    this.computeGate = new LeaseGate(options.clientId, {
      isOnline: () => this.transport.isOnline(),
      // Un message de bail part après les lots en attente : la libération suit
      // toujours le résultat écrit, jamais l'inverse.
      send: (message) => {
        this.flush();
        this.transport.send(message);
      },
    }, this.clock);
  }

  // ── ProjectCollabLink ─────────────────────────────────────────────────────

  bind(base: ProjectDocument, changes: readonly PreSessionChange[]): ProjectDocument {
    if (this.bound) return this.getDocument();
    this.bound = true;
    if (!this.engine.isReady) {
      const seed = storeFromDocument(base);
      this.engine.seedProvisional(seed);
      // Ce qui n'a pas changé garde les objets de l'application.
      this.materializer.adopt(seed, base);
      this.document = this.materializer.materialize(this.engine.visible);
    }
    if (changes.length > 0) this.replay(base, changes);
    this.options.onBind?.();
    return this.getDocument();
  }

  getDocument(): ProjectDocument {
    if (!this.document) throw new Error('CollabClient: store pas encore branché');
    return this.document;
  }

  pushLocalDocument(next: ProjectDocument, change: CollabLocalChange): void {
    const current = this.document;
    if (!current || next === current) return;
    const { ops, blobs } = diffDocument(this.engine.visible, current, next);
    this.document = next;
    const sendable = this.isSendable(change);
    const { applied, inverse } = ops.length > 0
      ? this.engine.applyLocal(ops, blobs, { sendable })
      : { applied: [], inverse: [] };
    this.materializer.adopt(this.engine.visible, next);
    if (applied.length === 0) return;
    if (sendable) this.history.record(change, applied, inverse, this.clock.now());
    this.afterLocalChange();
  }

  subscribe(listener: DocumentListener): () => void {
    this.documentListeners.add(listener);
    return () => {
      this.documentListeners.delete(listener);
    };
  }

  undo(): void {
    this.applyHistory('undo');
  }

  redo(): void {
    this.applyHistory('redo');
  }

  canUndo(): boolean {
    return this.history.canUndo;
  }

  canRedo(): boolean {
    return this.history.canRedo;
  }

  subscribeHistory(listener: () => void): () => void {
    this.historyListeners.add(listener);
    return () => {
      this.historyListeners.delete(listener);
    };
  }

  // ── Transport ─────────────────────────────────────────────────────────────

  /** `hello` : reprise depuis l'état confirmé. */
  helloFields(): { clientId: string; epoch: string | null; lastSeq: number | null } {
    return { clientId: this.clientId, ...this.engine.resumePoint() };
  }

  /** Envoie les lots en attente (appelé par le transport). */
  flush(): void {
    if (!this.transport.isOnline()) {
      this.engine.seal();
      return;
    }
    for (const message of this.engine.outgoing()) this.transport.send(message);
  }

  /**
   * Connexion perdue (ou nouvelle tentative). La connexion n'est « en ligne »
   * qu'une fois `welcome` reçu (`transport.isOnline()`), qui la rétablit.
   */
  disconnected(retrying: boolean): void {
    this.engine.disconnected();
    this.computeGate.connectionChanged(false);
    // Un refus reste affiché : la fermeture qui le suit ne le remplace pas.
    const status = this.state.status === 'denied'
      ? 'denied'
      : retrying && !this.engine.isReady ? 'connecting' : 'offline';
    this.updateState({ status, peers: [], leases: [] });
  }

  denied(reason: CollabDeniedReason): void {
    this.updateState({ status: 'denied', deniedReason: reason, peers: [], leases: [] });
  }

  receive(message: ServerMessage): void {
    switch (message.type) {
      case 'welcome': {
        this.engine.receive(message);
        this.computeGate.connectionChanged(true);
        this.computeGate.setLeases(message.leases);
        // Premier état : il remplace le document provisoire (les modifications
        // faites pendant la connexion sont rejouées par-dessus).
        this.emitRemote();
        const self = this.state.self?.clientId === message.clientId && this.state.self.userId === message.userId
          ? this.state.self
          : { clientId: message.clientId, userId: message.userId };
        this.updateState({ status: 'online', ready: true, peers: message.peers, leases: message.leases, self });
        this.flush();
        this.options.onUnsyncedChange?.();
        for (const { clientId, t, ...fields } of message.motions ?? []) {
          this.emitMotion({ from: clientId, t, fields, snapshot: true });
        }
        break;
      }
      case 'motion': {
        // Jusqu'à 30 Hz par éditeur : aucun état de session (ni rendu React) touché.
        const { from, t, type: _type, ...fields } = message;
        this.emitMotion({ from, t, fields, snapshot: false });
        return;
      }
      case 'batch':
      case 'durable':
      case 'duplicate':
      case 'reject': {
        const outcome = this.engine.receive(message);
        for (const rejection of this.engine.takeRejections()) this.options.onRejection?.(rejection);
        if (outcome === 'resync') {
          this.transport.resync();
          return;
        }
        if (outcome === 'changed') this.emitRemote();
        if (message.type !== 'batch' || message.batch.clientId === this.clientId) this.options.onUnsyncedChange?.();
        break;
      }
      case 'leases':
        this.computeGate.setLeases(message.leases);
        this.updateState({ leases: message.leases });
        break;
      case 'lease-denied':
        this.computeGate.denied(message.kind, message.itineraryId, message.retryAfterMs);
        break;
      case 'peers':
        this.updateState({ peers: message.peers });
        break;
      default:
        break;
    }
    this.updateState({ unsynced: this.engine.unsyncedCount });
  }

  setPresence(presence: PresenceUpdate): void {
    if (this.transport.isOnline() && this.engine.isReady) this.transport.send({ type: 'presence', presence });
  }

  /** Caméra, pointeur, survol du graphique (éphémère) : envoyé seulement en ligne. */
  sendMotion(t: number, fields: MotionFields): boolean {
    if (!this.transport.isOnline() || !this.engine.isReady) return false;
    this.transport.send({ type: 'motion', t, ...fields });
    return true;
  }

  /** Messages `motion` des autres éditeurs (et leur dernier état à chaque `welcome`). */
  subscribeMotion(listener: (event: MotionEvent) => void): () => void {
    this.motionListeners.add(listener);
    return () => {
      this.motionListeners.delete(listener);
    };
  }

  // ── État de la session (interface) ────────────────────────────────────────

  getState(): CollabState {
    return this.state;
  }

  subscribeState(listener: () => void): () => void {
    this.stateListeners.add(listener);
    return () => {
      this.stateListeners.delete(listener);
    };
  }

  dispose(): void {
    this.computeGate.dispose();
    this.documentListeners.clear();
    this.historyListeners.clear();
    this.stateListeners.clear();
    this.motionListeners.clear();
  }

  // ── Interne ───────────────────────────────────────────────────────────────

  /**
   * Avant le premier état du serveur, un résultat calculé (tracé, altimétrie…)
   * l'a été sur le document d'ouverture, peut-être en retard : il reste local.
   * Un commentaire part toujours (c'est une action de l'utilisateur).
   */
  private isSendable(change: CollabLocalChange): boolean {
    return this.engine.isReady || change !== 'background';
  }

  /**
   * Écritures faites avant le branchement, rejouées comme des modifications
   * locales : chacune est la différence avec la précédente (calculée sur un
   * magasin qui suit les documents du store), appliquée sur l'état visible
   * (provisoire, ou déjà celui du serveur).
   */
  private replay(base: ProjectDocument, changes: readonly PreSessionChange[]): void {
    const shadow = storeFromDocument(base, { blobs: false });
    const now = this.clock.now();
    let previous = base;
    let appliedAny = false;
    for (const { document, change } of changes) {
      const { ops, blobs } = diffDocument(shadow, previous, document);
      applyOps(shadow, ops);
      previous = document;
      if (ops.length === 0) continue;
      const sendable = this.isSendable(change);
      const { applied, inverse } = this.engine.applyLocal(ops, blobs, { sendable });
      if (applied.length === 0) continue;
      appliedAny = true;
      if (sendable) this.history.record(change, applied, inverse, now);
    }
    this.document = this.materializer.materialize(this.engine.visible);
    if (appliedAny) this.afterLocalChange();
  }

  private afterLocalChange(): void {
    this.transport.requestFlush();
    this.notifyHistory();
    this.updateState({ unsynced: this.engine.unsyncedCount });
    this.options.onUnsyncedChange?.();
  }

  private applyHistory(cause: 'undo' | 'redo'): void {
    if (!this.document) return;
    const apply = (ops: Op[]) => this.engine.applyLocal(ops, new Map());
    const now = this.clock.now();
    const done = cause === 'undo'
      ? this.history.undo(this.engine.visible, apply, now)
      : this.history.redo(this.engine.visible, apply, now);
    if (!done) return;
    const document = this.materializer.materialize(this.engine.visible);
    this.document = document;
    for (const listener of [...this.documentListeners]) listener(document, cause);
    this.afterLocalChange();
  }

  private emitRemote(): void {
    const document = this.materializer.materialize(this.engine.visible);
    if (document === this.document) return;
    this.document = document;
    for (const listener of [...this.documentListeners]) listener(document, 'remote');
  }

  private notifyHistory(): void {
    for (const listener of [...this.historyListeners]) listener();
  }

  private emitMotion(event: MotionEvent): void {
    for (const listener of [...this.motionListeners]) listener(event);
  }

  private updateState(patch: Partial<CollabState>): void {
    const next = { ...this.state, ...patch };
    const changed = (Object.keys(patch) as Array<keyof CollabState>).some((key) => next[key] !== this.state[key]);
    if (!changed) return;
    this.state = next;
    for (const listener of [...this.stateListeners]) listener();
  }
}
