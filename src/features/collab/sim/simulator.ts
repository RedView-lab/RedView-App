import type { PreSessionChange } from '@/features/itineraryPanel/context/ProjectStore/collab';
import { canonicalJson } from '@/features/itineraryPanel/lib/project/canonicalJson';
import type { ProjectDocument } from '@/features/itineraryPanel/lib/project/layers';

import { CollabClient } from '../client/collabClient';
import { Materializer } from '../model/materialize';
import type { ObjectStore } from '../model/objects';
import {
  deserializeStore,
  PROTOCOL_VERSION,
  serializeStore,
  type ClientMessage,
  type SequencedBatch,
  type ServerMessage,
  type Snapshot,
} from '../protocol';
import { Room, type RoomPeer } from '../room/room';
import { RoomState } from '../room/roomState';
import { incrementCounter, randomEdit, readCounter, sampleDocument, simUserId } from './fixtures';
import { Scheduler, seededRandom } from './scheduler';

/**
 * Simulateur déterministe de co-édition (à la manière du prototype à trois
 * clients de Figma) : un serveur (salle + journal + points de sauvegarde), N
 * clients qui modifient, annulent et rétablissent au hasard, un réseau simulé
 * (latence, connexions FIFO comme TCP, coupures, reconnexions), des arrêts
 * brutaux du serveur et des onglets rechargés : le client repart d'un
 * document en retard (point de sauvegarde du « cloud », ou sa copie locale),
 * reprend ses lots non écrits avec le même `clientId`, et modifie avant
 * d'être branché puis avant l'état du serveur. Tout est rejouable à partir de
 * la graine.
 *
 * Vérifié à la fin (`SimulationReport`) :
 *  - convergence : tous les clients affichent exactement le document du
 *    serveur, sans modification en attente ;
 *  - durabilité : point de sauvegarde + journal relus = état en mémoire ;
 *  - aucune modification perdue : le compteur que chaque client est seul à
 *    écrire vaut la dernière valeur que ce client y a mise (écriture,
 *    annuler, rétablir), malgré coupures, arrêts et rechargements ;
 *  - après chaque action, le document de l'application est exactement l'état
 *    visible du client rematérialisé (différence ↔ opérations sans perte).
 */

export interface SimulationOptions {
  seed: number;
  clients: number;
  /** Durée simulée des modifications (ms). */
  durationMs: number;
  /** Modifications par seconde et par client (en moyenne). */
  editRate?: number;
  /** Probabilité par seconde et par client d'une coupure réseau. */
  disconnectRate?: number;
  /** Probabilité par seconde d'un arrêt brutal du serveur. */
  crashRate?: number;
  /** Probabilité par seconde et par client d'un onglet rechargé. */
  reloadRate?: number;
  latencyMs?: [number, number];
  routeSize?: number;
}

export interface SimulationReport {
  seed: number;
  converged: boolean;
  durableMatchesMemory: boolean;
  countersIntact: boolean;
  failures: string[];
  stats: {
    edits: number;
    undos: number;
    redos: number;
    batches: number;
    disconnects: number;
    crashes: number;
    reloads: number;
    /** Actions faites avant l'état du serveur (connexion en cours). */
    preWelcomeActions: number;
    snapshots: number;
    rejections: number;
    /** Messages `motion` (caméra, curseur) reçus par les clients : jamais dans le document. */
    motions: number;
    finalSeq: number;
  };
}

const JOURNAL_FLUSH_MS = 250;
const CHECKPOINT_EVERY_MS = 3_000;
const ROOM_TICK_MS = 100;
const FLUSH_DELAY_MS = 33;

interface DurableStorage {
  checkpoint: { snapshot: Snapshot; clientSeqs: Record<string, number> } | null;
  journal: SequencedBatch[];
}

class SimConnection {
  open = true;
  welcomed = false;
  private lastToServer = 0;
  private lastToClient = 0;
  readonly peer: RoomPeer;
  readonly sim: Simulation;
  readonly client: SimClient;

  constructor(sim: Simulation, client: SimClient) {
    this.sim = sim;
    this.client = client;
    this.peer = {
      clientId: client.id,
      userId: simUserId(client.id),
      send: (message) => this.toClient(message),
    };
  }

  toServer(message: ClientMessage): void {
    if (!this.open) return;
    const wire = JSON.stringify(message);
    const at = Math.max(this.lastToServer, this.sim.scheduler.now() + this.sim.latency());
    this.lastToServer = at;
    this.sim.scheduler.at(at, () => {
      if (this.open) this.sim.server.receive(this, JSON.parse(wire) as ClientMessage);
    });
  }

  toClient(message: ServerMessage): void {
    if (!this.open) return;
    const wire = JSON.stringify(message);
    const at = Math.max(this.lastToClient, this.sim.scheduler.now() + this.sim.latency());
    this.lastToClient = at;
    this.sim.scheduler.at(at, () => {
      if (this.open) this.client.onMessage(this, JSON.parse(wire) as ServerMessage);
    });
  }

  /** Coupure : les messages en vol sont perdus ; chaque côté l'apprend après un délai. */
  close(): void {
    if (!this.open) return;
    this.open = false;
    this.sim.scheduler.after(this.sim.latency(), () => this.sim.server.closed(this));
    this.sim.scheduler.after(this.sim.latency(), () => this.client.onClose(this));
  }
}

class SimServer {
  readonly storage: DurableStorage = { checkpoint: null, journal: [] };
  room: Room | null = null;
  private unflushed: SequencedBatch[] = [];
  private readonly connections = new Set<SimConnection>();
  private epochCount = 0;
  private readonly sim: Simulation;
  private readonly initial: ProjectDocument;
  batches = 0;

  constructor(sim: Simulation, initial: ProjectDocument) {
    this.sim = sim;
    this.initial = initial;
  }

  /** (Re)démarrage : point de sauvegarde + journal au-delà de sa séquence. */
  boot(): void {
    const state = recoverState(this.storage, this.initial);
    this.epochCount += 1;
    this.unflushed = [];
    this.room = new Room(state, {
      epoch: `e${this.epochCount}`,
      now: () => this.sim.scheduler.now(),
      onBatch: (batch) => {
        this.unflushed.push(batch);
        this.batches += 1;
      },
    });
  }

  crash(): void {
    this.room = null;
    this.unflushed = [];
    for (const connection of [...this.connections]) connection.close();
    this.connections.clear();
    this.sim.scheduler.after(200 + this.sim.random() * 800, () => this.boot());
  }

  receive(connection: SimConnection, message: ClientMessage): void {
    const room = this.room;
    if (!room) {
      connection.close();
      return;
    }
    if (message.type === 'hello') {
      this.connections.add(connection);
      room.join(connection.peer, { epoch: message.epoch, lastSeq: message.lastSeq, presence: message.presence });
      return;
    }
    if (!this.connections.has(connection)) return;
    room.handle(connection.peer.clientId, message);
  }

  closed(connection: SimConnection): void {
    if (!this.connections.delete(connection)) return;
    this.room?.leave(connection.peer.clientId, connection.peer);
  }

  flushJournal(): void {
    if (!this.room || this.unflushed.length === 0) return;
    this.storage.journal.push(...this.unflushed);
    const last = this.unflushed[this.unflushed.length - 1].seq;
    this.unflushed = [];
    this.room.markDurable(last);
  }

  checkpoint(): void {
    if (!this.room) return;
    this.flushJournal();
    const { state } = this.room;
    this.storage.checkpoint = { snapshot: state.snapshot(), clientSeqs: state.clientSeqs() };
    this.storage.journal = this.storage.journal.filter((batch) => batch.seq > state.seq);
  }

  tick(): void {
    this.room?.tick();
  }
}

class SimClient {
  readonly id: string;
  collab: CollabClient;
  private connection: SimConnection | null = null;
  private flushScheduled = false;
  private reconnectAttempt = 0;
  /** Le « store » est branché (document affiché) : l'utilisateur peut agir. */
  private bound = false;
  edits = 0;
  undos = 0;
  redos = 0;
  reloads = 0;
  preWelcomeActions = 0;
  /** Dernière valeur que ce client a mise dans son compteur (écriture, annuler, rétablir). */
  counter = 0;
  rejections = 0;
  snapshots = 0;
  motions = 0;
  /** Message `motion` reçu de soi-même ou incohérent (la salle ne le renvoie jamais à l'émetteur). */
  motionEcho: string | null = null;
  /** Premier écart document de l'application ↔ état visible (différence mal appliquée). */
  mismatch: string | null = null;
  private readonly sim: Simulation;

  constructor(sim: Simulation, id: string) {
    this.sim = sim;
    this.id = id;
    this.collab = this.createClient();
  }

  /** Client de ce `clientId` (le même après un rechargement : le serveur reconnaît ses lots). */
  private createClient(): CollabClient {
    const client = new CollabClient({
      clientId: this.id,
      clock: this.sim.scheduler,
      transport: {
        isOnline: () => !!this.connection?.open && this.connection.welcomed,
        send: (message) => this.connection?.toServer(message),
        requestFlush: () => this.scheduleFlush(),
        resync: () => this.connection?.close(),
      },
      onRejection: () => {
        this.rejections += 1;
      },
    });
    client.subscribeMotion((event) => {
      this.motions += 1;
      if (!this.motionEcho && event.from === this.id) this.motionEcho = `reçu son propre message motion (t=${event.t})`;
    });
    return client;
  }

  /**
   * Présence en direct, mêlée aux lots : caméra + pointeur (éphémères), et de
   * temps en temps la présence (suivi, Spotlight). Rien de tout ça ne doit
   * toucher le document, l'ordre des lots ni le journal.
   */
  live(peers: readonly SimClient[]): void {
    if (!this.bound) return;
    const now = this.sim.scheduler.now();
    const x = this.sim.random();
    this.collab.sendMotion(now, {
      cam: [6 + x, 45 + x, 12 + x, 360 * x - 180, 60 * x, 36.87],
      vp: [1600, 900, 64, 360, 300, 420, 0, 0, 0, 0],
      ptr: x < 0.1 ? null : [6 + x, 45 + x],
    });
    if (x < 0.05) {
      const other = peers[Math.floor(this.sim.random() * peers.length)];
      this.collab.setPresence({
        name: this.id,
        following: other && other.id !== this.id ? other.id : null,
        spotlight: this.sim.random() < 0.3,
      });
    }
  }

  /** Branche le « store » : document affiché et écritures faites avant le branchement. */
  bind(base: ProjectDocument, changes: PreSessionChange[]): void {
    this.collab.bind(base, changes);
    this.bound = true;
    this.checkVisible('branchement');
  }

  /**
   * Onglet rechargé : connexion coupée sans prévenir, lots non écrits gardés
   * (copie de l'appareil) et repris par un nouveau client du même `clientId`,
   * qui part de `base` (document en retard) et modifie avant d'être branché
   * puis avant l'état du serveur.
   */
  reload(base: ProjectDocument): void {
    const unsynced = this.collab.engine.unsyncedBatches();
    const nextSeq = this.collab.engine.nextSeq;
    const previous = this.connection;
    this.connection = null;
    previous?.close();
    this.collab.dispose();
    this.collab = this.createClient();
    this.collab.engine.restoreUnsynced(unsynced, nextSeq);
    this.bound = false;
    this.reloads += 1;

    const changes: PreSessionChange[] = [];
    let document = base;
    const count = Math.floor(this.sim.random() * 3);
    for (let index = 0; index < count; index += 1) {
      const edit = randomEdit(document, this.sim.random, this.id, 10_000 + this.reloads * 10 + index);
      if (!edit) continue;
      document = edit.document;
      changes.push({ document, change: edit.change });
    }
    if (this.sim.random() < 0.5) {
      const next = incrementCounter(document, this.id);
      document = next.document;
      changes.push({ document, change: 'user' });
      this.counter = next.value;
    }
    this.bind(base, changes);
    this.sim.scheduler.after(100 + this.sim.random() * 1_500, () => this.connect());
  }

  get online(): boolean {
    return !!this.connection?.open && this.connection.welcomed;
  }

  connect(): void {
    if (this.connection?.open) return;
    const connection = new SimConnection(this.sim, this);
    this.connection = connection;
    connection.toServer({
      type: 'hello',
      v: PROTOCOL_VERSION,
      presence: { name: this.id },
      ...this.collab.helloFields(),
    });
  }

  disconnect(): void {
    this.connection?.close();
  }

  onMessage(connection: SimConnection, message: ServerMessage): void {
    if (connection !== this.connection) return;
    if (message.type === 'welcome') {
      connection.welcomed = true;
      this.reconnectAttempt = 0;
      if (message.snapshot) this.snapshots += 1;
    }
    this.collab.receive(message);
  }

  onClose(connection: SimConnection): void {
    if (connection !== this.connection) return;
    this.connection = null;
    this.collab.disconnected(true);
    // Attente exponentielle + aléa, comme le vrai client.
    const delay = Math.min(5_000, 200 * 2 ** this.reconnectAttempt) * (0.5 + this.sim.random() * 0.5);
    this.reconnectAttempt += 1;
    this.sim.scheduler.after(delay, () => this.connect());
  }

  /** Une action de l'utilisateur (dès que le store est branché, avant même l'état du serveur). */
  act(): void {
    if (!this.bound) return;
    if (!this.collab.engine.isReady) this.preWelcomeActions += 1;
    const before = readCounter(this.collab.getDocument(), this.id);
    this.perform();
    const after = readCounter(this.collab.getDocument(), this.id);
    if (after !== before) this.counter = after;
  }

  private perform(): void {
    const roll = this.sim.random();
    if (roll < 0.08) {
      if (this.collab.canUndo()) {
        this.collab.undo();
        this.undos += 1;
      }
      return;
    }
    if (roll < 0.12) {
      if (this.collab.canRedo()) {
        this.collab.redo();
        this.redos += 1;
      }
      return;
    }
    const document = this.collab.getDocument();
    if (roll < 0.2) {
      // En session, un « résultat calculé » (jamais dans annuler) ; avant l'état
      // du serveur, une action de l'utilisateur (un calcul y resterait local).
      const next = incrementCounter(document, this.id);
      this.collab.pushLocalDocument(next.document, this.collab.engine.isReady ? 'background' : 'user');
      return;
    }
    const edit = randomEdit(document, this.sim.random, this.id, this.edits);
    if (!edit) return;
    this.collab.pushLocalDocument(edit.document, edit.change);
    this.edits += 1;
    this.checkVisible(`modification ${this.edits} (${edit.change})`);
  }

  private checkVisible(context: string): void {
    if (this.mismatch) return;
    const local = canonicalJson(this.collab.getDocument());
    const visible = canonicalJson(new Materializer().materialize(this.collab.engine.visible));
    if (local !== visible) this.mismatch = `${context} : ${firstDifference(local, visible)}`;
  }

  private scheduleFlush(): void {
    if (this.flushScheduled) return;
    this.flushScheduled = true;
    this.sim.scheduler.after(FLUSH_DELAY_MS, () => {
      this.flushScheduled = false;
      this.collab.flush();
    });
  }
}

class Simulation {
  readonly scheduler = new Scheduler();
  readonly random: () => number;
  readonly server: SimServer;
  readonly clients: SimClient[] = [];
  private readonly options: Required<SimulationOptions>;
  faults = true;
  disconnects = 0;
  crashes = 0;

  constructor(options: SimulationOptions) {
    this.options = {
      editRate: 4,
      disconnectRate: 0.05,
      crashRate: 0.01,
      reloadRate: 0.02,
      latencyMs: [5, 120],
      routeSize: 800,
      ...options,
    };
    this.random = seededRandom(options.seed);
    this.server = new SimServer(this, sampleDocument(this.options.routeSize));
    for (let index = 0; index < options.clients; index += 1) this.clients.push(new SimClient(this, `c${index}`));
  }

  latency(): number {
    const [min, max] = this.options.latencyMs;
    return min + this.random() * (max - min);
  }

  run(): SimulationReport {
    const { scheduler } = this;
    this.server.boot();
    scheduler.setInterval(() => this.server.flushJournal(), JOURNAL_FLUSH_MS);
    scheduler.setInterval(() => this.server.checkpoint(), CHECKPOINT_EVERY_MS);
    scheduler.setInterval(() => this.server.tick(), ROOM_TICK_MS);
    const initial = sampleDocument(this.options.routeSize);
    for (const client of this.clients) {
      // Store branché à l'ouverture (document du cloud) ; connexion un peu plus tard.
      client.bind(initial, []);
      scheduler.after(this.random() * 500, () => client.connect());
      this.scheduleActions(client);
    }
    this.scheduleFaults();
    scheduler.runUntil(this.options.durationMs);

    // Fin des perturbations : tout le monde se reconnecte et le système se stabilise.
    this.faults = false;
    if (!this.server.room) scheduler.runUntil(scheduler.now() + 2_000);
    for (const client of this.clients) client.connect();
    scheduler.runUntil(scheduler.now() + 15_000);
    this.server.flushJournal();
    scheduler.runUntil(scheduler.now() + 2_000);
    return this.report();
  }

  private scheduleActions(client: SimClient): void {
    const step = () => {
      if (!this.faults) return;
      client.act();
      this.scheduler.after(-Math.log(1 - this.random()) * (1000 / this.options.editRate), step);
    };
    this.scheduler.after(600 + this.random() * 400, step);
    // Présence en direct à ≈ 30 Hz, par rafales (souris, caméra qui bougent).
    const live = () => {
      if (!this.faults) return;
      client.live(this.clients);
      this.scheduler.after(this.random() < 0.95 ? 33 : 400 + this.random() * 1_000, live);
    };
    this.scheduler.after(500 + this.random() * 500, live);
  }

  private scheduleFaults(): void {
    const tick = () => {
      if (!this.faults) return;
      for (const client of this.clients) {
        if (this.random() < this.options.disconnectRate / 10) {
          client.disconnect();
          this.disconnects += 1;
        }
        if (this.random() < this.options.reloadRate / 10) {
          // Document affiché à la réouverture : point de sauvegarde (cloud), ou la copie locale.
          client.reload(this.random() < 0.5 ? this.cloudDocument() : client.collab.getDocument());
        }
      }
      if (this.server.room && this.random() < this.options.crashRate / 10) {
        this.server.crash();
        this.crashes += 1;
      }
      this.scheduler.after(100, tick);
    };
    this.scheduler.after(100, tick);
  }

  /** Document du cloud : celui du dernier point de sauvegarde (en retard sur la salle). */
  private cloudDocument(): ProjectDocument {
    const checkpoint = this.server.storage.checkpoint;
    return checkpoint
      ? new Materializer().materialize(deserializeStore(checkpoint.snapshot))
      : sampleDocument(this.options.routeSize);
  }

  private report(): SimulationReport {
    const failures: string[] = [];
    const room = this.server.room;
    if (!room) failures.push('serveur arrêté à la fin');
    const serverDocument = room ? new Materializer().materialize(room.state.store) : null;
    const serverJson = serverDocument ? canonicalJson(serverDocument) : '';

    let converged = !!room;
    for (const client of this.clients) {
      const state = client.collab.getState();
      if (!client.online) {
        converged = false;
        failures.push(`${client.id} hors ligne à la fin`);
        continue;
      }
      if (state.unsynced > 0) {
        converged = false;
        failures.push(`${client.id} : ${state.unsynced} lot(s) non acquitté(s)`);
      }
      if (room && client.collab.engine.seq !== room.state.seq) {
        converged = false;
        failures.push(`${client.id} : séquence ${client.collab.engine.seq} ≠ serveur ${room.state.seq}`);
      }
      const json = canonicalJson(client.collab.getDocument());
      if (json !== serverJson) {
        converged = false;
        failures.push(`${client.id} : document différent du serveur (${firstDifference(json, serverJson)})`);
      }
      // Le document matérialisé de l'état visible (et non le dernier poussé) est le même.
      const visibleJson = canonicalJson(new Materializer().materialize(client.collab.engine.visible));
      if (visibleJson !== json) {
        converged = false;
        failures.push(`${client.id} : document local ≠ état visible`);
      }
    }

    for (const client of this.clients) {
      if (client.mismatch) {
        converged = false;
        failures.push(`${client.id} : document ≠ état visible après ${client.mismatch}`);
      }
      if (client.motionEcho) {
        converged = false;
        failures.push(`${client.id} : ${client.motionEcho}`);
      }
    }

    let durableMatchesMemory = false;
    if (room) {
      const recovered = recoverState(this.server.storage, sampleDocument(this.options.routeSize));
      durableMatchesMemory = recovered.seq === room.state.seq
        && canonicalStore(recovered.store) === canonicalStore(room.state.store);
      if (!durableMatchesMemory) failures.push(`journal relu ≠ mémoire (séquences ${recovered.seq} / ${room.state.seq})`);
    }

    let countersIntact = !!serverDocument;
    for (const client of this.clients) {
      if (!serverDocument) break;
      const value = readCounter(serverDocument, client.id);
      if (value !== client.counter) {
        countersIntact = false;
        failures.push(`${client.id} : compteur ${value} au lieu de ${client.counter} (modification perdue)`);
      }
    }

    return {
      seed: this.options.seed,
      converged,
      durableMatchesMemory,
      countersIntact,
      failures,
      stats: {
        edits: sum(this.clients, (client) => client.edits),
        undos: sum(this.clients, (client) => client.undos),
        redos: sum(this.clients, (client) => client.redos),
        batches: this.server.batches,
        disconnects: this.disconnects,
        crashes: this.crashes,
        reloads: sum(this.clients, (client) => client.reloads),
        preWelcomeActions: sum(this.clients, (client) => client.preWelcomeActions),
        snapshots: sum(this.clients, (client) => client.snapshots),
        rejections: sum(this.clients, (client) => client.rejections),
        motions: sum(this.clients, (client) => client.motions),
        finalSeq: room?.state.seq ?? -1,
      },
    };
  }
}

function recoverState(storage: DurableStorage, initial: ProjectDocument): RoomState {
  const state = storage.checkpoint
    ? new RoomState(deserializeStore(storage.checkpoint.snapshot), storage.checkpoint.snapshot.seq, storage.checkpoint.clientSeqs)
    : RoomState.fromDocument(initial, 0);
  for (const batch of storage.journal) state.replay(batch);
  return state;
}

/** Forme canonique d'un magasin (objets triés par id, propriétés par clé, blobs exclus). */
function canonicalStore(store: ObjectStore): string {
  const { objects } = serializeStore(store, 0);
  return canonicalJson(objects
    .map(([id, parent, field, pos, props]) => [id, parent, field, pos, Object.fromEntries(props)])
    .sort((a, b) => ((a[0] as string) < (b[0] as string) ? -1 : 1)));
}

function firstDifference(a: string, b: string): string {
  let index = 0;
  while (index < a.length && a[index] === b[index]) index += 1;
  return `…${a.slice(Math.max(0, index - 60), index + 60)}… / …${b.slice(Math.max(0, index - 60), index + 60)}…`;
}

function sum<T>(items: readonly T[], value: (item: T) => number): number {
  return items.reduce((total, item) => total + value(item), 0);
}

export function runSimulation(options: SimulationOptions): SimulationReport {
  return new Simulation(options).run();
}
