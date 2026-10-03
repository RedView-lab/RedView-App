// ============================================
// LiDAR viewer tools — fall line (line of steepest descent)
// ============================================
//
// Where a slip, a sluff or a rock released at a point goes: the path follows
// the downhill gradient of the ground model until the slope flattens out
// (runout), the ground rises on every side (terrain trap: hollow, closed
// gully floor, lake) or the loaded area ends. The gradient is read over a
// few metres so the path follows gullies, not every boulder; a hollow
// narrower than `SPILL_RADIUS_M` (DTM noise, a boulder, a ditch) is
// crossed towards its lowest outlet instead of ending the path.

import type { TerrainField } from './terrainField';

export type FallLineStop = 'runout' | 'trap' | 'edge' | 'maxLength';

export interface FallLineSample {
  projX: number;
  projY: number;
  /** Ground altitude, m. */
  altitudeM: number;
  /** Cumulative horizontal distance, m. */
  distanceM: number;
  /** Local slope, degrees. */
  slopeDeg: number;
}

export interface FallLineResult {
  samples: FallLineSample[];
  stop: FallLineStop;
  /** Horizontal length, m. */
  lengthM: number;
  dropM: number;
  /** Steepest slope held over 10 m of the path, degrees. */
  maxSlopeDeg: number;
  /** Highest rock step crossed (slope ≥ 50° on ≥ 5 m of drop), m; 0 without one. */
  maxCliffDropM: number;
  /** Mean angle of the whole path (Fahrböschung), degrees. */
  pathAngleDeg: number;
}

/** Baseline of the gradient followed by the path, m. */
const GRADIENT_BASELINE_M = 4;
/** Below this slope the ground counts as flat. */
const RUNOUT_SLOPE_DEG = 5;
/** Flat distance (m) after which the path is considered stopped. */
const RUNOUT_LENGTH_M = 20;
const MAX_LENGTH_M = 4000;
/** Window of the "steepest slope held" statistic, m. */
const STEEP_WINDOW_M = 10;
const CLIFF_SLOPE_DEG = 50;
const CLIFF_MIN_DROP_M = 5;
/** Hollows narrower than this are crossed (searched outlet radius), m. */
const SPILL_RADIUS_M = 25;
/** An outlet must lie at least this much lower than the hollow, m. */
const SPILL_MIN_DROP_M = 0.1;
const SPILL_DIRECTIONS = 24;

interface Outlet {
  x: number;
  y: number;
  z: number;
}

export function traceFallLine(field: TerrainField, startX: number, startY: number): FallLineResult | null {
  const startAltitude = field.altitudeAt(startX, startY);
  if (startAltitude == null) return null;

  const step = Math.max(0.5, field.cell);
  const samples: FallLineSample[] = [];
  let x = startX;
  let y = startY;
  /** Lowest altitude reached: the path never climbs back above it. */
  let level = startAltitude;
  let distance = 0;
  let flatRun = 0;
  let stop: FallLineStop = 'maxLength';

  const push = (px: number, py: number, slopeDeg: number) => {
    const z = field.altitudeAt(px, py) ?? level;
    samples.push({ projX: px, projY: py, altitudeM: z, distanceM: distance, slopeDeg });
  };

  while (distance < MAX_LENGTH_M) {
    const slope = field.slopeAt(x, y, GRADIENT_BASELINE_M);
    if (!slope) {
      stop = 'edge';
      break;
    }
    push(x, y, slope.slopeDeg);

    flatRun = slope.slopeDeg < RUNOUT_SLOPE_DEG ? flatRun + step : 0;
    if (flatRun >= RUNOUT_LENGTH_M) {
      stop = 'runout';
      break;
    }

    const norm = Math.hypot(slope.gradX, slope.gradY);
    let next: Outlet | null = null;
    if (norm > 1e-6) {
      const nx = x - (slope.gradX / norm) * step;
      const ny = y - (slope.gradY / norm) * step;
      const nz = field.altitudeAt(nx, ny);
      if (nz == null) {
        stop = 'edge';
        break;
      }
      if (nz <= level + 0.02 && !isRevisit(samples, nx, ny, step)) next = { x: nx, y: ny, z: nz };
    }
    if (!next) {
      // Every way out climbs or loops: cross the hollow to its outlet, if any.
      const outlet = findOutlet(field, x, y, level, step);
      if (!outlet) {
        stop = 'trap';
        break;
      }
      const run = Math.hypot(outlet.x - x, outlet.y - y);
      const count = Math.max(1, Math.round(run / step));
      for (let k = 1; k < count; k++) {
        distance += run / count;
        push(x + ((outlet.x - x) * k) / count, y + ((outlet.y - y) * k) / count, slope.slopeDeg);
      }
      distance += run / count;
      next = outlet;
    } else {
      distance += step;
    }
    x = next.x;
    y = next.y;
    level = Math.min(level, next.z);
  }
  if (samples.length < 2) return null;

  const last = samples[samples.length - 1]!;
  const dropM = startAltitude - last.altitudeM;
  return {
    samples,
    stop,
    lengthM: last.distanceM,
    dropM,
    maxSlopeDeg: steepestHeldSlope(samples, STEEP_WINDOW_M),
    maxCliffDropM: highestCliff(samples),
    pathAngleDeg: last.distanceM > 0 ? (Math.atan(dropM / last.distanceM) * 180) / Math.PI : 0,
  };
}

/** Lowest ground below `level` on the nearest ring around (x, y) that has any, up to the spill radius. */
function findOutlet(field: TerrainField, x: number, y: number, level: number, step: number): Outlet | null {
  for (let r = 2 * step; r <= SPILL_RADIUS_M; r += step) {
    let best: Outlet | null = null;
    for (let k = 0; k < SPILL_DIRECTIONS; k++) {
      const a = (k / SPILL_DIRECTIONS) * Math.PI * 2;
      const ox = x + Math.cos(a) * r;
      const oy = y + Math.sin(a) * r;
      const z = field.altitudeAt(ox, oy);
      if (z != null && z < level - SPILL_MIN_DROP_M && (!best || z < best.z)) best = { x: ox, y: oy, z };
    }
    if (best) return best;
  }
  return null;
}

/** The path came back within half a step of one of its recent points (flat noise loop). */
function isRevisit(samples: FallLineSample[], x: number, y: number, step: number): boolean {
  const from = Math.max(0, samples.length - 40);
  for (let k = from; k < samples.length - 2; k++) {
    const s = samples[k]!;
    if (Math.hypot(s.projX - x, s.projY - y) < step * 0.5) return true;
  }
  return false;
}

/** Steepest mean slope over `window` metres of horizontal distance. */
export function steepestHeldSlope(
  samples: ReadonlyArray<{ distanceM: number; altitudeM: number }>,
  window: number,
): number {
  let best = 0;
  let j = 0;
  for (let i = 0; i < samples.length; i++) {
    const a = samples[i]!;
    if (j < i) j = i;
    while (j < samples.length - 1 && samples[j]!.distanceM - a.distanceM < window) j++;
    const b = samples[j]!;
    const run = b.distanceM - a.distanceM;
    if (run < window * 0.8) break;
    best = Math.max(best, (Math.atan(Math.abs(a.altitudeM - b.altitudeM) / run) * 180) / Math.PI);
  }
  return best;
}

function highestCliff(samples: FallLineSample[]): number {
  let best = 0;
  let runTop: number | null = null;
  for (const s of samples) {
    if (s.slopeDeg >= CLIFF_SLOPE_DEG) {
      if (runTop == null) runTop = s.altitudeM;
      continue;
    }
    if (runTop != null) {
      const drop = runTop - s.altitudeM;
      if (drop >= CLIFF_MIN_DROP_M) best = Math.max(best, drop);
      runTop = null;
    }
  }
  if (runTop != null) {
    const drop = runTop - samples[samples.length - 1]!.altitudeM;
    if (drop >= CLIFF_MIN_DROP_M) best = Math.max(best, drop);
  }
  return best;
}
