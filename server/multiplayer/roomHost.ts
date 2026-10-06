import { randomUUID } from 'node:crypto';
import { monitorEventLoopDelay } from 'node:perf_hooks';
import { getHeapStatistics } from 'node:v8';

import type { ProjectDocument } from '../../src/features/itineraryPanel/lib/project/layers.ts';
import { referencedRouteBlobs } from '../../src/features/collab/model/diff.ts';
import { materializeJson } from '../../src/features/collab/model/materialize.ts';
import { deserializeCheckedStore, type ClientMessage, type SequencedBatch } from '../../src/features/collab/protocol.ts';
import { Room, type JoinRequest, type RoomPeer } from '../../src/features/collab/room/room.ts';
import { RoomState } from '../../src/features/collab/room/roomState.ts';
import { CheckpointSerializer } from './serialize.ts';
import { storeDigest, verifyDurable, type ShadowResult } from './shadow.ts';
import { ProjectNotFoundError, type LoadedRoom, type RoomStorage } from './storage.ts';

/**
 * Salles chargées en mémoire (une par projet ouvert en co-édition) et leur
 * durabilité :
 *  - journal écrit par paquets toutes les `journalFlushMs` (≈ 250 ms ; les
 *    clients gardent leurs lots tant qu'ils ne sont pas durables) ; en échec,
 *    nouvel essai avec attente exponentielle ;
 *  - point de sauvegarde toutes les `checkpointIntervalMs` ou
 *    `checkpointBatches` lots, et au déchargement de la salle ; en échec,
 *    attente exponentielle (1 s → 60 s) ;
 *  - une salle sans client est déchargée dès que son journal est écrit, même
 *    si le point de sauvegarde échoue : la reprise se fait par le dernier
 *    point de sauvegarde + le journal ;
 *  - projet supprimé (introuvable au point de sauvegarde ou à la
 *    revérification des droits) : clients fermés en 4404, journal et points
 *    de sauvegarde purgés, salle oubliée, plus aucun essai ;
 *  - toutes les écritures d'une salle passent par une seule file (jamais un
 *    élagage du journal pendant un ajout) ;
 *  - barrière : un paquet de journal refusé (`conflict`) veut dire qu'un
 *    autre serveur tient la salle — celle-ci est fermée sans rien écrire et
 *    ses clients se reconnectent (leurs lots non durables sont renvoyés) ;
 *  - validation fantôme (shadow.ts) au plus une fois par
 *    `shadowValidationIntervalMs` et par salle ;
 *  - une exception pendant le traitement d'un message ou l'entretien d'une
 *    salle ne touche qu'elle : salle fermée (1011) puis rechargée de son état
 *    durable à la reconnexion de ses clients (qui renvoient leurs lots non
 *    durables) — jamais le processus, qui tient toutes les autres salles.
 */

export interface RoomHostOptions {
  storage: RoomStorage;
  journalFlushMs?: number;
  checkpointIntervalMs?: number;
  checkpointBatches?: number;
  idleUnloadMs?: number;
  /** Validation fantôme d'une salle au plus une fois par période (0 : jamais). */
  shadowValidationIntervalMs?: number;
  log?: (level: 'info' | 'warn' | 'error', message: string, data?: Record<string, unknown>) => void;
}

/** Connexion d'un client, vue par l'hôte (fermeture avec un code WebSocket). */
export interface PeerHandle {
  peer: RoomPeer;
  close(code: number, reason: string): void;
}

/** Code de fermeture « service redémarré » : le client se reconnecte sans attendre longtemps. */
export const CLOSE_RESTART = 1012;
/** Code de fermeture « projet introuvable » : refus définitif côté client. */
const CLOSE_NOT_FOUND = 4404;
/** Connexion remplacée par une nouvelle du même client (réseau changé, l'ancienne pas encore tombée). */
const CLOSE_REPLACED = 4409;
const TICK_MS = 100;
const MAINTENANCE_MS = 1_000;
/** Journal en échec plus longtemps avec des clients connectés : la salle est fermée (ils gardent leurs lots). */
const MAX_JOURNAL_OUTAGE_MS = 60_000;
const JOURNAL_RETRY_MAX_MS = 30_000;
const CHECKPOINT_RETRY_MIN_MS = 1_000;
const CHECKPOINT_RETRY_MAX_MS = 60_000;
const DEFAULT_SHADOW_INTERVAL_MS = 10 * 60_000;
const MIN_CATCH_UP_BYTES = 64 * 1024;
/** Au-delà de cette part du tas, aucune nouvelle salle n'est chargée (1013, le client réessaie). */
const ROOM_LOAD_HEAP_RATIO = 0.7;
const LATENCY_SAMPLES = 1_000;

const backoff = (failures: number, minMs: number, maxMs: number) => Math.min(maxMs, minMs * 2 ** Math.max(0, failures - 1));

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
  /** Un point de sauvegarde de cette salle existe dans le stockage (validation fantôme possible). */
  private hasDurableCheckpoint: boolean;
  private lastCheckpointAt = Date.now();
  private checkpointFailures = 0;
  private nextCheckpointAt = 0;
  private journalQueued = false;
  private journalFailures = 0;
  private nextJournalAt = 0;
  private flushFailingSince: number | null = null;
  private lastShadowAt = 0;
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
    this.hasDurableCheckpoint = loaded.checkpoint !== null;
    this.room = new Room(state, {
      epoch: randomUUID(),
      now: () => Date.now(),
      durableSeq: state.seq,
      onBatch: (batch) => {
        this.unflushed.push(batch);
        this.acceptedAt.set(batch.seq, Date.now());
        host.metrics.batches += 1;
      },
      onMotion: (outcome) => {
        if (outcome === 'relayed') host.metrics.motionIn += 1;
        else if (outcome === 'rate-limited') host.metrics.motionDroppedRate += 1;
        else host.metrics.motionInvalid += 1;
      },
    });
    const options = host.options;
    this.timers.push(
      setInterval(() => this.room.tick(), TICK_MS),
      setInterval(() => this.flush(), options.journalFlushMs ?? 250),
      setInterval(() => this.maintain(), MAINTENANCE_MS),
    );
  }

  /**
   * Entrée d'une connexion authentifiée ; false si son `clientId` appartient
   * à un autre utilisateur (Room.canJoin) : la connexion est alors refusée.
   */
  attach(handle: PeerHandle, request: JoinRequest): boolean {
    if (!this.room.canJoin(handle.peer)) return false;
    // Même client sur une nouvelle connexion : l'ancienne (morte sans fermeture,
    // ou onglet qui s'est reconnecté avant qu'elle tombe) est fermée tout de
    // suite plutôt que d'attendre le battement de cœur (pastille et curseur
    // fantômes, messages tardifs pris pour ceux de la nouvelle).
    for (const other of [...this.peers]) {
      if (other === handle || other.peer.clientId !== handle.peer.clientId) continue;
      this.host.metrics.connectionsReplaced += 1;
      other.close(CLOSE_REPLACED, 'replaced');
    }
    this.peers.add(handle);
    this.idleSince = null;
    this.room.join(handle.peer, request);
    return true;
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
    try {
      this.room.handle(handle.peer.clientId, message, handle.peer);
    } catch (error) {
      this.fail('traitement d’un message', error, { userId: handle.peer.userId, type: String((message as { type?: unknown }).type) });
    }
  }

  /**
   * Exception dans la salle (état peut-être à moitié modifié) : fermée sans
   * rien écrire de plus (1011), rechargée de son état durable à la reconnexion.
   */
  fail(stage: string, error: unknown, data: Record<string, unknown> = {}): void {
    if (this.closed) return;
    this.host.metrics.roomFailures += 1;
    this.host.log('error', `salle fermée après une erreur (${stage})`, { projectId: this.projectId, error: String(error), ...data });
    this.close(1011, 'internal');
  }

  /** Écrit le journal, puis ferme les connexions (arrêt du serveur). */
  async shutdown(): Promise<void> {
    this.closing = true;
    await this.enqueue(() => this.writeJournal());
    this.close(CLOSE_RESTART, 'shutdown');
  }

  /**
   * Projet supprimé : définitif. Clients fermés en 4404 (« projet
   * introuvable »), journal et points de sauvegarde purgés après les
   * écritures en cours, salle oubliée.
   */
  projectDeleted(detectedBy: string): void {
    if (this.closed) return;
    this.host.metrics.deletedRooms += 1;
    this.host.log('warn', 'projet supprimé : salle fermée, données de co-édition purgées', { projectId: this.projectId, detectedBy });
    this.close(CLOSE_NOT_FOUND, 'not-found');
    void this.enqueue(async () => {
      try {
        await this.host.options.storage.purgeRoom(this.projectId);
      } catch (error) {
        this.host.log('warn', 'purge du projet supprimé incomplète', { projectId: this.projectId, error: String(error) });
      }
    });
  }

  private flush(): void {
    if (this.unflushed.length === 0 || this.closed || this.journalQueued || Date.now() < this.nextJournalAt) return;
    this.journalQueued = true;
    void this.enqueue(() => this.writeJournal())
      .catch((error: unknown) => this.fail('écriture du journal', error))
      .finally(() => {
        this.journalQueued = false;
      });
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
      this.journalFailures = 0;
      this.nextJournalAt = 0;
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
      const now = Date.now();
      this.flushFailingSince ??= now;
      this.journalFailures += 1;
      this.nextJournalAt = now + backoff(this.journalFailures, this.host.options.journalFlushMs ?? 250, JOURNAL_RETRY_MAX_MS);
      this.host.metrics.journalErrors += 1;
      this.host.log(this.journalFailures === 1 ? 'error' : 'warn', 'écriture du journal en échec', {
        projectId: this.projectId,
        failures: this.journalFailures,
        error: String(error),
      });
      // Avec des clients : salle fermée, ils renverront leurs lots non durables
      // à la suivante. Sans client, personne d'autre n'a ces lots : on les garde
      // et on réessaie.
      if (now - this.flushFailingSince > MAX_JOURNAL_OUTAGE_MS && this.peers.size > 0) this.close(CLOSE_RESTART, 'storage-unavailable');
    }
  }

  private maintain(): void {
    if (this.closed || this.closing || this.maintenanceQueued) return;
    const options = this.host.options;
    const now = Date.now();
    const seq = this.room.state.seq;
    const due = seq > this.checkpointSeq && (
      seq - Math.max(0, this.checkpointSeq) >= (options.checkpointBatches ?? 600)
      || now - this.lastCheckpointAt >= (options.checkpointIntervalMs ?? 60_000)
    );
    const idle = this.idleSince !== null && now - this.idleSince >= (options.idleUnloadMs ?? 60_000);
    if (now < this.nextCheckpointAt) {
      // En attente après un échec : une salle inactive au journal écrit est
      // déchargée sans attendre (reprise = dernier point de sauvegarde + journal).
      if (idle) this.unloadIfIdle();
      return;
    }
    if (!due && !idle) return;
    this.maintenanceQueued = true;
    void this.enqueue(() => this.checkpoint(idle))
      .catch((error: unknown) => this.fail('point de sauvegarde', error))
      .finally(() => {
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
      const documentJson = materializeJson(state.store);
      const shadowDigest = this.shadowDue(started) ? storeDigest(state.store) : null;
      await this.writeJournal();
      if (this.closed) return;
      if (this.journaledSeq < seq) {
        // Journal en échec (déjà signalé) : nouvel essai plus tard.
        this.checkpointFailures += 1;
        this.nextCheckpointAt = Date.now() + backoff(this.checkpointFailures, CHECKPOINT_RETRY_MIN_MS, CHECKPOINT_RETRY_MAX_MS);
        return;
      }
      // Relu avant d'écrire le nouveau (qui remplace le précédent), jugé après :
      // un projet supprimé entre-temps n'est pas un écart.
      const shadow = shadowDigest ? await this.shadowValidate(seq, shadowDigest) : null;
      try {
        await this.host.options.storage.saveCheckpoint(this.projectId, { seq, checkpointJson, documentJson });
      } catch (error) {
        if (error instanceof ProjectNotFoundError) {
          this.projectDeleted('point de sauvegarde');
          return;
        }
        if (shadow) this.reportShadow(seq, shadow);
        this.checkpointFailed(error);
        if (unload) this.unloadIfIdle();
        return;
      }
      if (shadow) this.reportShadow(seq, shadow);
      this.checkpointSeq = seq;
      this.hasDurableCheckpoint = true;
      // Taille de la salle connue exactement : son point de sauvegarde (segments périmés compris).
      state.setSizeChars(checkpointJson.length);
      // Rattrapage par lots borné à la moitié du document : au-delà, l'état complet coûte moins.
      this.room.setCatchUpBudget(Math.max(MIN_CATCH_UP_BYTES, Math.floor(documentJson.length / 2)));
      this.lastCheckpointAt = Date.now();
      this.checkpointFailures = 0;
      this.nextCheckpointAt = 0;
      this.host.recordCheckpoint(Date.now() - started);
      try {
        await this.host.options.storage.pruneJournal(this.projectId, seq);
      } catch (error) {
        // Paquets en trop : relus puis ignorés à la reprise (séquence déjà couverte).
        this.host.log('warn', 'élagage du journal en échec', { projectId: this.projectId, error: String(error) });
      }
    }
    if (unload) this.unloadIfIdle();
  }

  private checkpointFailed(error: unknown): void {
    this.checkpointFailures += 1;
    const retryInMs = backoff(this.checkpointFailures, CHECKPOINT_RETRY_MIN_MS, CHECKPOINT_RETRY_MAX_MS);
    this.nextCheckpointAt = Date.now() + retryInMs;
    this.host.metrics.checkpointErrors += 1;
    this.host.log(this.checkpointFailures === 1 ? 'error' : 'warn', 'point de sauvegarde en échec', {
      projectId: this.projectId,
      failures: this.checkpointFailures,
      retryInMs,
      error: String(error),
    });
  }

  /** Personne, rien en attente, journal écrit jusqu'au bout : déchargée (reprise = point de sauvegarde + journal). */
  private unloadIfIdle(): void {
    if (this.peers.size === 0 && this.unflushed.length === 0 && this.journaledSeq >= this.room.state.seq) this.close(1000, 'idle');
  }

  private shadowDue(now: number): boolean {
    const interval = this.host.options.shadowValidationIntervalMs ?? DEFAULT_SHADOW_INTERVAL_MS;
    return interval > 0 && this.hasDurableCheckpoint && now - this.lastShadowAt >= interval;
  }

  /** Validation fantôme : état durable rejoué jusqu'à `seq` = mémoire à `seq` ? null : lecture impossible. */
  private async shadowValidate(seq: number, expected: string): Promise<ShadowResult | null> {
    this.lastShadowAt = Date.now();
    try {
      return verifyDurable(await this.host.options.storage.readDurable(this.projectId), seq, expected);
    } catch (error) {
      this.host.metrics.shadowErrors += 1;
      this.host.log('warn', 'validation fantôme impossible (lecture du stockage)', { projectId: this.projectId, error: String(error) });
      return null;
    }
  }

  /** Résultat de la validation fantôme (signalé, jamais corrigé). */
  private reportShadow(seq: number, result: ShadowResult): void {
    this.host.metrics.shadowChecks += 1;
    if (result.ok) return;
    this.host.metrics.shadowMismatches += 1;
    this.host.log('error', 'validation fantôme : état durable différent de la mémoire', { projectId: this.projectId, seq, reason: result.reason });
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
    ? new RoomState(deserializeCheckedStore(loaded.checkpoint.snapshot), loaded.checkpoint.seq, loaded.checkpoint.clientSeqs, loaded.checkpoint.clientUsers)
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
  /** Connexions à prévenir quand les accès d'un projet changent (révocation signalée par l'API). */
  private readonly accessListeners = new Map<string, Set<() => void>>();
  private readonly journalLatencies: number[] = [];
  private readonly checkpointDurations: number[] = [];
  private readonly eventLoopDelay = monitorEventLoopDelay({ resolution: 20 });
  private shuttingDown = false;
  readonly metrics = {
    batches: 0,
    fenced: 0,
    journalErrors: 0,
    checkpointErrors: 0,
    loads: 0,
    loadErrors: 0,
    deletedRooms: 0,
    shadowChecks: 0,
    shadowMismatches: 0,
    shadowErrors: 0,
    /** Canal `motion` (caméra, curseur) : relayés, jetés au débit, invalides, sautés sous contre-pression. */
    motionIn: 0,
    motionDroppedRate: 0,
    motionInvalid: 0,
    motionSkippedBackpressure: 0,
    /** Connexions fermées : remplacées par une nouvelle du même client (4409), trop de messages (4429). */
    connectionsReplaced: 0,
    rateLimited: 0,
    /** Salles fermées après une exception (message ou entretien), rechargées ensuite. */
    roomFailures: 0,
    /** Connexions refusées à l'entrée (jeton, droits, version, origine, plafonds…). */
    connectionsRefused: 0,
    /** Lecture d'une connexion mise en pause (débit en octets dépassé). */
    bytesThrottled: 0,
  };

  constructor(options: RoomHostOptions) {
    this.options = options;
    this.eventLoopDelay.enable();
  }

  log(level: 'info' | 'warn' | 'error', message: string, data?: Record<string, unknown>): void {
    (this.options.log ?? defaultLog)(level, message, data);
  }

  /** Salle du projet (chargée au besoin, un seul chargement à la fois) ; null : projet introuvable. */
  async open(projectId: string, seed?: ProjectDocument): Promise<HostedRoom | null> {
    if (this.shuttingDown) throw new Error('shutting-down');
    const existing = this.rooms.get(projectId);
    if (existing && !existing.closed) return existing;
    // Mémoire presque pleine : pas de nouvelle salle (les salles chargées restent servies).
    if (this.heapRatio() > ROOM_LOAD_HEAP_RATIO) throw new Error('busy');
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

  /** Part du tas utilisée (0–1) : soupape des nouvelles salles et connexions. */
  heapRatio(): number {
    const heap = getHeapStatistics();
    return heap.heap_size_limit > 0 ? heap.used_heap_size / heap.heap_size_limit : 0;
  }

  /** `listener` est appelé quand les accès du projet changent ; renvoie de quoi se désinscrire. */
  onAccessChanged(projectId: string, listener: () => void): () => void {
    let listeners = this.accessListeners.get(projectId);
    if (!listeners) {
      listeners = new Set();
      this.accessListeners.set(projectId, listeners);
    }
    listeners.add(listener);
    return () => {
      listeners.delete(listener);
      if (listeners.size === 0 && this.accessListeners.get(projectId) === listeners) this.accessListeners.delete(projectId);
    };
  }

  /** Accès du projet changés (éditeur retiré, départ, suppression) : chaque connexion se revérifie tout de suite. */
  accessChanged(projectId: string): void {
    for (const listener of [...(this.accessListeners.get(projectId) ?? [])]) listener();
  }

  forget(hosted: HostedRoom): void {
    if (this.rooms.get(hosted.projectId) === hosted) this.rooms.delete(hosted.projectId);
  }

  async shutdown(): Promise<void> {
    this.shuttingDown = true;
    this.eventLoopDelay.disable();
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

  /** Mesures du serveur ; le retard de la boucle d'événements repart de zéro à chaque lecture. */
  snapshotMetrics(): Record<string, number> {
    let clients = 0;
    for (const hosted of this.rooms.values()) clients += hosted.peers.size;
    const memory = process.memoryUsage();
    const loopP99 = this.eventLoopDelay.count > 0 ? this.eventLoopDelay.percentile(99) / 1e6 : 0;
    const loopMax = this.eventLoopDelay.count > 0 ? this.eventLoopDelay.max / 1e6 : 0;
    this.eventLoopDelay.reset();
    return {
      rooms: this.rooms.size,
      clients,
      ...this.metrics,
      journal_latency_p50_ms: percentile(this.journalLatencies, 0.5),
      journal_latency_p95_ms: percentile(this.journalLatencies, 0.95),
      checkpoint_p95_ms: percentile(this.checkpointDurations, 0.95),
      event_loop_delay_p99_ms: Math.round(loopP99 * 10) / 10,
      event_loop_delay_max_ms: Math.round(loopMax * 10) / 10,
      rss_bytes: memory.rss,
      heap_used_bytes: memory.heapUsed,
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
