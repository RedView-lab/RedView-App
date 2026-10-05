import { randomUUID } from 'node:crypto';

import type { ProjectDocument } from '../../src/features/itineraryPanel/lib/project/layers.ts';
import { referencedRouteBlobs } from '../../src/features/collab/model/diff.ts';
import { deserializeStore, type ClientMessage, type SequencedBatch } from '../../src/features/collab/protocol.ts';
import { Room, type JoinRequest, type RoomPeer } from '../../src/features/collab/room/room.ts';
import { RoomState } from '../../src/features/collab/room/roomState.ts';
import { CheckpointSerializer } from './serialize.ts';
import type { LoadedRoom, RoomStorage } from './storage.ts';

/**
 * Salles chargées en mémoire (une par projet ouvert en co-édition) et leur
 * durabilité :
 *  - journal écrit par paquets toutes les `journalFlushMs` (≈ 250 ms ; les
 *    clients gardent leurs lots tant qu'ils ne sont pas durables) ;
 *  - point de sauvegarde toutes les `checkpointIntervalMs` ou
 *    `checkpointBatches` lots, et au déchargement de la salle ;
 *  - toutes les écritures d'une salle passent par une seule file (jamais un
 *    élagage du journal pendant un ajout) ;
 *  - barrière : un paquet de journal refusé (`conflict`) veut dire qu'un
 *    autre serveur tient la salle — celle-ci est fermée sans rien écrire et
 *    ses clients se reconnectent (leurs lots non durables sont renvoyés).
 */

export interface RoomHostOptions {
  storage: RoomStorage;
  journalFlushMs?: number;
  checkpointIntervalMs?: number;
  checkpointBatches?: number;
  idleUnloadMs?: number;
  log?: (level: 'info' | 'warn' | 'error', message: string, data?: Record<string, unknown>) => void;
}

/** Connexion d'un client, vue par l'hôte (fermeture avec un code WebSocket). */
export interface PeerHandle {
  peer: RoomPeer;
  close(code: number, reason: string): void;
}

/** Code de fermeture « service redémarré » : le client se reconnecte sans attendre longtemps. */
export const CLOSE_RESTART = 1012;
const TICK_MS = 100;
const MAINTENANCE_MS = 1_000;
/** Journal en échec plus longtemps : la salle est fermée (les clients gardent leurs lots). */
const MAX_JOURNAL_OUTAGE_MS = 60_000;
const LATENCY_SAMPLES = 1_000;

export class HostedRoom {
  readonly projectId: string;
  readonly room: Room;
  readonly peers = new Set<PeerHandle>();
  private readonly host: RoomHost;
  private readonly serializer = new CheckpointSerializer();
  private unflushed: SequencedBatch[] = [];
  private readonly acceptedAt = new Map<number, number>();
  private queue: Promise<void> = Promise.resolve();
  private journaledSeq: number;
  private checkpointSeq: number;
  private lastCheckpointAt = Date.now();
  private flushFailingSince: number | null = null;
  private maintenanceQueued = false;
  private readonly timers: NodeJS.Timeout[] = [];
  idleSince: number | null = Date.now();
  closing = false;
  closed = false;

  constructor(host: RoomHost, projectId: string, loaded: LoadedRoom) {
    this.host = host;
    this.projectId = projectId;
    const state = recoverRoomState(loaded);
    this.journaledSeq = state.seq;
    this.checkpointSeq = loaded.checkpoint && loaded.journal.length === 0 ? state.seq : -1;
    this.room = new Room(state, {
      epoch: randomUUID(),
      now: () => Date.now(),
      durableSeq: state.seq,
      onBatch: (batch) => {
        this.unflushed.push(batch);
        this.acceptedAt.set(batch.seq, Date.now());
        host.metrics.batches += 1;
      },
    });
    const options = host.options;
    this.timers.push(
      setInterval(() => this.room.tick(), TICK_MS),
      setInterval(() => this.flush(), options.journalFlushMs ?? 250),
      setInterval(() => this.maintain(), MAINTENANCE_MS),
    );
  }

  attach(handle: PeerHandle, request: JoinRequest): void {
    this.peers.add(handle);
    this.idleSince = null;
    this.room.join(handle.peer, request);
  }

  detach(handle: PeerHandle): void {
    if (!this.peers.delete(handle)) return;
    this.room.leave(handle.peer.clientId, handle.peer);
    if (this.peers.size === 0) this.idleSince = Date.now();
  }

  handle(handle: PeerHandle, message: ClientMessage): void {
    if (this.closed || !this.peers.has(handle)) return;
    // Arrêt en cours : les lots ne sont plus acceptés (non acquittés, le
    // client les renverra au serveur suivant).
    if (this.closing && message.type !== 'ping') return;
    this.room.handle(handle.peer.clientId, message);
  }

  /** Écrit le journal, puis ferme les connexions (arrêt du serveur). */
  async shutdown(): Promise<void> {
    this.closing = true;
    await this.enqueue(() => this.writeJournal());
    this.close(CLOSE_RESTART, 'shutdown');
  }

  private flush(): void {
    if (this.unflushed.length === 0 || this.closed) return;
    void this.enqueue(() => this.writeJournal());
  }

  private async writeJournal(): Promise<void> {
    if (this.unflushed.length === 0 || this.closed) return;
    const batches = this.unflushed.slice();
    try {
      const result = await this.host.options.storage.appendJournal(this.projectId, batches);
      if (result === 'conflict') {
        this.host.metrics.fenced += 1;
        this.host.log('warn', 'journal déjà écrit par un autre serveur : salle fermée', { projectId: this.projectId, seq: batches[0].seq });
        this.close(CLOSE_RESTART, 'moved');
        return;
      }
      this.flushFailingSince = null;
      this.unflushed.splice(0, batches.length);
      const last = batches[batches.length - 1].seq;
      this.journaledSeq = last;
      const now = Date.now();
      for (const batch of batches) {
        const at = this.acceptedAt.get(batch.seq);
        this.acceptedAt.delete(batch.seq);
        if (at !== undefined) this.host.recordJournalLatency(now - at);
      }
      this.room.markDurable(last);
    } catch (error) {
      this.flushFailingSince ??= Date.now();
      this.host.metrics.journalErrors += 1;
      this.host.log('error', 'écriture du journal en échec', { projectId: this.projectId, error: String(error) });
      if (Date.now() - this.flushFailingSince > MAX_JOURNAL_OUTAGE_MS) this.close(CLOSE_RESTART, 'storage-unavailable');
    }
  }

  private maintain(): void {
    if (this.closed || this.closing) return;
    const options = this.host.options;
    const seq = this.room.state.seq;
    const due = seq > this.checkpointSeq && (
      seq - Math.max(0, this.checkpointSeq) >= (options.checkpointBatches ?? 600)
      || Date.now() - this.lastCheckpointAt >= (options.checkpointIntervalMs ?? 60_000)
    );
    const idle = this.idleSince !== null && Date.now() - this.idleSince >= (options.idleUnloadMs ?? 60_000);
    if ((!due && !idle) || this.maintenanceQueued) return;
    this.maintenanceQueued = true;
    void this.enqueue(() => this.checkpoint(idle)).finally(() => {
      this.maintenanceQueued = false;
    });
  }

  /**
   * Salle repartie du document (première session, ou document réécrit hors
   * session) : point de sauvegarde tout de suite, avant le premier lot — la
   * reprise après un arrêt ne dépend alors jamais d'un document qui pourrait
   * changer ensuite.
   */
  async initialCheckpoint(): Promise<void> {
    await this.enqueue(() => this.checkpoint(false));
    if (this.checkpointSeq < this.room.state.seq) throw new Error('premier point de sauvegarde impossible');
  }

  /** Point de sauvegarde à la séquence courante ; `unload` : puis décharge la salle si personne n'est revenu. */
  private async checkpoint(unload: boolean): Promise<void> {
    if (this.closed) return;
    const { state } = this.room;
    const seq = state.seq;
    if (seq > this.checkpointSeq) {
      const started = Date.now();
      // Sérialisé maintenant (état à `seq`), écrit après le journal jusqu'à `seq`.
      const checkpointJson = this.serializer.checkpoint(state);
      const document = state.document();
      const documentJson = this.serializer.document(document);
      await this.writeJournal();
      if (this.closed || this.journaledSeq < seq) return;
      try {
        await this.host.options.storage.saveCheckpoint(this.projectId, { seq, checkpointJson, document, documentJson });
        this.checkpointSeq = seq;
        this.lastCheckpointAt = Date.now();
        this.host.recordCheckpoint(Date.now() - started);
        await this.host.options.storage.pruneJournal(this.projectId, seq);
      } catch (error) {
        this.host.metrics.checkpointErrors += 1;
        this.host.log('error', 'point de sauvegarde en échec', { projectId: this.projectId, error: String(error) });
        return;
      }
    }
    if (unload && this.peers.size === 0 && this.unflushed.length === 0) this.close(1000, 'idle');
  }

  /** Chargement abandonné : minuteries arrêtées, rien d'écrit. */
  abort(): void {
    this.close(1011, 'load-failed');
  }

  private close(code: number, reason: string): void {
    if (this.closed) return;
    this.closed = true;
    for (const timer of this.timers) clearInterval(timer);
    for (const handle of [...this.peers]) handle.close(code, reason);
    this.peers.clear();
    this.host.forget(this);
  }

  private enqueue(task: () => Promise<void>): Promise<void> {
    const next = this.queue.then(task, task);
    this.queue = next.catch(() => undefined);
    return next;
  }
}

/** État de départ : point de sauvegarde exact + journal, sinon le document ; segments orphelins purgés. */
function recoverRoomState(loaded: LoadedRoom): RoomState {
  const state = loaded.checkpoint
    ? new RoomState(deserializeStore(loaded.checkpoint.snapshot), loaded.checkpoint.seq, loaded.checkpoint.clientSeqs)
    : RoomState.fromDocument(loaded.document, loaded.baseSeq);
  for (const batch of loaded.journal) state.replay(batch);
  // Nouvelle instance : les clients repartent de l'état complet, les anciens
  // segments de tracé ne servent plus (l'annuler d'un client les renvoie).
  state.store.pruneBlobs(referencedRouteBlobs(state.store));
  return state;
}

export class RoomHost {
  readonly options: RoomHostOptions;
  private readonly rooms = new Map<string, HostedRoom>();
  private readonly loading = new Map<string, Promise<HostedRoom | null>>();
  private readonly journalLatencies: number[] = [];
  private readonly checkpointDurations: number[] = [];
  private shuttingDown = false;
  readonly metrics = { batches: 0, fenced: 0, journalErrors: 0, checkpointErrors: 0, loads: 0, loadErrors: 0 };

  constructor(options: RoomHostOptions) {
    this.options = options;
  }

  log(level: 'info' | 'warn' | 'error', message: string, data?: Record<string, unknown>): void {
    (this.options.log ?? defaultLog)(level, message, data);
  }

  /** Salle du projet (chargée au besoin, un seul chargement à la fois) ; null : projet introuvable. */
  async open(projectId: string, seed?: ProjectDocument): Promise<HostedRoom | null> {
    if (this.shuttingDown) throw new Error('shutting-down');
    const existing = this.rooms.get(projectId);
    if (existing && !existing.closed) return existing;
    let pending = this.loading.get(projectId);
    if (!pending) {
      pending = (async () => {
        this.metrics.loads += 1;
        const loaded = await this.options.storage.loadRoom(projectId, seed);
        if (!loaded) return null;
        const hosted = new HostedRoom(this, projectId, loaded);
        if (!loaded.checkpoint) {
          try {
            await hosted.initialCheckpoint();
          } catch (error) {
            hosted.abort();
            throw error;
          }
        }
        this.rooms.set(projectId, hosted);
        this.log('info', 'salle chargée', { projectId, seq: hosted.room.state.seq, journal: loaded.journal.length });
        return hosted;
      })();
      this.loading.set(projectId, pending);
      pending.catch(() => {
        this.metrics.loadErrors += 1;
      }).finally(() => this.loading.delete(projectId));
    }
    return pending;
  }

  forget(hosted: HostedRoom): void {
    if (this.rooms.get(hosted.projectId) === hosted) this.rooms.delete(hosted.projectId);
  }

  async shutdown(): Promise<void> {
    this.shuttingDown = true;
    await Promise.allSettled([...this.rooms.values()].map((hosted) => hosted.shutdown()));
  }

  recordJournalLatency(ms: number): void {
    this.journalLatencies.push(ms);
    if (this.journalLatencies.length > LATENCY_SAMPLES) this.journalLatencies.shift();
  }

  recordCheckpoint(ms: number): void {
    this.checkpointDurations.push(ms);
    if (this.checkpointDurations.length > LATENCY_SAMPLES) this.checkpointDurations.shift();
  }

  snapshotMetrics(): Record<string, number> {
    let clients = 0;
    for (const hosted of this.rooms.values()) clients += hosted.peers.size;
    return {
      rooms: this.rooms.size,
      clients,
      ...this.metrics,
      journal_latency_p50_ms: percentile(this.journalLatencies, 0.5),
      journal_latency_p95_ms: percentile(this.journalLatencies, 0.95),
      checkpoint_p95_ms: percentile(this.checkpointDurations, 0.95),
    };
  }
}

function percentile(values: readonly number[], q: number): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.min(sorted.length - 1, Math.floor(q * sorted.length))];
}

function defaultLog(level: 'info' | 'warn' | 'error', message: string, data?: Record<string, unknown>): void {
  const line = JSON.stringify({ level, time: new Date().toISOString(), service: 'multiplayer', message, ...data });
  if (level === 'error') console.error(line);
  else if (level === 'warn') console.warn(line);
  else console.log(line);
}
