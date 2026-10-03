// ============================================
// LiDAR viewer tools — avalanche exposure of a point (alpha angle)
// ============================================
//
// Empirical runout model (Lied & Bakkehøi α–β, as used by AutoATES v2):
// an avalanche rarely runs past the point seen at an angle α ≈ 20–24° from
// the top of its starting zone. For a point P we therefore:
//  1. collect the terrain that drains towards P (multiple-flow-direction
//     walk up the analysis grid from a small disc around P);
//  2. group its 30–60° cells into starting zones (connected areas), and
//     keep those large and high enough to produce an avalanche that runs;
//  3. measure α from P to the top of each zone.
// α ≥ 24° (AutoATES "complex" threshold) puts P under a starting zone;
// 20–24° is the reach of large or channelled avalanches. Forest, snowpack
// and avalanche size are not modelled, and only the loaded area is seen:
// a starting zone outside it is missed.

import { analysisCellAt, type AnalysisGrid, type TerrainField } from './terrainField';

export type AvalancheExposureLevel = 'none' | 'low' | 'possible' | 'exposed';

export interface AvalancheExposureResult {
  level: AvalancheExposureLevel;
  /** Largest α from P to the top of a starting zone draining towards it, degrees. */
  maxAlphaDeg: number | null;
  /** Top of the starting zone seen at `maxAlphaDeg`. */
  source: { projX: number; projY: number; altitudeM: number } | null;
  /** Cells of the starting zones reaching P (α ≥ `ALPHA_POSSIBLE_DEG`), with their zone's α. */
  reachingCells: Int32Array;
  reachingAlphaDeg: Float32Array;
  /** Plan area of `reachingCells`, m². */
  reachingAreaM2: number;
  /** Starting zones reaching P. */
  reachingZoneCount: number;
  /** P itself stands on a potential release slope (30–60°). */
  inReleaseArea: boolean;
  grid: AnalysisGrid;
}

export const RELEASE_MIN_SLOPE_DEG = 30;
export const RELEASE_MAX_SLOPE_DEG = 60;
export const ALPHA_POSSIBLE_DEG = 20;
export const ALPHA_EXPOSED_DEG = 24;
/** Smallest starting zone considered (a ~25 × 25 m slope), m². */
const MIN_ZONE_AREA_M2 = 600;
/** A starting zone's top must stand this high above P, m. */
const MIN_ZONE_RISE_M = 10;
/** A neighbour still drains towards a cell when at most this much lower (DTM noise), m. */
const DRAIN_TOLERANCE_M = 0.1;

const NEIGHBOURS: ReadonlyArray<[number, number]> = [
  [-1, -1], [0, -1], [1, -1], [-1, 0], [1, 0], [-1, 1], [0, 1], [1, 1],
];

export function computeAvalancheExposure(
  field: TerrainField,
  projX: number,
  projY: number,
): AvalancheExposureResult | null {
  const grid = field.getAnalysisGrid();
  const altitudeP = field.altitudeAt(projX, projY);
  const centre = analysisCellAt(grid, projX, projY);
  if (altitudeP == null || centre < 0) return null;

  const { width, height, cell, altitude, slopeDeg } = grid;
  const upstream = collectUpstream(grid, centre, Math.max(1.5 * cell, 10));

  // Starting zones: connected release cells of the upstream area.
  const zoneOf = new Int32Array(width * height).fill(-1);
  const isRelease = (i: number) => upstream[i] === 1
    && slopeDeg[i]! >= RELEASE_MIN_SLOPE_DEG
    && slopeDeg[i]! <= RELEASE_MAX_SLOPE_DEG;
  const stack: number[] = [];
  const zoneCells: number[] = [];
  let maxAlpha = -Infinity;
  let source = -1;
  let anyZone = false;
  const reaching: number[] = [];
  const reachingAlpha: number[] = [];
  let zoneCount = 0;
  let reachingZones = 0;

  for (let seed = 0; seed < width * height; seed++) {
    if (zoneOf[seed] !== -1 || !isRelease(seed)) continue;
    zoneCells.length = 0;
    zoneOf[seed] = zoneCount;
    stack.push(seed);
    let top = seed;
    while (stack.length > 0) {
      const i = stack.pop()!;
      zoneCells.push(i);
      if (altitude[i]! > altitude[top]!) top = i;
      const col = i % width;
      const row = (i - col) / width;
      for (const [dc, dr] of NEIGHBOURS) {
        const c = col + dc;
        const r = row + dr;
        if (c < 0 || r < 0 || c >= width || r >= height) continue;
        const n = r * width + c;
        if (zoneOf[n] === -1 && isRelease(n)) {
          zoneOf[n] = zoneCount;
          stack.push(n);
        }
      }
    }
    zoneCount++;
    const rise = altitude[top]! - altitudeP;
    if (zoneCells.length * cell * cell < MIN_ZONE_AREA_M2 || rise < MIN_ZONE_RISE_M) continue;
    anyZone = true;
    const topCol = top % width;
    const topRow = (top - topCol) / width;
    const run = Math.hypot(grid.originX + topCol * cell - projX, grid.originY + topRow * cell - projY);
    const alpha = (Math.atan2(rise, Math.max(run, cell)) * 180) / Math.PI;
    if (alpha > maxAlpha) {
      maxAlpha = alpha;
      source = top;
    }
    if (alpha >= ALPHA_POSSIBLE_DEG) {
      reachingZones++;
      for (const i of zoneCells) {
        reaching.push(i);
        reachingAlpha.push(alpha);
      }
    }
  }

  const pointSlope = field.slopeAt(projX, projY);
  const inReleaseArea = pointSlope != null
    && pointSlope.slopeDeg >= RELEASE_MIN_SLOPE_DEG
    && pointSlope.slopeDeg <= RELEASE_MAX_SLOPE_DEG;

  let level: AvalancheExposureLevel = 'none';
  if (anyZone) {
    level = maxAlpha >= ALPHA_EXPOSED_DEG ? 'exposed' : maxAlpha >= ALPHA_POSSIBLE_DEG ? 'possible' : 'low';
  }
  const sourceCol = source >= 0 ? source % width : 0;
  const sourceRow = source >= 0 ? (source - sourceCol) / width : 0;
  return {
    level,
    maxAlphaDeg: anyZone ? maxAlpha : null,
    source: source >= 0
      ? { projX: grid.originX + sourceCol * cell, projY: grid.originY + sourceRow * cell, altitudeM: altitude[source]! }
      : null,
    reachingCells: Int32Array.from(reaching),
    reachingAlphaDeg: Float32Array.from(reachingAlpha),
    reachingAreaM2: reaching.length * cell * cell,
    reachingZoneCount: reachingZones,
    inReleaseArea,
    grid,
  };
}

/** Cells draining towards a disc of `seedRadius` metres around `centre` (1 = upstream). */
function collectUpstream(grid: AnalysisGrid, centre: number, seedRadius: number): Uint8Array {
  const { width, height, cell, altitude } = grid;
  const visited = new Uint8Array(width * height);
  const queue = new Int32Array(width * height);
  let head = 0;
  let tail = 0;
  const seedCells = Math.ceil(seedRadius / cell);
  const centreCol = centre % width;
  const centreRow = (centre - centreCol) / width;
  for (let dr = -seedCells; dr <= seedCells; dr++) {
    for (let dc = -seedCells; dc <= seedCells; dc++) {
      const col = centreCol + dc;
      const row = centreRow + dr;
      if (col < 0 || row < 0 || col >= width || row >= height) continue;
      if (Math.hypot(dc, dr) * cell > seedRadius) continue;
      const i = row * width + col;
      if (!Number.isFinite(altitude[i]!)) continue;
      visited[i] = 1;
      queue[tail++] = i;
    }
  }
  while (head < tail) {
    const i = queue[head++]!;
    const col = i % width;
    const row = (i - col) / width;
    const z = altitude[i]!;
    for (const [dc, dr] of NEIGHBOURS) {
      const c = col + dc;
      const r = row + dr;
      if (c < 0 || r < 0 || c >= width || r >= height) continue;
      const n = r * width + c;
      if (visited[n]) continue;
      if (!(altitude[n]! > z - DRAIN_TOLERANCE_M)) continue;
      visited[n] = 1;
      queue[tail++] = n;
    }
  }
  return visited;
}
