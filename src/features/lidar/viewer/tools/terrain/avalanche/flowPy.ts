// ============================================
// LiDAR viewer tools — Flow-Py avalanche runout, aimed at one point
// ============================================
//
// Port of the Flow-Py cell model (D'Amboise et al., 2022; com4FlowPy in
// AvaFrame): every release cell sends a unit "flux" down the grid.
//  - Energy line: from a cell to its neighbour n, the kinetic-energy height
//    zδ_n = zδ + (z − z_n) − tan α · s_n (s_n the plan step) — the flow stops
//    where the line drawn from the release at angle α meets the ground;
//    zδ is capped at 270 m (≈ 73 m/s) and stands for the speed (v ≈ √(2 g zδ)).
//  - Routing: Holmgren (1994) multiple flow direction, T_n ∝ tan(φ_n)^8 with
//    φ_n = (ψ_n + 90°) / 2 (ψ_n the angle down to n: flat and gentle uphill
//    steps stay possible), times persistence — the parents' zδ pushed straight
//    on and, at 0.707, to the two neighbouring directions — so a fast flow
//    keeps its heading, runs over flats and up counter-slopes.
//  - Flux under 0.003 is not routed on: it goes to the routed neighbours.
//  - Forest (FSI = canopy cover / 100): α grows by up to 10°·FSI (at least 2°)
//    for a slow flow, the effect fading out towards 30 m/s; a small flux
//    share is detrained in each cell.
// Cells are processed generation by generation; a cell reached again by an
// unprocessed generation gathers flux, parents and the larger zδ.
//
// Release cells are run one by one and independently, as in Flow-Py, but
// only those that can reach the target are run. The energy a flow needs in a
// cell to still get there, E(x) = max(0, min_n E(n) − (z_x − z_n) + tan α·s),
// is solved once backwards from the target (any path and heading, forest only
// raises α: a lower bound); a release cell starts with zδ = 0, so one with
// E > 0 can never get there. That drops the other gullies and the far side
// of ridges without changing the result. Inside a run, a cell arriving with
// zδ < E only feeds cells short of energy too, so the run stops as soon as no
// pending cell has enough (cells short of energy are still processed until
// then: their flux, hence routing, merges into cells that may get there).
// Paths that reach the target are traced back to their release cell
// (Flow-Py's back-calculation) for display.

import {
  FLOWPY_EXPONENT,
  FLOWPY_FLUX_THRESHOLD,
  FLOWPY_FOREST_DETRAINMENT,
  FLOWPY_FOREST_FRICTION,
  FLOWPY_MAX_Z_DELTA_M,
} from './params';

const G = 9.81;
/** Neighbours in ring order: opposite = k + 4, ring neighbours = k ± 1. */
const DC = [1, 1, 0, -1, -1, -1, 0, 1] as const;
const DR = [0, 1, 1, 1, 0, -1, -1, -1] as const;
const DS = [1, Math.SQRT2, 1, Math.SQRT2, 1, Math.SQRT2, 1, Math.SQRT2] as const;
/** Flux kept by a cell at least after detrainment (Flow-Py floor). */
const MIN_FLUX_AFTER_DETRAINMENT = 0.0003;
/** Upper bound of cells followed from one release cell (pathological grids). */
const MAX_RECORDS_PER_START = 300_000;
/**
 * Upper bound of cells followed over a whole run (≈ 10 s of one core at
 * ~0.2 µs per cell, 2026-10-06): the lowest release cells are left out.
 */
export const MAX_RECORDS_PER_RUN = 56_000_000;

export interface FlowPyGrid {
  width: number;
  height: number;
  cell: number;
  altitude: Float32Array;
}

/** Terrain-only terms, shared by every run on a grid. */
export interface FlowPyTerrain {
  /** The cell and its 8 neighbours have ground (Flow-Py skips cells next to no-data). */
  interior: Uint8Array;
  /** Holmgren weight tan(φ)^exp towards each neighbour, 8 per cell. */
  routing: Float32Array;
}

export interface FlowPyTarget {
  /** Grid cells counted as "the point" (a small disc around it). */
  cells: Int32Array;
}

export interface FlowPyRun {
  alphaDeg: number;
  /** Follows every run to its end (no early stop): reference for the checks. */
  exhaustive?: boolean;
  /** Forest structure index per cell (0–1), `null` without forest data. */
  fsi: Float32Array | null;
  /** Release cells (1) of the scenario. */
  release: Uint8Array;
}

export interface FlowPyResult {
  /** Release cells whose flow reaches the target. */
  startCells: Int32Array;
  /** Flow-path travel angle at the target of each of them, degrees. */
  startTravelAngleDeg: Float32Array;
  /** Largest flow-path travel angle at the target, degrees (`null`: not reached). */
  travelAngleDeg: number | null;
  /** Largest kinetic-energy height at the target, m. */
  zDeltaM: number | null;
  /** Largest routing flux summed over the release cells, in a target cell (routFluxSum). */
  routFluxSum: number;
  /** Cells of the flow paths leading to the target, with their largest zδ (m). */
  pathCells: Int32Array;
  pathZDelta: Float32Array;
  /** Release cells whose energy line can get to the target. */
  candidates: number;
  /** Cells processed over all release cells (cost). */
  processed: number;
  /** The run stopped at its cost bound before the lowest release cells. */
  incomplete: boolean;
}

export function prepareFlowPyTerrain(grid: FlowPyGrid): FlowPyTerrain {
  const { width, height, cell, altitude } = grid;
  const count = width * height;
  const interior = new Uint8Array(count);
  const routing = new Float32Array(count * 8);
  for (let row = 1; row < height - 1; row++) {
    for (let col = 1; col < width - 1; col++) {
      const i = row * width + col;
      const z = altitude[i]!;
      if (!Number.isFinite(z)) continue;
      let ok = true;
      for (let k = 0; k < 8; k++) {
        const zn = altitude[i + DR[k]! * width + DC[k]!]!;
        if (!Number.isFinite(zn)) {
          ok = false;
          break;
        }
        // φ = (ψ + 90°) / 2, ψ the angle down to the neighbour.
        const phi = (Math.atan((z - zn) / (DS[k]! * cell)) + Math.PI / 2) / 2;
        routing[i * 8 + k] = Math.pow(Math.tan(phi), FLOWPY_EXPONENT);
      }
      if (ok) interior[i] = 1;
    }
  }
  return { interior, routing };
}

/** Growable record storage of one release cell's flow (reused across cells). */
class Records {
  capacity = 0;
  cell = new Int32Array(0);
  flux = new Float64Array(0);
  zDelta = new Float64Array(0);
  minDist = new Float64Array(0);
  firstParent = new Int32Array(0);
  /** Counted among the pending records with the energy to still reach the target. */
  viable = new Uint8Array(0);
  edgeHead = new Int32Array(0);
  edgeCapacity = 0;
  edgeParent = new Int32Array(0);
  /** Direction of the step parent → record. */
  edgeDir = new Int8Array(0);
  edgeNext = new Int32Array(0);
  count = 0;
  edges = 0;

  reset(): void {
    this.count = 0;
    this.edges = 0;
  }

  add(cell: number, flux: number, zDelta: number, parent: number, dir: number): number {
    if (this.count === this.capacity) this.grow();
    const r = this.count++;
    this.cell[r] = cell;
    this.flux[r] = flux;
    this.zDelta[r] = zDelta;
    this.minDist[r] = 0;
    this.firstParent[r] = parent;
    this.viable[r] = 0;
    this.edgeHead[r] = -1;
    if (parent >= 0) this.addParent(r, parent, dir);
    return r;
  }

  addParent(record: number, parent: number, dir: number): void {
    if (this.edges === this.edgeCapacity) {
      this.edgeCapacity = Math.max(4096, this.edgeCapacity * 2);
      this.edgeParent = grown(this.edgeParent, this.edgeCapacity);
      this.edgeDir = grown(this.edgeDir, this.edgeCapacity);
      this.edgeNext = grown(this.edgeNext, this.edgeCapacity);
    }
    const e = this.edges++;
    this.edgeParent[e] = parent;
    this.edgeDir[e] = dir;
    this.edgeNext[e] = this.edgeHead[record]!;
    this.edgeHead[record] = e;
  }

  private grow(): void {
    this.capacity = Math.max(4096, this.capacity * 2);
    this.cell = grown(this.cell, this.capacity);
    this.flux = grown(this.flux, this.capacity);
    this.zDelta = grown(this.zDelta, this.capacity);
    this.minDist = grown(this.minDist, this.capacity);
    this.firstParent = grown(this.firstParent, this.capacity);
    this.viable = grown(this.viable, this.capacity);
    this.edgeHead = grown(this.edgeHead, this.capacity);
  }
}

function grown<T extends Int8Array | Uint8Array | Int32Array | Float64Array>(array: T, capacity: number): T {
  const next = new (array.constructor as new (n: number) => T)(capacity);
  next.set(array);
  return next;
}

/**
 * Energy (m of zδ) a flow needs in each cell to still reach the target on an
 * energy line of slope `tanAlpha` (any path, any heading); Infinity where even
 * the 270 m cap is not enough.
 */
function energyToReach(grid: FlowPyGrid, terrain: FlowPyTerrain, targetCells: Int32Array, tanAlpha: number): Float32Array {
  const { width, cell, altitude } = grid;
  const count = altitude.length;
  const need = new Float32Array(count).fill(Infinity);
  const queued = new Uint8Array(count);
  const queue = new Int32Array(count + 1);
  let head = 0;
  let tail = 0;
  const push = (i: number) => {
    queued[i] = 1;
    queue[tail] = i;
    tail = tail === count ? 0 : tail + 1;
  };
  for (const i of targetCells) {
    need[i] = 0;
    push(i);
  }
  // Label-correcting search (edge costs may be negative downhill; any cycle
  // costs tan α · length > 0, so it converges).
  while (head !== tail) {
    const n = queue[head]!;
    head = head === count ? 0 : head + 1;
    queued[n] = 0;
    const needN = need[n]!;
    const zn = altitude[n]!;
    for (let k = 0; k < 8; k++) {
      // x → n is the step of direction k from x, i.e. x sits at −k from n.
      const x = n - DR[k]! * width - DC[k]!;
      if (x < 0 || x >= count || !terrain.interior[x]) continue;
      if (Math.abs((x % width) - (n % width)) > 1) continue;
      let required = needN - (altitude[x]! - zn) + tanAlpha * DS[k]! * cell;
      if (required < 0) required = 0;
      if (required > FLOWPY_MAX_Z_DELTA_M || required >= need[x]! - 1e-6) continue;
      need[x] = required;
      if (!queued[x]) push(x);
    }
  }
  return need;
}

/** Release cells of a run that may reach the target, and the energy they need on the way. */
export interface FlowPyPlan {
  /** Release cells whose energy line can get to the target, highest first (Flow-Py order). */
  starts: Int32Array;
  /** Energy a flow needs in each cell to still reach the target (see `energyToReach`). */
  need: Float32Array;
}

export function planFlowPyRun(grid: FlowPyGrid, terrain: FlowPyTerrain, target: FlowPyTarget, run: FlowPyRun): FlowPyPlan {
  const { altitude } = grid;
  const tanAlpha = Math.tan((run.alphaDeg * Math.PI) / 180);
  const need = energyToReach(grid, terrain, target.cells, tanAlpha);
  const starts: number[] = [];
  for (let i = 0; i < altitude.length; i++) if (run.release[i] && terrain.interior[i] && need[i]! <= 0) starts.push(i);
  starts.sort((a, b) => altitude[b]! - altitude[a]!);
  return { starts: Int32Array.from(starts), need };
}

/**
 * Release cells per block. Every release cell is run on its own, so a block
 * can run anywhere (another worker); blocks are merged in start order, which
 * gives exactly the sequential result whatever ran them.
 */
export const FLOWPY_BLOCK_STARTS = 64;

/** What the release cells `starts[from, to)` of a plan add to a run. */
export interface FlowPyBlock {
  from: number;
  to: number;
  /** Cells processed (cost). */
  processed: number;
  /** Release cells reaching the target, in start order, and their travel angle there. */
  startCells: Int32Array;
  startAngles: Float64Array;
  /** Largest zδ of a target record reached (-Infinity: none). */
  bestZDelta: number;
  /** Target flux, record by record (summed in this order): cell and flux. */
  fluxCells: Int32Array;
  fluxValues: Float64Array;
  /** Path cells in order of first appearance in the block, with their largest zδ. */
  pathCells: Int32Array;
  pathZDelta: Float32Array;
}

/** Runs blocks of release cells of one plan (keeps its working memory between blocks). */
export type FlowPyBlockRunner = (from: number, to: number) => FlowPyBlock;

export function createFlowPyBlockRunner(
  grid: FlowPyGrid,
  terrain: FlowPyTerrain,
  target: FlowPyTarget,
  run: FlowPyRun,
  plan: FlowPyPlan,
): FlowPyBlockRunner {
  const { width, cell, altitude } = grid;
  const count = altitude.length;
  const tanAlpha = Math.tan((run.alphaDeg * Math.PI) / 180);
  const { fsi } = run;
  const { interior, routing: routeWeight } = terrain;
  const { starts, need } = plan;

  const isTarget = new Uint8Array(count);
  for (const i of target.cells) isTarget[i] = 1;

  const records = new Records();
  const pendingOf = new Int32Array(count).fill(-1);
  const touched: number[] = [];
  const pathZDelta = new Float32Array(count);

  const zdn = new Float64Array(8);
  const persistence = new Float64Array(8);
  const routing = new Float64Array(8);
  const dist = new Float64Array(8);
  const order = new Int8Array(8);
  const reached: number[] = [];
  // Per direction: index offset to the neighbour and plan step (m).
  const offset = new Int32Array(8);
  const step = new Float64Array(8);
  for (let k = 0; k < 8; k++) {
    offset[k] = DR[k]! * width + DC[k]!;
    step[k] = DS[k]! * cell;
  }

  const noFrictionZ = (FLOWPY_FOREST_FRICTION.velocityLimit ** 2) / (Math.SQRT2 * G);
  const noDetrainmentZ = (FLOWPY_FOREST_DETRAINMENT.velocityLimit ** 2) / (Math.SQRT2 * G);

  return (from, to) => {
    const startCells: number[] = [];
    const startAngles: number[] = [];
    const fluxCells: number[] = [];
    const fluxValues: number[] = [];
    const pathCells: number[] = [];
    let bestZDelta = -Infinity;
    let processed = 0;

    for (let s = from; s < to; s++) {
      const start = starts[s]!;
      records.reset();
      for (const i of touched) pendingOf[i] = -1;
      touched.length = 0;
      reached.length = 0;
      const startZ = altitude[start]!;
      records.add(start, 1, 0, -1, 0);
      records.viable[0] = 1;
      let viable = 1;
      let startAngle = -Infinity;

      for (let r = 0; r < records.count; r++) {
        // No pending cell has the energy to get there any more: a cell short of
        // it only feeds cells short of it, so nothing else can reach the target.
        if (viable === 0 && !run.exhaustive) break;
        const i = records.cell[r]!;
        if (pendingOf[i] === r) pendingOf[i] = -1;
        if (records.viable[r]) viable--;
        const z = altitude[i]!;
        const zDelta = records.zDelta[r]!;
        const isStart = r === 0;

        // Shortest plan path from the release cell (travel angle).
        if (!isStart) {
          let best = Infinity;
          for (let e = records.edgeHead[r]!; e >= 0; e = records.edgeNext[e]!) {
            const d = records.minDist[records.edgeParent[e]!]! + step[records.edgeDir[e]!]!;
            if (d < best) best = d;
          }
          records.minDist[r] = best;
        }

        // Energy line to each neighbour, α raised in forest (never at the release cell).
        const forest = fsi ? fsi[i]! : 0;
        let alphaTan = tanAlpha;
        if (!isStart && forest > 0) {
          const { maxAddedDeg, minAddedDeg } = FLOWPY_FOREST_FRICTION;
          let added: number = minAddedDeg;
          if (zDelta < noFrictionZ) {
            const rest = maxAddedDeg * forest;
            const slope = (rest - minAddedDeg) / -noFrictionZ;
            added = Math.max(minAddedDeg, slope * zDelta + rest);
          }
          alphaTan = Math.tan(((run.alphaDeg + added) * Math.PI) / 180);
        }

        // Persistence: the flow keeps the heading it came with.
        const firstParent = records.firstParent[r]!;
        if (isStart || firstParent === 0) {
          for (let k = 0; k < 8; k++) persistence[k] = 1;
        } else {
          for (let k = 0; k < 8; k++) persistence[k] = 0;
          let blocked = 0;
          for (let e = records.edgeHead[r]!; e >= 0; e = records.edgeNext[e]!) {
            const ahead = records.edgeDir[e]!;
            const weight = records.zDelta[records.edgeParent[e]!]!;
            blocked |= 1 << ((ahead + 4) & 7); // never back to a parent
            persistence[ahead]! += weight;
            persistence[(ahead + 1) & 7]! += 0.707 * weight;
            persistence[(ahead + 7) & 7]! += 0.707 * weight;
          }
          for (let k = 0; k < 8; k++) if (blocked & (1 << k)) persistence[k] = 0;
        }

        // Energy height at each neighbour, then terrain routing (Holmgren) times
        // persistence on the reachable ones.
        let weighted = 0;
        for (let k = 0; k < 8; k++) {
          const value = zDelta + (z - altitude[i + offset[k]!]!) - step[k]! * alphaTan;
          const zk = value < 0 ? 0 : value > FLOWPY_MAX_Z_DELTA_M ? FLOWPY_MAX_Z_DELTA_M : value;
          zdn[k] = zk;
          const p = persistence[k]!;
          const weight = zk > 0 && p > 0 ? routeWeight[i * 8 + k]! * p : 0;
          routing[k] = weight;
          weighted += weight;
        }

        let flux = records.flux[r]!;
        if (!isStart) {
          if (fsi) {
            // Detrainment (every cell of a run with a forest layer, as in Flow-Py).
            const { max, min } = FLOWPY_FOREST_DETRAINMENT;
            const rest = max * forest;
            const slope = (rest - min) / -noDetrainmentZ;
            flux = Math.max(MIN_FLUX_AFTER_DETRAINMENT, flux - Math.max(min, slope * zDelta + rest));
            records.flux[r] = flux;
          }
          if (isTarget[i]) {
            const angle = (Math.atan((startZ - z) / records.minDist[r]!) * 180) / Math.PI;
            if (angle > startAngle) startAngle = angle;
          }
        } else if (isTarget[i]) {
          startAngle = Math.max(startAngle, 0);
        }
        if (isTarget[i]) {
          reached.push(r);
          fluxCells.push(i);
          fluxValues.push(flux);
          if (zDelta > bestZDelta) bestZDelta = zDelta;
        }

        // Distribution R_n = T_n·P_n / Σ(T·P) · flux; shares under the threshold go to the others.
        if (weighted <= 0) continue;
        let kept = 0;
        let below = 0;
        for (let k = 0; k < 8; k++) {
          dist[k] = (routing[k]! / weighted) * flux;
          if (dist[k]! >= FLOWPY_FLUX_THRESHOLD) kept++;
          else below += dist[k]!;
        }
        if (kept === 0) continue; // everything deposits here
        let total = 0;
        for (let k = 0; k < 8; k++) {
          if (dist[k]! >= FLOWPY_FLUX_THRESHOLD) dist[k]! += below / kept;
          else dist[k] = 0;
          total += dist[k]!;
        }
        if (total !== flux) {
          const correction = (flux - total) / kept;
          for (let k = 0; k < 8; k++) if (dist[k]! > 0) dist[k]! += correction;
        }

        // Children, lowest zδ first (Flow-Py order): stable insertion sort of
        // the directions that receive a share (sorting all 8 then skipping the
        // others gives the same order: zδ is finite around an interior cell).
        let routed = 0;
        for (let k = 0; k < 8; k++) {
          if (dist[k]! < FLOWPY_FLUX_THRESHOLD) continue;
          let j = routed++;
          while (j > 0 && zdn[order[j - 1]!]! > zdn[k]!) {
            order[j] = order[j - 1]!;
            j--;
          }
          order[j] = k;
        }
        for (let o = 0; o < routed; o++) {
          const k = order[o]!;
          const share = dist[k]!;
          const n = i + offset[k]!;
          const pending = pendingOf[n]!;
          if (pending > r) {
            records.flux[pending]! += share;
            records.addParent(pending, r, k);
            if (zdn[k]! > records.zDelta[pending]!) {
              records.zDelta[pending] = zdn[k]!;
              if (!records.viable[pending] && zdn[k]! >= need[n]! - 1e-6) {
                records.viable[pending] = 1;
                viable++;
              }
            }
            continue;
          }
          if (!interior[n] || records.count >= MAX_RECORDS_PER_START) continue;
          const child = records.add(n, share, zdn[k]!, r, k);
          pendingOf[n] = child;
          touched.push(n);
          if (zdn[k]! >= need[n]! - 1e-6) {
            records.viable[child] = 1;
            viable++;
          }
        }
      }


      processed += records.count;
      if (reached.length === 0) continue;
      startCells.push(start);
      startAngles.push(startAngle);
      traceBack(records, reached, pathZDelta, pathCells);
    }

    const block: FlowPyBlock = {
      from,
      to,
      processed,
      startCells: Int32Array.from(startCells),
      startAngles: Float64Array.from(startAngles),
      bestZDelta,
      fluxCells: Int32Array.from(fluxCells),
      fluxValues: Float64Array.from(fluxValues),
      pathCells: Int32Array.from(pathCells),
      pathZDelta: Float32Array.from(pathCells, (i) => pathZDelta[i]!),
    };
    for (const i of pathCells) pathZDelta[i] = 0;
    return block;
  };
}

/**
 * Merges blocks in start order into a run result. Stops taking blocks once
 * the run reached its cost bound (`full`): the lowest release cells are then
 * left out, at block granularity.
 */
export class FlowPyMerger {
  private readonly target: FlowPyTarget;
  private readonly plan: FlowPyPlan;
  private readonly maxRecords: number;
  private readonly targetFlux: Float64Array;
  private readonly pathZDelta: Float32Array;
  private readonly pathCells: number[] = [];
  private readonly startCells: number[] = [];
  private readonly startAngles: number[] = [];
  private bestAngle = -Infinity;
  private bestZDelta = -Infinity;
  private processed = 0;
  private next = 0;
  private incomplete = false;

  constructor(count: number, target: FlowPyTarget, plan: FlowPyPlan, maxRecords = MAX_RECORDS_PER_RUN) {
    this.target = target;
    this.plan = plan;
    this.maxRecords = maxRecords;
    this.targetFlux = new Float64Array(count);
    this.pathZDelta = new Float32Array(count);
  }

  /** The next block wanted: none once every start is merged or the cost bound is reached. */
  get done(): boolean {
    return this.incomplete || this.next >= this.plan.starts.length;
  }

  /** Index of the first start of the next block to merge. */
  get nextStart(): number {
    return this.next;
  }

  add(block: FlowPyBlock): void {
    if (block.from !== this.next) throw new Error(`Flow-Py block out of order: ${block.from}, expected ${this.next}`);
    if (this.done) return;
    this.next = block.to;
    this.processed += block.processed;
    for (let k = 0; k < block.startCells.length; k++) {
      this.startCells.push(block.startCells[k]!);
      const angle = block.startAngles[k]!;
      this.startAngles.push(angle);
      if (angle > this.bestAngle) this.bestAngle = angle;
    }
    if (block.bestZDelta > this.bestZDelta) this.bestZDelta = block.bestZDelta;
    for (let k = 0; k < block.fluxCells.length; k++) this.targetFlux[block.fluxCells[k]!] += block.fluxValues[k]!;
    for (let k = 0; k < block.pathCells.length; k++) {
      const i = block.pathCells[k]!;
      const z = block.pathZDelta[k]!;
      if (this.pathZDelta[i] === 0) this.pathCells.push(i);
      if (z > this.pathZDelta[i]!) this.pathZDelta[i] = z;
    }
    if (this.next < this.plan.starts.length && this.processed >= this.maxRecords) this.incomplete = true;
  }

  result(): FlowPyResult {
    const { startCells, pathCells } = this;
    let routFluxSum = 0;
    for (const i of this.target.cells) routFluxSum = Math.max(routFluxSum, this.targetFlux[i]!);
    return {
      startCells: Int32Array.from(startCells),
      startTravelAngleDeg: Float32Array.from(this.startAngles),
      travelAngleDeg: startCells.length > 0 ? this.bestAngle : null,
      zDeltaM: startCells.length > 0 ? Math.max(0, this.bestZDelta) : null,
      routFluxSum,
      pathCells: Int32Array.from(pathCells),
      pathZDelta: Float32Array.from(pathCells, (i) => this.pathZDelta[i]!),
      candidates: this.plan.starts.length,
      processed: this.processed,
      incomplete: this.incomplete,
    };
  }
}

/** Runs Flow-Py from every release cell that may reach the target, here, block after block. */
export function runFlowPyToTarget(grid: FlowPyGrid, terrain: FlowPyTerrain, target: FlowPyTarget, run: FlowPyRun): FlowPyResult {
  const plan = planFlowPyRun(grid, terrain, target, run);
  const runBlock = createFlowPyBlockRunner(grid, terrain, target, run, plan);
  const merger = new FlowPyMerger(grid.altitude.length, target, plan);
  while (!merger.done) {
    const from = merger.nextStart;
    merger.add(runBlock(from, Math.min(plan.starts.length, from + FLOWPY_BLOCK_STARTS)));
  }
  return merger.result();
}

/** Marks the cells of every path from the release cell to the reached target records. */
function traceBack(records: Records, reached: readonly number[], pathZDelta: Float32Array, pathCells: number[]): void {
  const seen = new Uint8Array(records.count);
  const stack = [...reached];
  for (const r of reached) seen[r] = 1;
  while (stack.length > 0) {
    const r = stack.pop()!;
    const i = records.cell[r]!;
    const z = Math.max(records.zDelta[r]!, 1e-3);
    if (pathZDelta[i] === 0) pathCells.push(i);
    if (z > pathZDelta[i]!) pathZDelta[i] = z;
    for (let e = records.edgeHead[r]!; e >= 0; e = records.edgeNext[e]!) {
      const p = records.edgeParent[e]!;
      if (!seen[p]) {
        seen[p] = 1;
        stack.push(p);
      }
    }
  }
}
