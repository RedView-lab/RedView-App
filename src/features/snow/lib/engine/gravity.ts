// ============================================================================
// Snow engine v2 — gravitational transport (SnowSlide release + MTD runout)
// ----------------------------------------------------------------------------
// Release, Bernhardt & Schulz (2010) as implemented in CHM and used by Quéno
// et al. (2024): every cell steeper than 25° (snow surface) keeps at most its
// holding depth h = mult·S^pow m vertically (see the config: 3.5 m at 30°,
// 2.0 m at 40°, 1.3 m at 50°); a cell hit by sliding snow holds 30 % less
// (momentum). Beyond 60° the holding depth tapers to Bernhardt & Schulz's
// 5 cm SWE floor (~15 cm of snow) at 75°: snow does not stay on rock walls.
//
// Runout, after Gruber's (2007) mass-conserving transport and deposition: the
// moving snow is carried from cell to cell (multiple flow directions, weights
// ∝ snow-surface drop / distance) and each cell takes at most
// Dmax·(1 − S/Slim) of it, so deposits build up along the runout instead of
// piling into one cell. The moving snow stops where its energy line — drawn
// from the release at the runout angle α, as in Flow-Py (D'Amboise et al.
// 2022) and AutoATES (α = 30° for frequent avalanches, those that move most of
// a season's snow) — falls below the snow surface. Cells are processed from
// the highest snow surface down, so a release runs out in one sweep; slopes
// and flow directions come from the snow surface at the start of the pass.
// ============================================================================

import type { SnowEngineConfig } from './config';
import { boxMean, type WorkGrid } from './grid';

export function holdingDepthCm(slopeDeg: number, config: SnowEngineConfig): number {
  if (slopeDeg < config.triggerSlopeDeg) return Number.POSITIVE_INFINITY;
  const s = Math.max(10, slopeDeg);
  if (s <= 60) return Math.min(20, config.holdingMult * Math.pow(s, config.holdingPow)) * 100;
  const h60 = config.holdingMult * Math.pow(60, config.holdingPow);
  const tau = 15 / Math.log(Math.max(1.01, h60 / 0.15));
  return Math.max(0.05, h60 * Math.exp(-(s - 60) / tau)) * 100;
}

/** Share of the moving snow a cell of that slope can take, cm (Gruber 2007). */
function depositCapacityCm(slopeDeg: number, config: SnowEngineConfig): number {
  return slopeDeg >= config.depositLimitDeg ? 0 : config.depositMaxCm * (1 - slopeDeg / config.depositLimitDeg);
}

const NX = [1, 1, 0, -1, -1, -1, 0, 1];
const NY = [0, 1, 1, 1, 0, -1, -1, -1];

/**
 * `order` (cell indices) sorted by decreasing `keys`, ties in increasing
 * index: exactly the permutation of a stable `order.sort((a, b) => keys[b] -
 * keys[a])` on the identity (for doubles, a − b = 0 only when a = b), from a
 * stable LSD radix sort of the IEEE-754 bits — 4-6× faster than the
 * comparator sort, which cost ~85 ms per pass on a 640² grid.
 */
function sortByDecreasingKey(keys: Float64Array, order: Int32Array, scratch: RadixScratch): void {
  const n = keys.length;
  const { hi, lo, tmp, count } = scratch;
  const f64 = new Float64Array(1);
  const u32 = new Uint32Array(f64.buffer);
  const hiWord = new Uint8Array(new Uint16Array([1]).buffer)[0] === 1 ? 1 : 0;
  for (let i = 0; i < n; i++) {
    f64[0] = keys[i] + 0; // −0 → +0: the comparator ties them
    let h = u32[hiWord];
    let l = u32[1 - hiWord];
    // Order-preserving unsigned key, then complemented for a decreasing order.
    if (h & 0x80000000) { h = ~h >>> 0; l = ~l >>> 0; } else h = (h | 0x80000000) >>> 0;
    hi[i] = ~h >>> 0;
    lo[i] = ~l >>> 0;
  }
  let src = order;
  let dst = tmp;
  for (let i = 0; i < n; i++) src[i] = i;
  for (let pass = 0; pass < 4; pass++) {
    const digits = pass < 2 ? lo : hi;
    const shift = (pass & 1) * 16;
    count.fill(0);
    for (let i = 0; i < n; i++) count[(digits[src[i]] >>> shift) & 0xffff]++;
    let sum = 0;
    for (let b = 0; b < 65536; b++) { const c = count[b]; count[b] = sum; sum += c; }
    for (let i = 0; i < n; i++) { const j = src[i]; dst[count[(digits[j] >>> shift) & 0xffff]++] = j; }
    const t = src; src = dst; dst = t;
  }
  // Four passes: the result is back in `order`.
}

interface RadixScratch { hi: Uint32Array; lo: Uint32Array; tmp: Int32Array; count: Uint32Array }

function radixScratch(n: number): RadixScratch {
  return { hi: new Uint32Array(n), lo: new Uint32Array(n), tmp: new Int32Array(n), count: new Uint32Array(65536) };
}

/**
 * Debris cones: the snow deposited during the pass (`gain`) slumps until no
 * deposit stands steeper than the angle of repose above a neighbour (sandpile
 * relaxation, mass-conserving). Only the fresh deposit moves, never the
 * standing snowpack.
 */
function relaxDeposits(hs: Float32Array, gain: Float32Array, z: Float32Array, w: number, h: number, dist: number[], tanRepose: number): void {
  const n = w * h;
  // LIFO work list: a cell is in it at most once (`queued`), so n slots suffice.
  const queue = new Int32Array(n);
  let top = 0;
  const queued = new Uint8Array(n);
  for (let i = 0; i < n; i++) if (gain[i] > 50) { queue[top++] = i; queued[i] = 1; }
  const reposeDrop = dist.map((d) => d * tanRepose);
  const excess = new Float64Array(8);
  let budget = 40 * n;
  while (top > 0 && budget-- > 0) {
    const i = queue[--top];
    queued[i] = 0;
    if (gain[i] <= 1) continue;
    const x = i % w;
    const y = (i - x) / w;
    const si = z[i] + hs[i] / 100;
    let total = 0;
    for (let k = 0; k < 8; k++) {
      excess[k] = 0;
      const nx = x + NX[k];
      const ny = y + NY[k];
      if (nx < 0 || ny < 0 || nx >= w || ny >= h) continue;
      const j = ny * w + nx;
      const e = si - (z[j] + hs[j] / 100) - reposeDrop[k];
      if (e > 0.01) { excess[k] = e; total += e; }
    }
    if (total <= 0) continue;
    // Move half of the largest excess (cm), at most the fresh deposit.
    let maxE = 0;
    for (let k = 0; k < 8; k++) maxE = Math.max(maxE, excess[k]);
    const amount = Math.min(gain[i], 50 * maxE);
    if (amount <= 0.5) continue;
    hs[i] -= amount;
    gain[i] -= amount;
    for (let k = 0; k < 8; k++) {
      if (excess[k] <= 0) continue;
      const j = (y + NY[k]) * w + (x + NX[k]);
      const share = (amount * excess[k]) / total;
      hs[j] += share;
      gain[j] += share;
      if (!queued[j]) { queue[top++] = j; queued[j] = 1; }
    }
    if (!queued[i]) { queue[top++] = i; queued[i] = 1; }
  }
}

/**
 * Runs the gravitational transport in place on `hs` (vertical depth, cm).
 * Returns the share of the snow mass that changed place, and the share that
 * reached the grid edge (given back to the runout zones).
 */
export function snowSlide(hs: Float32Array, grid: WorkGrid, config: SnowEngineConfig, passes = config.gravityPasses): { moved: number; lost: number } {
  const { width: w, height: h, z, dx, dy } = grid;
  const n = w * h;
  let total = 0;
  for (let i = 0; i < n; i++) total += hs[i];
  if (total <= 0) return { moved: 0, lost: 0 };
  const dist = NX.map((x, k) => Math.hypot(x * dx, NY[k] * dy));
  const surf = new Float64Array(n);
  const slopeOf = new Float32Array(n);
  const order = new Int32Array(n);
  const flux = new Float32Array(n);
  /** Mass-weighted energy-line altitude of the snow moving into each cell, m. */
  const energy = new Float64Array(n);
  const tanAlpha = Math.tan((config.runoutAlphaDeg * Math.PI) / 180);
  const holdTable = new Float32Array(901);
  const depTable = new Float32Array(901);
  for (let k = 0; k <= 900; k++) {
    holdTable[k] = holdingDepthCm(k / 10, config);
    depTable[k] = depositCapacityCm(k / 10, config);
  }
  const before = new Float32Array(hs);
  let lost = 0;
  const weights = new Float64Array(8);
  const gain = new Float32Array(n);
  const tanRepose = Math.tan((config.debrisReposeDeg * Math.PI) / 180);
  const scratch = radixScratch(n);

  for (let pass = 0; pass < passes; pass++) {
    for (let i = 0; i < n; i++) surf[i] = z[i] + hs[i] / 100;
    // Slopes and flow directions come from the snow surface at the start of
    // the pass: read on the fly, the not-yet-processed cells below (loaded with
    // what they already received) would flatten the slope or even rise above
    // the cell and stop the release. The holding slope is read at the scale
    // the curves were calibrated at (`gravitySlopeScaleM`).
    const radius = Math.floor(config.gravitySlopeScaleM / (dx + dy));
    const surfSlope = radius >= 1 ? boxMean(new Float32Array(surf), w, h, radius) : surf;
    const step = Math.max(1, radius);
    for (let y = 0; y < h; y++) {
      const ym = Math.max(0, y - step), yp = Math.min(h - 1, y + step);
      for (let x = 0; x < w; x++) {
        const xm = Math.max(0, x - step), xp = Math.min(w - 1, x + step);
        const sxv = (surfSlope[y * w + xp] - surfSlope[y * w + xm]) / ((xp - xm) * dx);
        const syv = (surfSlope[yp * w + x] - surfSlope[ym * w + x]) / ((yp - ym) * dy);
        slopeOf[y * w + x] = Math.atan(Math.hypot(sxv, syv)) * (180 / Math.PI);
      }
    }
    sortByDecreasingKey(surf, order, scratch);
    flux.fill(0);
    energy.fill(0);
    gain.fill(0);
    let released = 0;
    for (let o = 0; o < n; o++) {
      const i = order[o];
      const tableIdx = Math.min(900, Math.round(slopeOf[i] * 10));
      let moving = flux[i];
      flux[i] = 0;
      let energyAlt = energy[i];
      // Incoming snow whose energy line has fallen below the surface stops
      // here (added after the release below: it does not release again).
      let stopped = 0;
      if (moving > 0 && energyAlt <= surf[i]) {
        stopped = moving;
        moving = 0;
      }
      let hold = holdTable[tableIdx];
      if (Number.isFinite(hold)) {
        // Hit by sliding snow, a cell holds less (momentum): up to −30 % when
        // the incoming snow is as deep as what it holds.
        if (moving > 0) hold *= 1 - (1 - config.holdingReceiveFactor) * Math.min(1, moving / hold);
        if (hs[i] > hold) {
          const rel = hs[i] - hold;
          released += rel;
          energyAlt = moving > 0 ? (energyAlt * moving + surf[i] * rel) / (moving + rel) : surf[i];
          moving += rel;
          hs[i] = hold;
        }
      }
      if (stopped > 0) {
        hs[i] += stopped;
        gain[i] += stopped;
      }
      if (moving <= 1e-3) continue;
      let dep = Math.min(moving, depTable[tableIdx]);
      if (Number.isFinite(hold)) dep = Math.min(dep, Math.max(0, hold - hs[i]));
      hs[i] += dep;
      gain[i] += dep;
      moving -= dep;
      if (moving <= 1e-3) continue;
      const x = i % w;
      const y = (i - x) / w;
      const zi = surf[i];
      let wsum = 0;
      let outW = 0;
      for (let k = 0; k < 8; k++) {
        const nx = x + NX[k];
        const ny = y + NY[k];
        weights[k] = 0;
        if (nx < 0 || ny < 0 || nx >= w || ny >= h) {
          // Off the grid: extrapolate the surface from the opposite neighbour.
          const ox = x - NX[k];
          const oy = y - NY[k];
          if (ox < 0 || oy < 0 || ox >= w || oy >= h) continue;
          const drop = surf[oy * w + ox] - zi;
          if (drop > 0) outW += drop / dist[k];
          continue;
        }
        const drop = zi - surf[ny * w + nx];
        if (drop > 0) { weights[k] = drop / dist[k]; wsum += weights[k]; }
      }
      if (wsum + outW <= 0) {
        // Level ground: spread over the neighbours at the same level; a true
        // pit keeps it.
        for (let k = 0; k < 8; k++) {
          const nx = x + NX[k];
          const ny = y + NY[k];
          if (nx < 0 || ny < 0 || nx >= w || ny >= h) continue;
          if (zi - surf[ny * w + nx] > -0.05) { weights[k] = 1; wsum += 1; }
        }
        if (wsum <= 0) {
          hs[i] += moving;
          gain[i] += moving;
          continue;
        }
      }
      const norm = 1 / (wsum + outW);
      for (let k = 0; k < 8; k++) {
        if (weights[k] <= 0) continue;
        const j = (y + NY[k]) * w + (x + NX[k]);
        const m = moving * weights[k] * norm;
        const e = energyAlt - dist[k] * tanAlpha;
        energy[j] = flux[j] > 0 ? (energy[j] * flux[j] + e * m) / (flux[j] + m) : e;
        flux[j] += m;
      }
      lost += moving * outW * norm;
    }
    // Snow handed to a cell already processed (same level) settles there.
    for (let i = 0; i < n; i++) if (flux[i] > 0) { hs[i] += flux[i]; gain[i] += flux[i]; }
    relaxDeposits(hs, gain, z, w, h, dist, tanRepose);
    if (released < 1e-4 * total) break;
  }
  // What left the tile is matched by what slides in from the slopes above it,
  // outside the tile: the outflow is given back to the runout zones (cells
  // that gained snow), so the tile keeps the mass of its coarse cells.
  if (lost > 0) {
    let gained = 0;
    for (let i = 0; i < n; i++) gained += Math.max(0, hs[i] - before[i]);
    if (gained > 0) {
      const k = lost / gained;
      for (let i = 0; i < n; i++) {
        const g = hs[i] - before[i];
        if (g > 0) hs[i] += g * k;
      }
    }
  }
  let changed = 0;
  for (let i = 0; i < n; i++) changed += Math.abs(hs[i] - before[i]);
  return { moved: changed / 2 / total, lost: lost / total };
}
