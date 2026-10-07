/**
 * RedView Test-Bench : exposition avalanche du viewer LiDAR (AutoATES v2.0 :
 * zones de départ floues, écoulement Flow-Py, classe ATES), sur terrains
 * synthétiques dont la réponse est connue. Pur, sans navigateur.
 *
 * Critères durs (code de sortie ≠ 0) :
 *  - ligne d'énergie : sur une face plane de 38° suivie d'un replat, la portée
 *    s'arrête où la ligne tirée du sommet à α (30° fréquent, 18° rare)
 *    rencontre le sol (±2 cellules), l'angle de parcours au point vaut
 *    atan(dénivelé / distance) (±1,5°) ;
 *  - classes ATES le long du replat : seuils d'angle 24° / 33° (Toft et al.,
 *    2024), non croissantes en s'éloignant, 0 au-delà de toute portée ;
 *  - terrain plat : classe 0, rien n'atteint le point ;
 *  - forêt dense (Table 3) : classe abaissée sur la zone d'écoulement, et une
 *    face boisée à 80 % n'est plus une zone de départ fréquente ;
 *  - contre-pente : l'écoulement remonte un versant opposé tant que zδ le permet ;
 *  - abri au vent (Plattner) : positif dans un creux, négatif sur une crête ;
 *  - exactitude : l'arrêt anticipé et l'élagage des cellules de départ donnent
 *    exactement le résultat de Flow-Py exhaustif ;
 *  - temps : un point sous une face de 3 km × 3 km (300 × 300 cellules),
 *    calcul complet (sans atteindre le plafond de Flow-Py) en < 10 s sur le
 *    pool de workers du viewer (cœurs − 1, au plus 8 ; ici des worker_threads
 *    avec le même code) ; le temps sur un seul thread est donné pour info.
 *
 * Usage : npm run bench:avalanche [-- --quick]
 */
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { performance } from 'node:perf_hooks';
import { availableParallelism } from 'node:os';
import { Worker } from 'node:worker_threads';
import {
  computeAvalancheTerrain,
  computeAvalancheTerrainWith,
  type AvalancheGridInput,
} from '../src/features/lidar/viewer/tools/terrain/avalanche/exposure.ts';
import { runFlowPyInPool, type FlowPyPort, type FlowPyWorkerResponse } from '../src/features/lidar/viewer/tools/terrain/avalanche/flowPyPool.ts';
import { prepareFlowPyTerrain, runFlowPyToTarget } from '../src/features/lidar/viewer/tools/terrain/avalanche/flowPy.ts';
import { AVALANCHE_SCENARIOS } from '../src/features/lidar/viewer/tools/terrain/avalanche/params.ts';
import { computeReleaseAreas, WindShelterField } from '../src/features/lidar/viewer/tools/terrain/avalanche/releaseArea.ts';
import { BenchmarkSuite } from './core/harness.ts';

const CELL = 10;
const DEG = Math.PI / 180;

interface Check {
  fixture: string;
  name: string;
  ok: boolean;
  detail: string;
}

const checks: Check[] = [];
function check(fixture: string, name: string, ok: boolean, detail = ''): void {
  checks.push({ fixture, name, ok, detail });
  console.log(`${ok ? '  OK  ' : '  FAIL'} ${name}${detail ? ` — ${detail}` : ''}`);
}

const round = (value: number, digits = 1) => Number(value.toFixed(digits));

/** Grid from an altitude function of (x, y) in metres, with the viewer's Horn slope. */
function makeGrid(width: number, height: number, altitudeAt: (x: number, y: number) => number): AvalancheGridInput {
  const altitude = new Float32Array(width * height);
  for (let r = 0; r < height; r++) for (let c = 0; c < width; c++) altitude[r * width + c] = altitudeAt(c * CELL, r * CELL);
  const slopeDeg = new Float32Array(width * height).fill(Number.NaN);
  for (let row = 1; row < height - 1; row++) {
    for (let col = 1; col < width - 1; col++) {
      const i = row * width + col;
      const a = altitude[i + width - 1]!, b = altitude[i + width]!, c = altitude[i + width + 1]!;
      const d = altitude[i - 1]!, f = altitude[i + 1]!;
      const g = altitude[i - width - 1]!, h = altitude[i - width]!, k = altitude[i - width + 1]!;
      const gx = ((c + 2 * f + k) - (a + 2 * d + g)) / (8 * CELL);
      const gy = ((a + 2 * b + c) - (g + 2 * h + k)) / (8 * CELL);
      slopeDeg[i] = Math.atan(Math.hypot(gx, gy)) / DEG;
    }
  }
  return { width, height, cell: CELL, originX: 0, originY: 0, altitude, slopeDeg };
}

/** Small deterministic micro-relief: flows are never perfectly degenerate. */
const rough = (x: number, y: number) => 0.3 * Math.sin(y * 0.07) + 0.2 * Math.cos(x * 0.13);

// ── Fixtures ────────────────────────────────────────────────────────────────

const FACE_DEG = 38;
const FOOT_X = 600;
const FACE_H = FOOT_X * Math.tan(FACE_DEG * DEG);

/** 38° planar face (x 0 → 600 m), then a flat floor. */
function faceAndFloor(): AvalancheGridInput {
  return makeGrid(160, 60, (x, y) => (x < FOOT_X ? 1000 + FACE_H - x * Math.tan(FACE_DEG * DEG) : 1000) + rough(x, y));
}

/** Same face, a 200 m floor, then a 25° counter-slope. */
function faceAndCounterSlope(): AvalancheGridInput {
  return makeGrid(140, 60, (x, y) => {
    let z = 1000;
    if (x < FOOT_X) z += FACE_H - x * Math.tan(FACE_DEG * DEG);
    else if (x > FOOT_X + 200) z += (x - FOOT_X - 200) * Math.tan(25 * DEG);
    return z + rough(x, y);
  });
}

// ── Checks ──────────────────────────────────────────────────────────────────

function energyLineChecks(): void {
  console.log('\n■ Face 38° + replat : portée sur la ligne d\'énergie');
  const grid = faceAndFloor();
  const wind = new WindShelterField(grid);
  const reachTheory = {
    typical: FACE_H / Math.tan(AVALANCHE_SCENARIOS.typical.alphaDeg * DEG),
    infrequent: FACE_H / Math.tan(AVALANCHE_SCENARIOS.infrequent.alphaDeg * DEG),
  };
  const xs: number[] = [];
  for (let x = 650; x <= 1550; x += 10) xs.push(x);
  const results = xs.map((x) => ({ x, r: computeAvalancheTerrain({ grid, canopyPct: null, projX: x, projY: 300 }, wind)! }));
  for (const id of ['typical', 'infrequent'] as const) {
    const reached = results.filter(({ r }) => r.scenarios[id].reached).map(({ x }) => x);
    const last = Math.max(...reached);
    const contiguous = reached.length === (last - 650) / 10 + 1;
    check('face', `portée ${id} (α ${AVALANCHE_SCENARIOS[id].alphaDeg}°)`, Math.abs(last - reachTheory[id]) <= 2 * CELL + 10 && contiguous,
      `dernier point atteint ${last} m, ligne d'énergie ${round(reachTheory[id], 0)} m${contiguous ? '' : ', trous dans la portée'}`);
  }
  let worstAngle = 0;
  for (const { x, r } of results) {
    const angle = r.scenarios.infrequent.travelAngleDeg;
    if (angle == null) continue;
    worstAngle = Math.max(worstAngle, Math.abs(angle - Math.atan(FACE_H / x) / DEG));
  }
  check('face', 'angle de parcours = atan(dénivelé / distance)', worstAngle <= 1.5, `écart max ${round(worstAngle, 2)}°`);

  let monotone = true;
  let thresholdsOk = true;
  let previous = 4;
  for (const { r } of results) {
    const cls = r.ates.atesClass;
    if (cls > previous) monotone = false;
    previous = cls;
    const angle = r.scenarios.infrequent.travelAngleDeg;
    const expected = angle == null ? 0 : angle >= 33 ? 3 : angle >= 24 ? 2 : 1;
    if (r.ates.runoutClass !== expected) thresholdsOk = false;
  }
  check('face', 'classes ATES non croissantes le long du replat', monotone);
  check('face', 'seuils d\'angle 24° / 33° (AutoATES v2.0)', thresholdsOk);
  check('face', 'au-delà de toute portée : classe 0', results.at(-1)!.r.ates.atesClass === 0, `classe ${results.at(-1)!.r.ates.atesClass} à ${results.at(-1)!.x} m`);

  const flat = makeGrid(80, 40, () => 500);
  const onFlat = computeAvalancheTerrain({ grid: flat, canopyPct: null, projX: 400, projY: 200 })!;
  check('flat', 'terrain plat : classe 0, rien n\'atteint', onFlat.ates.atesClass === 0 && !onFlat.scenarios.infrequent.reached);

  // Forest: dense canopy on the floor lowers the runout class (Table 3);
  // a densely forested face no longer releases frequent avalanches.
  const floorForest = Float32Array.from({ length: grid.width * grid.height }, (_, i) => ((i % grid.width) * CELL > FOOT_X + 50 ? 80 : 0));
  const forested = computeAvalancheTerrain({ grid, canopyPct: floorForest, projX: 700, projY: 300 })!;
  check('forest', 'forêt dense sur l\'écoulement : classe abaissée (Table 3)', forested.ates.canopyClass === 'dense' && forested.ates.atesClass < forested.ates.terrainClass,
    `${forested.ates.terrainClass} → ${forested.ates.atesClass}`);
  const faceForest = new Float32Array(grid.width * grid.height).fill(80);
  const typicalRelease = computeReleaseAreas(grid, wind, faceForest, AVALANCHE_SCENARIOS.typical).release.reduce((a, b) => a + b, 0);
  const openRelease = computeReleaseAreas(grid, wind, null, AVALANCHE_SCENARIOS.typical).release.reduce((a, b) => a + b, 0);
  check('forest', 'face boisée à 80 % : plus de zone de départ fréquente', typicalRelease === 0 && openRelease > 0, `${typicalRelease} cellules (ouvert : ${openRelease})`);
}

function counterSlopeChecks(): void {
  console.log('\n■ Contre-pente : remontée de l\'écoulement');
  const grid = faceAndCounterSlope();
  const x = FOOT_X + 200 + 60; // 60 m up the counter-slope, 28 m above the floor
  const r = computeAvalancheTerrain({ grid, canopyPct: null, projX: x, projY: 300 })!;
  check('counter', 'atteint 28 m plus haut sur le versant opposé', r.scenarios.infrequent.reached,
    `angle de parcours ${r.scenarios.infrequent.travelAngleDeg != null ? round(r.scenarios.infrequent.travelAngleDeg) : '—'}°`);
}

function windShelterChecks(): void {
  console.log('\n■ Abri au vent (Plattner et al., 2006)');
  // A bowl (hollow) and a ridge, each 300 m wide.
  const bowl = makeGrid(60, 60, (x, y) => 1000 + 0.002 * ((x - 300) ** 2 + (y - 300) ** 2));
  const ridge = makeGrid(60, 60, (x) => 1000 - 0.4 * Math.abs(x - 300));
  const centre = 30 * 60 + 30;
  const hollow = new WindShelterField(bowl).at(centre);
  const crest = new WindShelterField(ridge).at(centre);
  check('wind', 'creux abrité (> 0), crête exposée (< 0)', hollow > 0 && crest < 0, `creux ${round(hollow, 3)} rad, crête ${round(crest, 3)} rad`);
}

function exactnessChecks(): void {
  console.log('\n■ Exactitude des élagages (Flow-Py exhaustif comme référence)');
  for (const [name, grid] of [['face', faceAndFloor()], ['contre-pente', faceAndCounterSlope()]] as const) {
    const wind = new WindShelterField(grid);
    const terrain = prepareFlowPyTerrain(grid);
    const canopy = Float32Array.from({ length: grid.width * grid.height }, (_, i) => (i % 7 === 0 ? 45 : 0));
    const fsi = Float32Array.from(canopy, (c) => c / 100);
    let identical = true;
    let cases = 0;
    for (const id of ['typical', 'infrequent'] as const) {
      const release = computeReleaseAreas(grid, wind, canopy, AVALANCHE_SCENARIOS[id]).release;
      for (const x of [650, 800, 1000, 1200]) {
        if (x / CELL >= grid.width - 2) continue;
        const target = { cells: Int32Array.of(30 * grid.width + x / CELL) };
        const run = { alphaDeg: AVALANCHE_SCENARIOS[id].alphaDeg, fsi, release };
        const fast = runFlowPyToTarget(grid, terrain, target, run);
        const full = runFlowPyToTarget(grid, terrain, target, { ...run, exhaustive: true });
        cases++;
        identical &&= fast.startCells.length === full.startCells.length
          && fast.startCells.every((v, k) => v === full.startCells[k])
          && fast.travelAngleDeg === full.travelAngleDeg
          && fast.zDeltaM === full.zDeltaM
          && fast.routFluxSum === full.routFluxSum
          && fast.pathCells.length === full.pathCells.length;
      }
    }
    check('exact', `${name} : résultat identique au calcul exhaustif`, identical, `${cases} cas`);
  }
}

/** The viewer's Flow-Py pool on worker_threads (same handler as the Web Workers). */
function nodeFlowPyPool(size: number): { ports: FlowPyPort[]; close: () => Promise<void> } {
  // tsx's loader is per thread: the .mjs entry registers it in the worker.
  const workers = Array.from({ length: size }, () => new Worker(new URL('./avalanche/flowPyNodeWorker.mjs', import.meta.url)));
  const ports = workers.map((worker): FlowPyPort => ({
    postMessage: (message) => worker.postMessage(message),
    listen(onMessage, onError) {
      const message = (data: FlowPyWorkerResponse) => onMessage(data);
      const error = (err: Error) => onError(err.message);
      worker.on('message', message);
      worker.on('error', error);
      return () => {
        worker.off('message', message);
        worker.off('error', error);
      };
    },
  }));
  return {
    ports,
    close: async () => {
      await Promise.all(workers.map((worker) => worker.terminate()));
    },
  };
}

async function timingChecks(suite: BenchmarkSuite, quick: boolean): Promise<void> {
  console.log('\n■ Temps de calcul (3 km × 3 km à 10 m)');
  // A 1 200 m high, 3 km wide mountain side with gullies, then a valley floor.
  const grid = makeGrid(300, 300, (x, y) => {
    const base = x < 1800 ? 1000 + (1800 - x) * Math.tan(32 * DEG) * (0.85 + 0.15 * Math.cos(x / 300)) : 1000;
    return base + 25 * Math.sin(y / 90) * Math.min(1, Math.max(0, (1800 - x) / 400)) + rough(x, y);
  });
  const wind = new WindShelterField(grid);
  const t0 = performance.now();
  const r = computeAvalancheTerrain({ grid, canopyPct: null, projX: 1900, projY: 1500 }, wind)!;
  const ms = performance.now() - t0;
  console.log(`  info un seul thread (sans workers) — ${round(ms, 0)} ms${r.incomplete ? ' (calcul partiel : plafond atteint)' : ''}, ${r.scenarios.infrequent.releaseCellCount} cellules de départ l'atteignent`);

  // The viewer's path: Flow-Py over the worker pool (cores − 1, at most 8).
  const threads = Math.min(8, availableParallelism() - 1);
  const pool = nodeFlowPyPool(threads);
  const input = { grid, canopyPct: null, projX: 1900, projY: 1500 };
  const pooled = () => computeAvalancheTerrainWith(input, wind, (g, terrain, target, run) => runFlowPyInPool(pool.ports, g, terrain, target, run));
  try {
    const t1 = performance.now();
    const p = (await pooled())!;
    const pooledMs = performance.now() - t1;
    check(
      'timing',
      `un point sous la face, calcul complet < 10 s (${threads} workers, abri au vent compris)`,
      pooledMs < 10_000 && !p.incomplete,
      `${round(pooledMs, 0)} ms${p.incomplete ? ' (INCOMPLET)' : ''}, ATES ${p.ates.atesClass}, ${p.scenarios.infrequent.releaseCellCount} cellules de départ l'atteignent`,
    );
    await suite.measureAsync(
      { name: `Exposition avalanche (point, 300 × 300, ${threads} workers)`, category: 'avalanche', iterations: quick ? 1 : 3, warmupIterations: 0 },
      pooled,
    );
  } finally {
    await pool.close();
  }
}

export async function runAvalancheBenchmark(options: { quick?: boolean } = {}): Promise<BenchmarkSuite> {
  const suite = new BenchmarkSuite('Exposition avalanche (AutoATES v2.0 : PRA, Flow-Py, ATES)');
  energyLineChecks();
  counterSlopeChecks();
  windShelterChecks();
  exactnessChecks();
  await timingChecks(suite, options.quick ?? false);
  const failed = checks.filter((c) => !c.ok);
  console.log(`\n${checks.length - failed.length}/${checks.length} critères OK`);
  for (const f of failed) suite.addRegressionRisk(`[${f.fixture}] ${f.name} — ${f.detail}`);
  if (failed.length) process.exitCode = 1;
  return suite;
}

const isMain = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) await runAvalancheBenchmark({ quick: process.argv.includes('--quick') });
