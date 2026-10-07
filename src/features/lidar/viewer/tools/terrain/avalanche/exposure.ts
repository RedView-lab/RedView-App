// ============================================
// LiDAR viewer tools — avalanche terrain exposure of a point
// ============================================
//
// AutoATES v2.0 chain (see params.ts) evaluated for one point P of the
// scene's analysis grid (≈ 5 m cells): release areas of both scenarios,
// Flow-Py runout from every release cell whose energy line can reach P, then
// the ATES class of P. Pure function of the ground model (≈ 10 m grid) and
// the canopy cover: it runs in a worker (workers/avalancheWorker.ts) or inline.

import { rateAtes, type AtesRating } from './ates';
import {
  prepareFlowPyTerrain,
  runFlowPyToTarget,
  type FlowPyGrid,
  type FlowPyResult,
  type FlowPyRun,
  type FlowPyTarget,
  type FlowPyTerrain,
} from './flowPy';
import { AVALANCHE_SCENARIOS, type AvalancheScenarioId } from './params';
import { computeReleaseAreas, WindShelterField, type TerrainGrid } from './releaseArea';

const G = 9.81;
/** "The point" is a disc this wide at least (a person, a skin track), m. */
const TARGET_RADIUS_M = 10;
/** A slope this steep on the scene edge, above the point's energy line, may continue off the loaded area. */
const EDGE_SLOPE_DEG = 28;

export interface AvalancheGridInput extends TerrainGrid {
  originX: number;
  originY: number;
}

export interface AvalancheTerrainInput {
  grid: AvalancheGridInput;
  /** Canopy cover per analysis cell (0–100, NaN unknown); `null`: no forest data. */
  canopyPct: Float32Array | null;
  projX: number;
  projY: number;
}

interface AvalancheScenarioReach {
  reached: boolean;
  /** Largest flow-path travel angle at the point, degrees. */
  travelAngleDeg: number | null;
  /** Largest kinetic-energy height at the point (Flow-Py zδ), m. */
  zDeltaM: number | null;
  /** Speed equivalent of `zDeltaM`, √(2 g zδ), m/s. */
  speedMs: number | null;
  /** Release cells whose flow reaches the point. */
  releaseCellCount: number;
  releaseAreaM2: number;
  /** Release areas (connected groups of release cells) they belong to. */
  zoneCount: number;
  /** Release area routed through the point (routFluxSum × cell area), m². */
  contributingAreaM2: number;
  /** Release cell of the largest travel angle. */
  source: { projX: number; projY: number; altitudeM: number } | null;
}

export interface AvalancheTerrainResult {
  ates: AtesRating;
  slopeDeg: number;
  smoothedSlopeDeg: number;
  /** Canopy cover at the point, % (`null`: unknown). */
  canopyPct: number | null;
  forestKnown: boolean;
  /** The point is itself in a potential release area (typical first). */
  inReleaseArea: AvalancheScenarioId | null;
  scenarios: Record<AvalancheScenarioId, AvalancheScenarioReach>;
  /** Release cells reaching the point; `releaseTypical` 1 where the typical scenario does too. */
  releaseCells: Int32Array;
  releaseTypical: Uint8Array;
  /** Cells of the flow paths to the point, with their largest zδ (m). */
  pathCells: Int32Array;
  pathZDelta: Float32Array;
  pathTypical: Uint8Array;
  /** Steep terrain above the point continues past the edge of the loaded area. */
  upslopeCut: boolean;
  /** A runout stopped at its cost bound: the lowest release cells were left out. */
  incomplete: boolean;
  lattice: { width: number; height: number; cell: number; originX: number; originY: number };
  computeMs: number;
}

/** Runs Flow-Py for one scenario (here, or over a pool of workers: see flowPyPool.ts). */
export type FlowPyRunner = (grid: FlowPyGrid, terrain: FlowPyTerrain, target: FlowPyTarget, run: FlowPyRun) => Promise<FlowPyResult>;

/** Everything of a point's evaluation before the Flow-Py runs. */
interface AvalanchePreparation {
  input: AvalancheTerrainInput;
  started: number;
  centre: number;
  target: PointTarget;
  release: Record<AvalancheScenarioId, ReturnType<typeof computeReleaseAreas>>;
  terrain: FlowPyTerrain;
  runs: Record<AvalancheScenarioId, FlowPyRun>;
}

export function computeAvalancheTerrain(
  input: AvalancheTerrainInput,
  wind: WindShelterField = new WindShelterField(input.grid),
): AvalancheTerrainResult | null {
  const prep = prepareAvalanche(input, wind);
  if (!prep) return null;
  const { grid } = input;
  return assembleAvalanche(prep, {
    typical: runFlowPyToTarget(grid, prep.terrain, prep.target, prep.runs.typical),
    infrequent: runFlowPyToTarget(grid, prep.terrain, prep.target, prep.runs.infrequent),
  });
}

/** Same evaluation, the Flow-Py runs handed to `runFlowPy` (a worker pool in the viewer). */
export async function computeAvalancheTerrainWith(
  input: AvalancheTerrainInput,
  wind: WindShelterField,
  runFlowPy: FlowPyRunner,
): Promise<AvalancheTerrainResult | null> {
  const prep = prepareAvalanche(input, wind);
  if (!prep) return null;
  const { grid } = input;
  const typical = await runFlowPy(grid, prep.terrain, prep.target, prep.runs.typical);
  const infrequent = await runFlowPy(grid, prep.terrain, prep.target, prep.runs.infrequent);
  return assembleAvalanche(prep, { typical, infrequent });
}

function prepareAvalanche(input: AvalancheTerrainInput, wind: WindShelterField): AvalanchePreparation | null {
  const started = performance.now();
  const { grid, canopyPct } = input;
  const { width, height, cell, originX, originY, altitude } = grid;
  const col = (input.projX - originX) / cell;
  const row = (input.projY - originY) / cell;
  const centre = Math.round(row) * width + Math.round(col);
  if (col < -0.5 || row < -0.5 || col > width - 0.5 || row > height - 0.5 || !Number.isFinite(altitude[centre]!)) {
    return null;
  }

  const target = buildTarget(grid, col, row);
  const fsi = canopyPct ? Float32Array.from(canopyPct, (c) => (Number.isFinite(c) ? Math.min(1, Math.max(0, c / 100)) : 0)) : null;
  const release = {
    typical: computeReleaseAreas(grid, wind, canopyPct, AVALANCHE_SCENARIOS.typical),
    infrequent: computeReleaseAreas(grid, wind, canopyPct, AVALANCHE_SCENARIOS.infrequent),
  };
  return {
    input,
    started,
    centre,
    target,
    release,
    terrain: prepareFlowPyTerrain(grid),
    runs: {
      typical: { alphaDeg: AVALANCHE_SCENARIOS.typical.alphaDeg, fsi, release: release.typical.release },
      infrequent: { alphaDeg: AVALANCHE_SCENARIOS.infrequent.alphaDeg, fsi, release: release.infrequent.release },
    },
  };
}

function assembleAvalanche(prep: AvalanchePreparation, runs: Record<AvalancheScenarioId, FlowPyResult>): AvalancheTerrainResult {
  const { input, started, centre, target, release } = prep;
  const { grid, canopyPct } = input;
  const { width, height, cell, originX, originY, slopeDeg } = grid;

  const slope = slopeDeg[centre]!;
  const canopy = canopyPct && Number.isFinite(canopyPct[centre]!) ? canopyPct[centre]! : null;
  const inReleaseArea: AvalancheScenarioId | null = release.typical.release[centre]
    ? 'typical'
    : release.infrequent.release[centre] ? 'infrequent' : null;
  const smoothedSlopeDeg = smoothedSlope(grid, centre);
  const ates = rateAtes({
    slopeDeg: slope,
    smoothedSlopeDeg,
    runoutTravelAngleDeg: maxOrNull(runs.infrequent.travelAngleDeg, runs.typical.travelAngleDeg),
    canopyPct: canopyPct ? canopy ?? 0 : null,
    inReleaseArea: inReleaseArea != null,
  });

  // Display: release cells and paths of both scenarios (typical ⊂ infrequent mostly).
  const typicalStarts = new Set(runs.typical.startCells);
  const releaseCells = new Set<number>([...runs.infrequent.startCells, ...runs.typical.startCells]);
  const path = new Map<number, { z: number; typical: boolean }>();
  for (const [id, run] of [['infrequent', runs.infrequent], ['typical', runs.typical]] as const) {
    run.pathCells.forEach((i, k) => {
      const z = run.pathZDelta[k]!;
      const old = path.get(i);
      path.set(i, { z: Math.max(old?.z ?? 0, z), typical: (old?.typical ?? false) || id === 'typical' });
    });
  }
  for (const i of releaseCells) path.delete(i);
  const releaseList = Int32Array.from(releaseCells);
  const pathList = Int32Array.from(path.keys());

  return {
    ates,
    slopeDeg: Number.isFinite(slope) ? slope : 0,
    smoothedSlopeDeg,
    canopyPct: canopy,
    forestKnown: canopyPct != null,
    inReleaseArea,
    scenarios: {
      typical: scenarioReach(grid, runs.typical, release.typical.release),
      infrequent: scenarioReach(grid, runs.infrequent, release.infrequent.release),
    },
    releaseCells: releaseList,
    releaseTypical: Uint8Array.from(releaseList, (i) => (typicalStarts.has(i) ? 1 : 0)),
    pathCells: pathList,
    pathZDelta: Float32Array.from(pathList, (i) => path.get(i)!.z),
    pathTypical: Uint8Array.from(pathList, (i) => (path.get(i)!.typical ? 1 : 0)),
    upslopeCut: isUpslopeCut(grid, target),
    incomplete: runs.typical.incomplete || runs.infrequent.incomplete,
    lattice: { width, height, cell, originX, originY },
    computeMs: performance.now() - started,
  };
}

/**
 * Plan box where the forest matters for a point: the terrain high enough
 * above it to reach it on the infrequent energy line (release areas and
 * their paths), plus a margin around the point.
 */
export function avalancheReadBounds(
  grid: AvalancheGridInput,
  projX: number,
  projY: number,
  marginM = 150,
): { minX: number; minY: number; maxX: number; maxY: number } {
  const { width, height, cell, originX, originY, altitude } = grid;
  const col = (projX - originX) / cell;
  const row = (projY - originY) / cell;
  const zP = altitude[Math.round(Math.min(height - 1, Math.max(0, row))) * width + Math.round(Math.min(width - 1, Math.max(0, col)))]!;
  const tanAlpha = Math.tan((AVALANCHE_SCENARIOS.infrequent.alphaDeg * Math.PI) / 180);
  let minX = projX;
  let maxX = projX;
  let minY = projY;
  let maxY = projY;
  if (Number.isFinite(zP)) {
    for (let r = 0; r < height; r++) {
      for (let c = 0; c < width; c++) {
        const z = altitude[r * width + c]!;
        if (!(z - zP >= tanAlpha * Math.max(0, Math.hypot(c - col, r - row) * cell - TARGET_RADIUS_M))) continue;
        const x = originX + c * cell;
        const y = originY + r * cell;
        if (x < minX) minX = x;
        if (x > maxX) maxX = x;
        if (y < minY) minY = y;
        if (y > maxY) maxY = y;
      }
    }
  }
  return { minX: minX - marginM, minY: minY - marginM, maxX: maxX + marginM, maxY: maxY + marginM };
}

function maxOrNull(a: number | null, b: number | null): number | null {
  if (a == null) return b;
  return b == null ? a : Math.max(a, b);
}

/** Cells of "the point" with its position in grid units. */
interface PointTarget extends FlowPyTarget {
  col: number;
  row: number;
  radiusM: number;
}

function buildTarget(grid: AvalancheGridInput, col: number, row: number): PointTarget {
  const { width, height, cell, altitude } = grid;
  const radiusM = Math.max(TARGET_RADIUS_M, 1.5 * cell);
  const reach = Math.ceil(radiusM / cell);
  const cells: number[] = [];
  for (let r = Math.round(row) - reach; r <= Math.round(row) + reach; r++) {
    for (let c = Math.round(col) - reach; c <= Math.round(col) + reach; c++) {
      if (c < 0 || r < 0 || c >= width || r >= height) continue;
      if (Math.hypot(c - col, r - row) * cell > radiusM) continue;
      if (Number.isFinite(altitude[r * width + c]!)) cells.push(r * width + c);
    }
  }
  const centre = Math.round(row) * width + Math.round(col);
  if (!cells.includes(centre)) cells.push(centre);
  return { cells: Int32Array.from(cells), col, row, radiusM };
}

/** Mean slope of the 3 × 3 cells around `centre` (AutoATES class 4 criterion). */
function smoothedSlope(grid: AvalancheGridInput, centre: number): number {
  const { width, height, slopeDeg } = grid;
  const col = centre % width;
  const row = (centre - col) / width;
  let sum = 0;
  let n = 0;
  for (let r = row - 1; r <= row + 1; r++) {
    for (let c = col - 1; c <= col + 1; c++) {
      if (c < 0 || r < 0 || c >= width || r >= height) continue;
      const s = slopeDeg[r * width + c]!;
      if (Number.isFinite(s)) {
        sum += s;
        n++;
      }
    }
  }
  return n > 0 ? sum / n : 0;
}

function scenarioReach(grid: AvalancheGridInput, run: FlowPyResult, release: Uint8Array): AvalancheScenarioReach {
  const { width, cell, originX, originY, altitude } = grid;
  const area = cell * cell;
  let source: AvalancheScenarioReach['source'] = null;
  let best = -Infinity;
  run.startCells.forEach((i, k) => {
    const angle = run.startTravelAngleDeg[k]!;
    if (angle <= best) return;
    best = angle;
    const c = i % width;
    source = { projX: originX + c * cell, projY: originY + ((i - c) / width) * cell, altitudeM: altitude[i]! };
  });
  const reached = run.startCells.length > 0;
  return {
    reached,
    travelAngleDeg: run.travelAngleDeg,
    zDeltaM: run.zDeltaM,
    speedMs: run.zDeltaM != null ? Math.sqrt(2 * G * run.zDeltaM) : null,
    releaseCellCount: run.startCells.length,
    releaseAreaM2: run.startCells.length * area,
    zoneCount: countZones(run.startCells, release, width),
    contributingAreaM2: run.routFluxSum * area,
    source,
  };
}

/** Release areas (8-connected groups of release cells) holding at least one of `cells`. */
function countZones(cells: Int32Array, release: Uint8Array, width: number): number {
  const seen = new Uint8Array(release.length);
  const stack: number[] = [];
  let zones = 0;
  for (const seed of cells) {
    if (seen[seed]) continue;
    zones++;
    seen[seed] = 1;
    stack.push(seed);
    while (stack.length > 0) {
      const i = stack.pop()!;
      const col = i % width;
      for (let dr = -1; dr <= 1; dr++) {
        for (let dc = -1; dc <= 1; dc++) {
          if ((dc === 0 && dr === 0) || col + dc < 0 || col + dc >= width) continue;
          const n = i + dr * width + dc;
          if (n < 0 || n >= release.length || seen[n] || !release[n]) continue;
          seen[n] = 1;
          stack.push(n);
        }
      }
    }
  }
  return zones;
}

/**
 * Steep ground on the scene edge high enough above the point to reach it on
 * the infrequent energy line: the slope above continues off the loaded area,
 * where release areas are not seen.
 */
function isUpslopeCut(grid: AvalancheGridInput, target: PointTarget): boolean {
  const { width, height, cell, altitude, slopeDeg } = grid;
  const tanAlpha = Math.tan((AVALANCHE_SCENARIOS.infrequent.alphaDeg * Math.PI) / 180);
  let targetZ = Infinity;
  for (const i of target.cells) targetZ = Math.min(targetZ, altitude[i]!);
  const band = 2;
  for (let row = 0; row < height; row++) {
    for (let col = 0; col < width; col++) {
      if (col >= band && row >= band && col < width - band && row < height - band) {
        col = width - band - 1; // jump to the right band
        continue;
      }
      const i = row * width + col;
      const z = altitude[i]!;
      // The 3 × 3 slope is undefined on the outer ring: read the cell inside.
      const inner = Math.min(height - 2, Math.max(1, row)) * width + Math.min(width - 2, Math.max(1, col));
      if (!Number.isFinite(z) || !(slopeDeg[inner]! >= EDGE_SLOPE_DEG)) continue;
      const d = Math.max(0, Math.hypot(col - target.col, row - target.row) * cell - target.radiusM);
      if (z - targetZ >= tanAlpha * d) return true;
    }
  }
  return false;
}
