/**
 * Test de charge du serveur temps réel (cibles du plan de co-édition) :
 * `--rooms` salles × `--clients` clients × `--rate` lots par seconde et par
 * client pendant `--seconds` secondes, sur le vrai serveur (processus enfant,
 * server.ts : stockage de fichiers avec latence façon Appwrite) et de vrais
 * WebSocket (clients légers : `hello`, puis des lots de propriétés, comme un
 * éditeur qui renomme, recolore, règle ses priorités).
 *
 * Mesuré :
 *  - diffusion : envoi d'un lot par un client → réception par les autres
 *    (même machine : réseau négligeable, c'est le temps du serveur) ;
 *  - journal durable p95 (serveur), points de sauvegarde, validation fantôme ;
 *  - boucle d'événements du serveur (retard p99) ;
 *  - mémoire par salle : tas après ramasse-miettes, salles chargées et
 *    éditées mais clients partis (rattrapage par lots compris), rapporté à la
 *    taille du document ; mémoire par connexion à part ;
 *  - présence en direct : une part des clients (`--motionShare`) envoie sa
 *    caméra + son pointeur à `--motion` Hz (cadence d'un éditeur suivi) ;
 *    relais `motion` mesuré comme la diffusion, en même temps que les lots.
 *
 * Cibles : diffusion p95 < 50 ms (lots et `motion`), journal p95 < 600 ms,
 * mémoire par salle ≤ 2 × le document, aucune erreur serveur, aucun écart de
 * validation fantôme, aucun `motion` jeté au débit. Sortie non nulle sinon.
 *
 *   npx tsx script-test-bench/collab-load/run.ts [--rooms=50 --clients=5 --rate=20 --seconds=30 --route=1500 --motion=30 --motionShare=0.2]
 */
import { fork, type ChildProcess } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { WebSocket } from 'ws';

import { itineraryObjectId } from '../../src/features/collab/model/paths.ts';
import { PROTOCOL_VERSION, socketProtocols, type ServerMessage } from '../../src/features/collab/protocol.ts';
import { sampleDocument } from '../../src/features/collab/sim/fixtures.ts';

const arg = (name: string, fallback: number) =>
  Number(process.argv.find((value) => value.startsWith(`--${name}=`))?.slice(name.length + 3) ?? fallback);
const ROOMS = arg('rooms', 50);
const CLIENTS = arg('clients', 5);
const RATE = arg('rate', 20);
const SECONDS = arg('seconds', 30);
const ROUTE = arg('route', 1_500);
const MOTION_HZ = arg('motion', 30);
/** Part des clients suivis (ou qui présentent) : par défaut un par salle de cinq. */
const MOTION_SHARE = arg('motionShare', 0.2);

const TARGETS = { broadcastP95Ms: 50, journalP95Ms: 600, memoryPerDocument: 2 };

type Metrics = Record<string, number>;

function percentile(values: readonly number[], q: number): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.min(sorted.length - 1, Math.floor(q * sorted.length))];
}

const round = (value: number, digits = 1) => Math.round(value * 10 ** digits) / 10 ** digits;

// ── Serveur ──────────────────────────────────────────────────────────────────
const here = path.dirname(fileURLToPath(import.meta.url));
const child: ChildProcess = fork(path.join(here, 'server.ts'), [], {
  execArgv: ['--import', 'tsx', '--expose-gc'],
  stdio: ['ignore', 'inherit', 'inherit', 'ipc'],
});

function request<T>(type: string, reply: string): Promise<T> {
  return new Promise((resolve) => {
    const listener = (message: { type: string } & T) => {
      if (message.type !== reply) return;
      child.off('message', listener);
      resolve(message);
    };
    child.on('message', listener);
    if (type) child.send({ type });
  });
}

const { port } = await request<{ port: number }>('', 'ready');
const measure = () => request<{ metrics: Metrics; errors: string[]; gc: boolean }>('measure', 'metrics');
const baseline = await measure();

// ── Clients légers ───────────────────────────────────────────────────────────
const document = sampleDocument(ROUTE);
const documentBytes = Buffer.byteLength(JSON.stringify(document), 'utf8');
const sentAt = new Map<string, number>();
const broadcast: number[] = [];
const acks: number[] = [];
/** Relais `motion` : envoi → réception (même processus : horloge commune). */
const motionRelay: number[] = [];
let motionSent = 0;
let rejected = 0;
let received = 0;

class LoadClient {
  readonly clientId: string;
  private readonly projectId: string;
  private readonly seed: boolean;
  private socket: WebSocket | null = null;
  private clientSeq = 0;
  private timer: ReturnType<typeof setInterval> | null = null;
  private motionTimer: ReturnType<typeof setInterval> | null = null;
  /** Ce client est suivi (ou présente) : caméra + pointeur à `MOTION_HZ`. */
  private readonly sendsMotion: boolean;

  constructor(room: number, index: number) {
    this.projectId = `load-${room}`;
    this.clientId = `load-${room}-${index}`;
    this.seed = index === 0;
    this.sendsMotion = MOTION_HZ > 0 && index < Math.round(CLIENTS * MOTION_SHARE);
  }

  open(): Promise<void> {
    return new Promise((resolve, reject) => {
      const socket = new WebSocket(`ws://127.0.0.1:${port}/multiplayer?project=${this.projectId}`, socketProtocols(`dev:${this.clientId}`));
      this.socket = socket;
      socket.on('open', () => socket.send(JSON.stringify({
        type: 'hello',
        v: PROTOCOL_VERSION,
        clientId: this.clientId,
        epoch: null,
        lastSeq: null,
        ...(this.seed ? { seed: document } : {}),
      })));
      socket.on('message', (data) => {
        const now = performance.now();
        const message = JSON.parse(String(data)) as ServerMessage;
        received += 1;
        if (message.type === 'welcome') resolve();
        else if (message.type === 'batch') {
          const at = sentAt.get(`${message.batch.clientId}#${message.batch.clientSeq}`);
          if (at !== undefined) (message.batch.clientId === this.clientId ? acks : broadcast).push(now - at);
        } else if (message.type === 'motion') motionRelay.push(now - message.t);
        else if (message.type === 'reject') rejected += 1;
      });
      socket.on('error', reject);
    });
  }

  start(): void {
    const ops = ['name', 'color', 'priorities.elevation'];
    const id = itineraryObjectId(this.clientId.endsWith('-0') ? 'it-1' : 'it-2');
    // Phase aléatoire : les clients n'envoient pas tous au même instant.
    setTimeout(() => {
      this.timer = setInterval(() => {
        this.clientSeq += 1;
        const key = ops[this.clientSeq % ops.length];
        // Valeurs qu'un client honnête écrit (le serveur refuse une couleur qui n'en est pas une).
        const value = key === 'priorities.elevation'
          ? this.clientSeq % 100
          : key === 'color' ? `#${(this.clientSeq * 2654435761 % 0xffffff).toString(16).padStart(6, '0')}` : `${this.clientId}-${this.clientSeq}`;
        sentAt.set(`${this.clientId}#${this.clientSeq}`, performance.now());
        this.socket!.send(JSON.stringify({ type: 'batch', clientSeq: this.clientSeq, ops: [{ t: 's', id, k: key, v: value }], blobs: {} }));
      }, 1000 / RATE);
    }, Math.random() * (1000 / RATE));
    if (!this.sendsMotion) return;
    setTimeout(() => {
      let step = 0;
      this.motionTimer = setInterval(() => {
        step += 1;
        const x = (step % 600) / 600;
        motionSent += 1;
        this.socket!.send(JSON.stringify({
          type: 'motion',
          t: Math.round(performance.now() * 10) / 10,
          cam: [6.9 + 0.05 * x, 45.95 + 0.02 * x, 13, 360 * x - 180, 55, 36.87],
          vp: [1600, 900, 64, 360, 300, 420, 0, 0, 0, 0],
          ptr: [6.91 + 0.01 * x, 45.96],
        }));
      }, 1000 / MOTION_HZ);
    }, Math.random() * (1000 / MOTION_HZ));
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    if (this.motionTimer) clearInterval(this.motionTimer);
  }

  close(): void {
    this.socket?.close(1000, 'done');
  }
}

const clients: LoadClient[] = [];
for (let room = 0; room < ROOMS; room += 1) {
  for (let index = 0; index < CLIENTS; index += 1) {
    const client = new LoadClient(room, index);
    clients.push(client);
    // Le premier client crée la salle (document de départ) avant les autres.
    if (index === 0) await client.open();
  }
}
await Promise.all(clients.map((client, index) => (index % CLIENTS === 0 ? Promise.resolve() : client.open())));
const loaded = await measure();
const motionSenders = ROOMS * (MOTION_HZ > 0 ? Math.round(CLIENTS * MOTION_SHARE) : 0);
console.error(`${ROOMS} salles × ${CLIENTS} clients connectés ; document ${(documentBytes / 1024).toFixed(0)} Ko ; charge ${ROOMS * CLIENTS * RATE} lots/s + ${motionSenders * MOTION_HZ} motion/s (relayés ×${CLIENTS - 1}) pendant ${SECONDS} s…`);

const started = performance.now();
for (const client of clients) client.start();
await new Promise((resolve) => setTimeout(resolve, SECONDS * 1000));
for (const client of clients) client.stop();
const elapsed = (performance.now() - started) / 1000;
// Fin : journal et diffusion terminés.
await new Promise((resolve) => setTimeout(resolve, 3_000));
const after = await measure();
// Clients partis, salles encore chargées (déchargement après 60 s d'inactivité) : mémoire des salles seules.
for (const client of clients) client.close();
await new Promise((resolve) => setTimeout(resolve, 2_000));
const roomsOnly = await measure();
child.send({ type: 'stop' });

// ── Rapport ──────────────────────────────────────────────────────────────────
const memoryPerRoom = (roomsOnly.metrics.heap_used_bytes - baseline.metrics.heap_used_bytes) / ROOMS;
const memoryPerClient = (after.metrics.heap_used_bytes - roomsOnly.metrics.heap_used_bytes) / (ROOMS * CLIENTS);
const report = {
  config: { rooms: ROOMS, clients: CLIENTS, rate: RATE, seconds: SECONDS, documentBytes, motionHz: MOTION_HZ, motionSenders },
  throughput: {
    batchesSent: sentAt.size,
    batchesPerSecond: round(sentAt.size / elapsed, 0),
    messagesReceived: received,
    rejected,
  },
  broadcastMs: { p50: round(percentile(broadcast, 0.5)), p95: round(percentile(broadcast, 0.95)), p99: round(percentile(broadcast, 0.99)), max: round(broadcast.reduce((max, value) => Math.max(max, value), 0)) },
  ackMs: { p50: round(percentile(acks, 0.5)), p95: round(percentile(acks, 0.95)) },
  motion: {
    sent: motionSent,
    relayed: motionRelay.length,
    perSecondOut: round(motionRelay.length / elapsed, 0),
    relayMs: { p50: round(percentile(motionRelay, 0.5)), p95: round(percentile(motionRelay, 0.95)), p99: round(percentile(motionRelay, 0.99)) },
    droppedRate: after.metrics.motionDroppedRate,
    skippedBackpressure: after.metrics.motionSkippedBackpressure,
  },
  server: {
    journalP50Ms: after.metrics.journal_latency_p50_ms,
    journalP95Ms: after.metrics.journal_latency_p95_ms,
    checkpointP95Ms: after.metrics.checkpoint_p95_ms,
    eventLoopDelayP99Ms: after.metrics.event_loop_delay_p99_ms,
    eventLoopDelayMaxMs: after.metrics.event_loop_delay_max_ms,
    journalErrors: after.metrics.journalErrors,
    checkpointErrors: after.metrics.checkpointErrors,
    shadowChecks: after.metrics.shadowChecks,
    shadowMismatches: after.metrics.shadowMismatches,
    errors: after.errors,
  },
  memory: {
    gc: after.gc,
    heapBaselineMb: round(baseline.metrics.heap_used_bytes / 1e6),
    heapLoadedMb: round(loaded.metrics.heap_used_bytes / 1e6),
    heapAfterLoadMb: round(after.metrics.heap_used_bytes / 1e6),
    heapRoomsOnlyMb: round(roomsOnly.metrics.heap_used_bytes / 1e6),
    rssAfterLoadMb: round(after.metrics.rss_bytes / 1e6),
    perRoomKb: round(memoryPerRoom / 1024, 0),
    perRoomVsDocument: round(memoryPerRoom / documentBytes, 2),
    perConnectionKb: round(memoryPerClient / 1024, 0),
  },
};
console.log(JSON.stringify(report, null, 2));

const failures: string[] = [];
const check = (condition: boolean, label: string) => {
  console.error(`${condition ? '✅' : '❌'} ${label}`);
  if (!condition) failures.push(label);
};
check(report.broadcastMs.p95 < TARGETS.broadcastP95Ms, `diffusion p95 ${report.broadcastMs.p95} ms (< ${TARGETS.broadcastP95Ms})`);
if (MOTION_HZ > 0) {
  check(report.motion.relayMs.p95 < TARGETS.broadcastP95Ms, `relais motion p95 ${report.motion.relayMs.p95} ms (< ${TARGETS.broadcastP95Ms}), ${report.motion.perSecondOut} messages/s en sortie`);
  check(report.motion.droppedRate === 0, `aucun motion jeté au débit (${report.motion.droppedRate})`);
}
check((report.server.journalP95Ms ?? Infinity) < TARGETS.journalP95Ms, `journal durable p95 ${report.server.journalP95Ms} ms (< ${TARGETS.journalP95Ms})`);
check(report.memory.perRoomVsDocument <= TARGETS.memoryPerDocument, `mémoire par salle ${report.memory.perRoomKb} Ko = ${report.memory.perRoomVsDocument} × le document (≤ ${TARGETS.memoryPerDocument})`);
check(report.throughput.rejected === 0, `aucun lot refusé (${report.throughput.rejected})`);
check(report.server.journalErrors === 0 && report.server.checkpointErrors === 0 && report.server.errors.length === 0, 'aucune erreur serveur');
check(report.server.shadowChecks > 0 && report.server.shadowMismatches === 0, `validation fantôme : ${report.server.shadowChecks} contrôles, ${report.server.shadowMismatches} écart`);
process.exitCode = failures.length > 0 ? 1 : 0;
