import type {
  CollabChangeCause,
  CollabLocalChange,
  ProjectCollabLink,
} from '@/features/itineraryPanel/context/ProjectStore/collab';
import type { ProjectDocument } from '@/features/itineraryPanel/lib/project/layers';

import { diffDocument } from '../model/diff';
import { Materializer } from '../model/materialize';
import type { Op } from '../model/ops';
import type { ClientMessage, LeaseInfo, PeerInfo, PresenceState, ServerMessage } from '../protocol';
import { BROWSER_CLOCK, LeaseGate, type GateClock } from './leaseGate';
import { SyncEngine, type Rejection } from './syncEngine';
import { UndoHistory } from './undoHistory';

/**
 * Client de co-édition, sans réseau : la connexion WebSocket (connection.ts)
 * et le simulateur de tests branchent leur transport. Implémente le contrat du
 * ProjectStore (`ProjectCollabLink`) :
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

export interface CollabState {
  status: CollabStatus;
  /** Premier état reçu : le document de la session est connu. */
  ready: boolean;
  peers: PeerInfo[];
  leases: LeaseInfo[];
  /** Modifications locales pas encore acquittées. */
  unsynced: number;
  /** Raison d'un refus d'accès (`denied`). */
  deniedReason?: string;
}

export interface CollabClientOptions {
  clientId: string;
  transport: CollabTransport;
  clock?: GateClock;
  onRejection?(rejection: Rejection): void;
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
  private readonly documentListeners = new Set<DocumentListener>();
  private readonly historyListeners = new Set<() => void>();
  private readonly stateListeners = new Set<() => void>();
  private state: CollabState = { status: 'connecting', ready: false, peers: [], leases: [], unsynced: 0 };

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

  getDocument(): ProjectDocument {
    if (!this.document) throw new Error('CollabClient: document pas encore reçu');
    return this.document;
  }

  pushLocalDocument(next: ProjectDocument, change: CollabLocalChange): void {
    const current = this.document;
    if (!current || next === current) return;
    const visible = this.engine.visible;
    const { ops, blobs } = diffDocument(visible, current, next);
    this.document = next;
    const { applied, inverse } = ops.length > 0 ? this.engine.applyLocal(ops, blobs) : { applied: [], inverse: [] };
    this.materializer.adopt(this.engine.visible, next);
    if (applied.length === 0) return;
    this.history.record(change, applied, inverse, this.clock.now());
    this.transport.requestFlush();
    this.notifyHistory();
    this.updateState({ unsynced: this.engine.unsyncedCount });
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
    this.updateState({ status: retrying && !this.engine.isReady ? 'connecting' : 'offline', peers: [], leases: [] });
  }

  denied(reason: string): void {
    this.updateState({ status: 'denied', deniedReason: reason });
  }

  receive(message: ServerMessage): void {
    switch (message.type) {
      case 'welcome': {
        const firstWelcome = !this.engine.isReady;
        this.engine.receive(message);
        this.computeGate.connectionChanged(true);
        this.computeGate.setLeases(message.leases);
        if (firstWelcome) {
          this.document = this.materializer.materialize(this.engine.visible);
        } else {
          this.emitRemote();
        }
        this.updateState({ status: 'online', ready: true, peers: message.peers, leases: message.leases });
        this.flush();
        break;
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

  setPresence(presence: PresenceState): void {
    if (this.transport.isOnline() && this.engine.isReady) this.transport.send({ type: 'presence', presence });
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
  }

  // ── Interne ───────────────────────────────────────────────────────────────

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
    this.transport.requestFlush();
    this.notifyHistory();
    this.updateState({ unsynced: this.engine.unsyncedCount });
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

  private updateState(patch: Partial<CollabState>): void {
    const next = { ...this.state, ...patch };
    const changed = (Object.keys(patch) as Array<keyof CollabState>).some((key) => next[key] !== this.state[key]);
    if (!changed) return;
    this.state = next;
    for (const listener of [...this.stateListeners]) listener();
  }
}
