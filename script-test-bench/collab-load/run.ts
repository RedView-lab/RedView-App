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
 * Les clients tournent dans `--workers` processus (clients.ts, salles
 * réparties) et compressent leurs messages comme un navigateur
 * (`--clientDeflate=chrome`, voir plus bas).
 *
 * `--storm` : après la charge, le serveur redémarre comme à un déploiement
 * (arrêt propre en 1012, nouveau serveur sur le même stockage) et tous les
 * clients reviennent en même temps, avec l'attente aléatoire du vrai client :
 * temps de retour (fermeture → `welcome`), taille des `welcome`, retard
 * maximal de la boucle d'événements et pics de mémoire du nouveau serveur.
 * Cible : tous revenus, aucune erreur. La mémoire par salle n'est alors pas
 * jugée (salles rechargées de leur état durable, sans journal de rattrapage).
 *
 *   npx tsx script-test-bench/collab-load/run.ts [--rooms=50 --clients=5 --rate=20 --seconds=30 --route=1500 --motion=30 --motionShare=0.2 --workers=4 --clientDeflate=chrome|small|off]
 */
import { fork, type ChildProcess } from 'node:child_process';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import type { ClientsConfig, ClientsResults, StormStatus } from './clients.ts';
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
/**
 * Processus de clients (salles réparties entre eux) : le générateur de charge
 * ne doit pas être le goulot. Un quart des cœurs logiques par défaut (le
 * serveur, son pool zlib et la machine gardent le reste), 1 à 8.
 */
const WORKERS = Math.max(1, Math.min(ROOMS, arg('workers', Math.min(8, Math.max(1, Math.floor(os.availableParallelism() / 4))))));
/**
 * Compression des messages des clients. `chrome` (défaut) : comme un
 * navigateur — Chromium compresse chaque message quand `permessage-deflate`
 * est négocié, sans seuil (`WebSocketDeflatePredictorImpl::Predict` répond
 * toujours DEFLATE), donc le serveur décompresse chaque lot et chaque
 * `motion`. `small` : seuil de 1 Ko du client `ws` (ancien comportement du
 * banc, qui ne mesurait pas cette décompression). `off` : pas d'extension.
 */
const CLIENT_DEFLATE = process.argv.find((value) => value.startsWith('--clientDeflate='))?.slice('--clientDeflate='.length) ?? 'chrome';
const CLIENT_DEFLATE_OPTION: ClientsConfig['deflate'] = CLIENT_DEFLATE === 'off' ? false : CLIENT_DEFLATE === 'small' ? true : { threshold: 0 };

const STORM = process.argv.includes('--storm');
/** Tempête : délai laissé à tous les clients pour revenir. */
const STORM_TIMEOUT_MS = 120_000;

const TARGETS = { broadcastP95Ms: 50, journalP95Ms: 600, memoryPerDocument: 2 };

type Metrics = Record<string, number>;

function percentile(values: readonly number[], q: number): number {
  if (values.length === 0) return 0;
  const sorted = Float64Array.from(values).sort();
  return sorted[Math.min(sorted.length - 1, Math.floor(q * sorted.length))];
}

const round = (value: number, digits = 1) => Math.round(value * 10 ** digits) / 10 ** digits;

function waitFor<T>(process: ChildProcess, reply: string): Promise<T> {
  return new Promise((resolve) => {
    const listener = (message: { type: string } & T) => {
      if (message.type !== reply) return;
      process.off('message', listener);
      resolve(message);
    };
    process.on('message', listener);
  });
}

// ── Serveur ──────────────────────────────────────────────────────────────────
const here = path.dirname(fileURLToPath(import.meta.url));
const child: ChildProcess = fork(path.join(here, 'server.ts'), [], {
  execArgv: ['--import', 'tsx', '--expose-gc'],
  stdio: ['ignore', 'inherit', 'inherit', 'ipc'],
});

function request<T>(type: string, reply: string): Promise<T> {
  const answer = waitFor<T>(child, reply);
  if (type) child.send({ type });
  return answer;
}

const { port } = await request<{ port: number }>('', 'ready');
const measure = () => request<{ metrics: Metrics; errors: string[]; gc: boolean }>('measure', 'metrics');
const baseline = await measure();

// ── Clients légers (processus séparés) ───────────────────────────────────────
const documentBytes = Buffer.byteLength(JSON.stringify(sampleDocument(ROUTE)), 'utf8');
const workers = Array.from({ length: WORKERS }, () => fork(path.join(here, 'clients.ts'), [], {
  execArgv: ['--import', 'tsx'],
  stdio: ['ignore', 'inherit', 'inherit', 'ipc'],
}));
/** Envoie `type` à tous les processus de clients et attend `reply` de chacun. */
async function all<T>(type: string, reply: string, payload: (index: number) => object = () => ({})): Promise<T[]> {
  const answers = workers.map((worker) => waitFor<T>(worker, reply));
  workers.forEach((worker, index) => worker.send({ type, ...payload(index) }));
  return Promise.all(answers);
}
const roomsPerWorker = Math.ceil(ROOMS / WORKERS);
await all('config', 'seeded', (index): { config: ClientsConfig } => ({
  config: {
    port,
    from: Math.min(ROOMS, index * roomsPerWorker),
    to: Math.min(ROOMS, (index + 1) * roomsPerWorker),
    clients: CLIENTS,
    rate: RATE,
    route: ROUTE,
    motionHz: MOTION_HZ,
    motionShare: MOTION_SHARE,
    deflate: CLIENT_DEFLATE_OPTION,
  },
}));
await all('open', 'opened');
const loaded = await measure();
const motionSenders = ROOMS * (MOTION_HZ > 0 ? Math.round(CLIENTS * MOTION_SHARE) : 0);
console.error(`${ROOMS} salles × ${CLIENTS} clients connectés (${WORKERS} processus de clients, compression ${CLIENT_DEFLATE}) ; document ${(documentBytes / 1024).toFixed(0)} Ko ; charge ${ROOMS * CLIENTS * RATE} lots/s + ${motionSenders * MOTION_HZ} motion/s (relayés ×${CLIENTS - 1}) pendant ${SECONDS} s…`);

const started = performance.now();
for (const worker of workers) worker.send({ type: 'start' });
await new Promise((resolve) => setTimeout(resolve, SECONDS * 1000));
// Arrêt, puis fin de la diffusion (3 s) dans chaque processus de clients.
const stopped = all<{ results: ClientsResults }>('stop', 'results');
const elapsed = (performance.now() - started) / 1000;
const parts = (await stopped).map((answer) => answer.results);
const broadcast = parts.flatMap((part) => part.broadcast);
const acks = parts.flatMap((part) => part.acks);
/** Relais `motion` : envoi → réception (même processus : horloge commune). */
const motionRelay = parts.flatMap((part) => part.motionRelay);
const sum = (key: 'batchesSent' | 'motionSent' | 'received' | 'rejected') => parts.reduce((total, part) => total + part[key], 0);
const batchesSent = sum('batchesSent');
const motionSent = sum('motionSent');
const received = sum('received');
const rejected = sum('rejected');
// Journal terminé.
const after = await measure();

// ── Tempête de reconnexions (redémarrage du serveur) ─────────────────────────
let storm: null | {
  total: number;
  rejoined: number;
  durationMs: number;
  stopMs: number;
  rejoinMs: { p50: number; p95: number; max: number };
  welcomeKb: { mean: number; max: number };
  welcomeCompressed: number;
  attempts: number;
  eventLoopDelayMaxMs: number;
  eventLoopDelayP99Ms: number;
  peakHeapMb: number;
  peakRssMb: number;
  errors: string[];
} = null;
if (STORM) {
  await all('storm-arm', 'armed');
  const stormStarted = performance.now();
  const { stoppedMs } = await request<{ stoppedMs: number }>('restart', 'restarted');
  let statuses: StormStatus[] = [];
  for (;;) {
    statuses = (await all<{ storm: StormStatus }>('storm-status', 'storm')).map((answer) => answer.storm);
    const done = statuses.every((status) => status.rejoined >= status.total);
    if (done || performance.now() - stormStarted > STORM_TIMEOUT_MS) break;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  const durationMs = performance.now() - stormStarted;
  const restarted = await measure();
  const rejoinMs = statuses.flatMap((status) => status.rejoinMs);
  const welcomeBytes = statuses.flatMap((status) => status.welcomeBytes);
  storm = {
    total: statuses.reduce((total, status) => total + status.total, 0),
    rejoined: statuses.reduce((total, status) => total + status.rejoined, 0),
    durationMs: round(durationMs, 0),
    stopMs: round(stoppedMs, 0),
    rejoinMs: { p50: round(percentile(rejoinMs, 0.5), 0), p95: round(percentile(rejoinMs, 0.95), 0), max: round(rejoinMs.reduce((max, value) => Math.max(max, value), 0), 0) },
    welcomeKb: {
      mean: round(welcomeBytes.reduce((total, value) => total + value, 0) / Math.max(1, welcomeBytes.length) / 1024),
      max: round(welcomeBytes.reduce((max, value) => Math.max(max, value), 0) / 1024),
    },
    welcomeCompressed: statuses.reduce((total, status) => total + status.welcomeCompressed, 0),
    attempts: statuses.reduce((total, status) => total + status.attempts, 0),
    eventLoopDelayMaxMs: restarted.metrics.event_loop_delay_max_ms,
    eventLoopDelayP99Ms: restarted.metrics.event_loop_delay_p99_ms,
    peakHeapMb: round(restarted.metrics.peak_heap_mb),
    peakRssMb: round(restarted.metrics.peak_rss_mb),
    errors: restarted.errors,
  };
}
// Clients partis, salles encore chargées (déchargement après 60 s d'inactivité) : mémoire des salles seules.
await all('close', 'closed');
for (const worker of workers) worker.kill();
await new Promise((resolve) => setTimeout(resolve, 1_500));
const roomsOnly = await measure();
child.send({ type: 'stop' });

// ── Rapport ──────────────────────────────────────────────────────────────────
const memoryPerRoom = (roomsOnly.metrics.heap_used_bytes - baseline.metrics.heap_used_bytes) / ROOMS;
const memoryPerClient = (after.metrics.heap_used_bytes - roomsOnly.metrics.heap_used_bytes) / (ROOMS * CLIENTS);
const report = {
  config: { rooms: ROOMS, clients: CLIENTS, rate: RATE, seconds: SECONDS, documentBytes, motionHz: MOTION_HZ, motionSenders, clientDeflate: CLIENT_DEFLATE },
  throughput: {
    batchesSent,
    batchesPerSecond: round(batchesSent / elapsed, 0),
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
    /** Temps CPU du serveur pendant la charge (fil principal + pool zlib), en % d'un cœur — robuste là où la latence dépend de la machine. */
    cpuPercent: round((100 * (after.metrics.cpu_user_ms + after.metrics.cpu_system_ms - loaded.metrics.cpu_user_ms - loaded.metrics.cpu_system_ms)) / (elapsed * 1000 + 3_000)),
    cpuSystemPercent: round((100 * (after.metrics.cpu_system_ms - loaded.metrics.cpu_system_ms)) / (elapsed * 1000 + 3_000)),
    journalErrors: after.metrics.journalErrors,
    checkpointErrors: after.metrics.checkpointErrors,
    shadowChecks: after.metrics.shadowChecks,
    shadowMismatches: after.metrics.shadowMismatches,
    errors: after.errors,
  },
  memory: {
    gc: after.gc,
    heapBaselineMb: round(baseline.metrics.heap_used_bytes / 1e6),
    rssBaselineMb: round(baseline.metrics.rss_bytes / 1e6),
    heapLoadedMb: round(loaded.metrics.heap_used_bytes / 1e6),
    heapAfterLoadMb: round(after.metrics.heap_used_bytes / 1e6),
    heapRoomsOnlyMb: round(roomsOnly.metrics.heap_used_bytes / 1e6),
    rssAfterLoadMb: round(after.metrics.rss_bytes / 1e6),
    perRoomKb: round(memoryPerRoom / 1024, 0),
    perRoomVsDocument: round(memoryPerRoom / documentBytes, 2),
    perConnectionKb: round(memoryPerClient / 1024, 0),
  },
  ...(storm ? { storm } : {}),
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
if (!storm) check(report.memory.perRoomVsDocument <= TARGETS.memoryPerDocument, `mémoire par salle ${report.memory.perRoomKb} Ko = ${report.memory.perRoomVsDocument} × le document (≤ ${TARGETS.memoryPerDocument})`);
check(report.throughput.rejected === 0, `aucun lot refusé (${report.throughput.rejected})`);
check(report.server.journalErrors === 0 && report.server.checkpointErrors === 0 && report.server.errors.length === 0, 'aucune erreur serveur');
check(report.server.shadowChecks > 0 && report.server.shadowMismatches === 0, `validation fantôme : ${report.server.shadowChecks} contrôles, ${report.server.shadowMismatches} écart`);
if (storm) {
  check(storm.rejoined === storm.total, `tempête : ${storm.rejoined}/${storm.total} clients revenus en ${(storm.durationMs / 1000).toFixed(1)} s (p95 ${storm.rejoinMs.p95} ms, boucle d'événements jusqu'à ${storm.eventLoopDelayMaxMs} ms, tas ${storm.peakHeapMb} Mo)`);
  check(storm.errors.length === 0, 'tempête : aucune erreur serveur');
}
process.exitCode = failures.length > 0 ? 1 : 0;
