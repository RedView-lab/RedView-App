/**
 * Co-édition (src/features/collab, moteur façon Figma) : régressions et
 * mesures hors ligne. Sortie non nulle au premier échec.
 *
 *  1. tracé en segments : découpage, fenêtre modifiée (octets envoyés, temps),
 *     références gardées chez l'autre éditeur ;
 *  2. document distant recomposé avec la vue et le travail local, et ce que
 *     coûte cette recomposition au ProjectStore (compose + normalise +
 *     partage) sur un tracé de 100 000 points, à chaque lot reçu ;
 *  3. simulateur déterministe sur de nombreuses graines (réseau perturbé,
 *     coupures, arrêts brutaux du serveur, onglets rechargés qui modifient
 *     pendant la connexion et reprennent leurs lots non écrits) :
 *     convergence, journal relu = mémoire, aucune modification perdue ;
 *  4. débit de la salle (lots par seconde, un seul fil).
 *
 *   npx tsx script-test-bench/test-collab.ts [--seeds=10] [--workers=N]   (40 graines pour une passe profonde)
 */
import { fork } from 'node:child_process';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { canonicalJson } from '../src/features/itineraryPanel/lib/project/canonicalJson.ts';
import {
  composeProject,
  extractProjectLocalWork,
  extractProjectView,
  toProjectDocument,
  type ProjectDocument,
} from '../src/features/itineraryPanel/lib/project/layers.ts';
import { normalizeItineraryProject } from '../src/features/itineraryPanel/lib/project/defaultState.ts';
import { shareProjectStructure } from '../src/features/itineraryPanel/context/ProjectStore/historyDocument.ts';
import type { Itinerary, ItineraryProject } from '../src/features/itineraryPanel/types/index.ts';
import { CollabClient } from '../src/features/collab/client/collabClient.ts';
import type { ClientMessage, ServerMessage } from '../src/features/collab/protocol.ts';
import { Room } from '../src/features/collab/room/room.ts';
import { RoomState } from '../src/features/collab/room/roomState.ts';
import { routeChunkBounds, ROUTE_CHUNK_MAX_POINTS, ROUTE_CHUNK_MIN_POINTS } from '../src/features/collab/routeChunks.ts';
import { routePoints, sampleDocument } from '../src/features/collab/sim/fixtures.ts';
import { Scheduler } from '../src/features/collab/sim/scheduler.ts';
import { runSimulation, type SimulationOptions, type SimulationReport } from '../src/features/collab/sim/simulator.ts';

let failures = 0;
function assert(condition: boolean, message: string): void {
  if (!condition) {
    console.error(`❌ FAILED: ${message}`);
    failures += 1;
    process.exitCode = 1;
    return;
  }
  console.log(`✅ PASSED: ${message}`);
}

const seedCount = Number(process.argv.find((arg) => arg.startsWith('--seeds='))?.slice('--seeds='.length) ?? 10);
/**
 * Processus de calcul des graines (déterministes et indépendantes : même
 * rapport quel que soit le processus). Défaut : cœurs disponibles - 1, 8 au
 * plus ; `--workers=1` : tout dans ce processus, comme avant.
 */
const workerCount = Math.max(1, Number(process.argv.find((arg) => arg.startsWith('--workers='))?.slice('--workers='.length)
  ?? Math.min(8, Math.max(1, os.availableParallelism() - 1))));

type SeedResult = { report: SimulationReport; ms: number };

/** Rapports des graines, dans l'ordre de `jobs`. */
async function runSeeds(jobs: SimulationOptions[]): Promise<SeedResult[]> {
  if (workerCount === 1) {
    return jobs.map((options) => {
      const started = performance.now();
      return { report: runSimulation(options), ms: performance.now() - started };
    });
  }
  const results: SeedResult[] = new Array(jobs.length);
  let next = 0;
  const workerPath = path.join(path.dirname(fileURLToPath(import.meta.url)), 'collab-sim-worker.ts');
  await Promise.all(Array.from({ length: Math.min(workerCount, jobs.length) }, () => new Promise<void>((resolve, reject) => {
    const worker = fork(workerPath, [], { execArgv: ['--import', 'tsx'], stdio: ['ignore', 'inherit', 'inherit', 'ipc'] });
    const dispatch = () => {
      if (next >= jobs.length) {
        worker.disconnect();
        resolve();
        return;
      }
      const job = next;
      next += 1;
      worker.send({ type: 'run', job, options: jobs[job] });
    };
    worker.on('message', (message: { type: string; job: number; report: SimulationReport; ms: number }) => {
      if (message.type !== 'report') return;
      results[message.job] = { report: message.report, ms: message.ms };
      dispatch();
    });
    worker.on('error', reject);
    worker.on('exit', (code) => {
      if (code !== 0 && next < jobs.length) reject(new Error(`processus de calcul arrêté (code ${code})`));
    });
    dispatch();
  })));
  return results;
}
const same = (a: unknown, b: unknown) => canonicalJson(a) === canonicalJson(b);

function mapItinerary(doc: ProjectDocument, id: string, fn: (it: Itinerary) => Itinerary): ProjectDocument {
  return { ...doc, itineraries: doc.itineraries.map((it) => (it.id === id ? (fn(it as Itinerary) as typeof it) : it)) };
}
const getItinerary = (doc: ProjectDocument, id: string) => doc.itineraries.find((it) => it.id === id) as Itinerary | undefined;

/** Salle + clients reliés sans latence ; octets envoyés par client comptés. */
function session(document: ProjectDocument, names: string[]) {
  const scheduler = new Scheduler();
  const room = new Room(RoomState.fromDocument(document, 0), { epoch: 'bench', now: () => scheduler.now() });
  const sent = new Map<string, number>();
  const clients = names.map((clientId) => {
    let online = false;
    const inbox: string[] = [];
    const client = new CollabClient({
      clientId,
      clock: scheduler,
      transport: {
        isOnline: () => online,
        send: (message: ClientMessage) => {
          const wire = JSON.stringify(message);
          sent.set(clientId, (sent.get(clientId) ?? 0) + wire.length);
          room.handle(clientId, JSON.parse(wire) as ClientMessage);
        },
        requestFlush: () => undefined,
        resync: () => undefined,
      },
    });
    const deliver = () => {
      while (inbox.length > 0) {
        const message = JSON.parse(inbox.shift()!) as ServerMessage;
        if (message.type === 'welcome') online = true;
        client.receive(message);
      }
    };
    room.join({ clientId, userId: `u-${clientId}`, send: (message) => inbox.push(JSON.stringify(message)) }, { epoch: null, lastSeq: null });
    deliver();
    return { client, deliver };
  });
  const settle = () => {
    for (let round = 0; round < 6; round += 1) {
      for (const { client } of clients) client.flush();
      for (const { deliver } of clients) deliver();
    }
  };
  return { room, clients: clients.map(({ client }) => client), settle, sent };
}

// ── 1. Tracé en segments ────────────────────────────────────────────────────
{
  const points = routePoints(100_000);
  const bounds = routeChunkBounds(points);
  const sizes = bounds.map((end, i) => end - (i ? bounds[i - 1] : 0));
  assert(
    sizes.slice(0, -1).every((size) => size >= ROUTE_CHUNK_MIN_POINTS && size <= ROUTE_CHUNK_MAX_POINTS),
    `découpage : ${bounds.length} segments de ${Math.min(...sizes)} à ${Math.max(...sizes)} points`,
  );

  const document = mapItinerary(sampleDocument(0), 'it-1', (it) => ({ ...it, gpxRoute: { name: null, source: 'brouter', points, routedInputsKey: 'k1' } } as Itinerary));
  const { clients: [a, b], settle, sent } = session(document, ['A', 'B']);
  const fullJson = JSON.stringify(points).length;
  sent.set('A', 0);
  const t0 = performance.now();
  a.pushLocalDocument(mapItinerary(a.getDocument(), 'it-1', (it) => {
    const patched = [...it.gpxRoute!.points];
    patched.splice(50_000, 400, ...routePoints(420, 999).map((p, i) => ({ ...p, lat: p.lat + 0.01, distanceM: 985_000 + i })));
    return { ...it, gpxRoute: { ...it.gpxRoute!, points: patched, routedInputsKey: 'k2' } } as Itinerary;
  }), 'background');
  const writeMs = performance.now() - t0;
  settle();
  assert(same(getItinerary(b.getDocument(), 'it-1')!.gpxRoute, getItinerary(a.getDocument(), 'it-1')!.gpxRoute), 'tracé de 100 000 points modifié par A : identique chez B');
  const bytes = sent.get('A') ?? 0;
  assert(bytes < fullJson * 0.03, `fenêtre de 400 points modifiée : ${(bytes / 1024).toFixed(0)} Ko envoyés pour un tracé de ${(fullJson / 1e6).toFixed(1)} Mo (< 3 %)`);
  assert(writeMs < 400, `écriture locale du tracé modifié : ${writeMs.toFixed(0)} ms (< 400)`);

  const before = b.getDocument();
  const t1 = performance.now();
  a.pushLocalDocument(mapItinerary(a.getDocument(), 'it-1', (it) => ({ ...it, name: 'Renommé' })), 'user');
  settle();
  const remoteMs = performance.now() - t1;
  const after = b.getDocument();
  assert(getItinerary(after, 'it-1')!.gpxRoute!.points === getItinerary(before, 'it-1')!.gpxRoute!.points, 'renommage distant : les points du tracé gardent leur référence');
  assert(getItinerary(after, 'it-2') === getItinerary(before, 'it-2'), 'itinéraire non touché : même objet');
  assert(remoteMs < 50, `renommage : envoi, application serveur et rematérialisation chez B en ${remoteMs.toFixed(1)} ms (< 50)`);

  // Ce que fait ensuite le ProjectStore de B à chaque lot reçu (jusqu'à 30 par seconde et par éditeur).
  let project = normalizeItineraryProject(composeProject(b.getDocument(), null, null) as ItineraryProject);
  const times: number[] = [];
  for (let index = 0; index < 100; index += 1) {
    a.pushLocalDocument(mapItinerary(a.getDocument(), 'it-1', (it) => ({ ...it, name: `Renommé ${index}` })), 'user');
    settle();
    const start = performance.now();
    const composed = composeProject(b.getDocument(), extractProjectView(project), extractProjectLocalWork(project));
    project = shareProjectStructure(project, normalizeItineraryProject(composed));
    times.push(performance.now() - start);
  }
  const p95 = [...times].sort((x, y) => x - y)[Math.floor(0.95 * (times.length - 1))];
  // Avant le 06/10/2026 : ≈ 6 ms (altitudes du tracé revérifiées point par point à chaque fois).
  assert(p95 < 1, `lot reçu, tracé de 100 000 points : recomposition du projet en ${p95.toFixed(2)} ms p95 (< 1)`);
}

// ── 2. Document distant recomposé avec la vue et le travail local ───────────
{
  const local = composeProject(sampleDocument(200), null, null);
  const withViewAndWork: typeof local = {
    ...local,
    activeItineraryId: 'it-2',
    activeMode: 'poi',
    itineraries: local.itineraries.map((it) => (it.id === 'it-1'
      ? { ...it, opacity: 40, pendingRoutePatch: { start: { lat: 1, lon: 1, kind: 'start' as const }, end: { lat: 2, lon: 2, kind: 'end' as const }, via: [] } }
      : it)),
  };
  const remote = mapItinerary(toProjectDocument(withViewAndWork), 'it-1', (it) => ({ ...it, name: 'Renommé ailleurs' }));
  const next = composeProject(remote, extractProjectView(withViewAndWork), extractProjectLocalWork(withViewAndWork));
  const it1 = next.itineraries.find((it) => it.id === 'it-1')!;
  assert(
    it1.name === 'Renommé ailleurs' && it1.opacity === 40 && !!it1.pendingRoutePatch && next.activeMode === 'poi' && next.activeItineraryId === 'it-2',
    'modification distante appliquée : vue (opacité, mode, itinéraire actif) et édition en attente de cet appareil gardées',
  );
}

// ── 3. Simulateur : réseau perturbé, coupures, arrêts du serveur ────────────
{
  const profiles: Array<{ label: string; options: Omit<SimulationOptions, 'seed'> }> = [
    { label: '3 éditeurs, réseau ordinaire', options: { clients: 3, durationMs: 30_000 } },
    { label: '5 éditeurs, coupures et arrêts fréquents', options: { clients: 5, durationMs: 30_000, disconnectRate: 0.3, crashRate: 0.06, latencyMs: [20, 600] } },
    { label: '2 éditeurs, rafales de modifications', options: { clients: 2, durationMs: 20_000, editRate: 20, disconnectRate: 0.1 } },
    {
      label: '4 éditeurs, onglets rechargés souvent (modifications pendant la connexion, lots non écrits repris)',
      options: { clients: 4, durationMs: 30_000, reloadRate: 0.4, disconnectRate: 0.1, crashRate: 0.03, latencyMs: [20, 400] },
    },
  ];
  const jobs = profiles.flatMap((profile, index) => Array.from({ length: seedCount }, (_, seed) => ({ profile: index, options: { seed: seed + 1, ...profile.options } })));
  const wallStart = performance.now();
  const results = await runSeeds(jobs.map((job) => job.options));
  const wallSeconds = (performance.now() - wallStart) / 1000;
  for (const [index, profile] of profiles.entries()) {
    const totals = { edits: 0, undos: 0, redos: 0, batches: 0, disconnects: 0, crashes: 0, reloads: 0, preWelcomeActions: 0, snapshots: 0, rejections: 0 };
    const failed: string[] = [];
    let computeMs = 0;
    for (const [jobIndex, job] of jobs.entries()) {
      if (job.profile !== index) continue;
      const { report, ms } = results[jobIndex];
      computeMs += ms;
      for (const key of Object.keys(totals) as Array<keyof typeof totals>) totals[key] += report.stats[key];
      if (report.failures.length > 0) failed.push(`graine ${report.seed} : ${report.failures.slice(0, 3).join(' | ')}`);
    }
    const seconds = computeMs / 1000;
    for (const failure of failed.slice(0, 5)) console.error(`   ${failure}`);
    assert(
      failed.length === 0,
      `${profile.label} — ${seedCount} graines (calcul ${seconds.toFixed(1)} s) : ${totals.edits} modifications, ${totals.undos} annuler, ${totals.redos} rétablir, `
        + `${totals.batches} lots, ${totals.disconnects} coupures, ${totals.crashes} arrêts serveur, ${totals.reloads} rechargements `
        + `(${totals.preWelcomeActions} actions pendant la connexion), ${totals.snapshots} états complets ; `
        + 'convergence, journal = mémoire, aucune modification perdue',
    );
    assert(totals.rejections === 0, `${profile.label} : aucun lot refusé par le serveur (${totals.rejections})`);
  }
  console.log(`   simulateur : ${jobs.length} graines en ${wallSeconds.toFixed(1)} s sur ${Math.min(workerCount, jobs.length)} processus`);
}

// ── 4. Débit de la salle ────────────────────────────────────────────────────
{
  const state = RoomState.fromDocument(sampleDocument(2_000), 0);
  const room = new Room(state, { epoch: 'debit', now: () => 0 });
  const peers = Array.from({ length: 5 }, (_, index) => ({ clientId: `c${index}`, userId: `u${index}`, send: () => undefined }));
  for (const peer of peers) room.join(peer, { epoch: null, lastSeq: null });
  const itineraryIds = ['it-1', 'it-2'];
  const count = 10_000;
  const t0 = performance.now();
  for (let index = 0; index < count; index += 1) {
    const peer = peers[index % peers.length];
    const id = `p/itineraries:${itineraryIds[index % 2]}`;
    room.handle(peer.clientId, {
      type: 'batch',
      clientSeq: Math.floor(index / peers.length) + 1,
      ops: [{ t: 's', id, k: 'priorities.elevation', v: index % 100 }, { t: 's', id, k: 'name', v: `n${index}` }],
      blobs: {},
    });
  }
  const perBatchUs = ((performance.now() - t0) * 1000) / count;
  assert(room.state.seq === count, `${count} lots appliqués dans l'ordre (séquence ${room.state.seq})`);
  assert(perBatchUs < 500, `salle : ${perBatchUs.toFixed(0)} µs par lot (validation + application + diffusion à 5 clients, < 500 µs)`);
}

if (failures > 0) {
  console.error(`\n${failures} échec(s)`);
} else {
  console.log('\nCo-édition : tout est vert.');
}
