// ============================================
// LiDAR viewer tools — potential avalanche release areas (PRA)
// ============================================
//
// Veitinger et al. (2016) fuzzy-logic PRA as used by AutoATES v2.0/v3.0:
// Cauchy memberships of slope, wind shelter and forest density combined
// with Werners' "fuzzy AND"
//
//   μ = (1 − m)·m + m·mean(μs, μw, μf),   m = min(μs, μw, μf)
//
// then thresholded and cleaned of release areas too small to produce an
// avalanche that runs. Wind shelter is Plattner's index: the median, over a
// 60 m disc, of the angle from the cell up (or down) to its neighbours —
// positive in a hollow or below a ridge where wind deposits snow, negative on
// an exposed crest. Everything here is terrain: no snow depth, no weather.

import type { AnalysisGrid } from '../terrainField';
import {
  FOREST_MEMBERSHIP,
  PRA_MIN_AREA_M2,
  WIND_SHELTER_MEMBERSHIP,
  WIND_SHELTER_QUANTILE,
  WIND_SHELTER_RADIUS_M,
  type AvalancheScenarioParams,
  type CauchyParams,
} from './params';

export type TerrainGrid = Pick<AnalysisGrid, 'width' | 'height' | 'cell' | 'altitude' | 'slopeDeg'>;

export function cauchy(x: number, p: CauchyParams): number {
  return 1 / (1 + Math.pow(Math.abs((x - p.c) / p.a), 2 * p.b));
}

/** Werners' fuzzy AND of three memberships (monotone in each of them). */
export function fuzzyAnd(slope: number, wind: number, forest: number): number {
  const m = Math.min(slope, wind, forest);
  return (1 - m) * m + (m * (slope + wind + forest)) / 3;
}

/** Wind shelter index per cell (radians), NaN where not computed yet. */
export class WindShelterField {
  readonly values: Float32Array;
  private readonly grid: TerrainGrid;
  private readonly offsets: Int32Array;
  private readonly offsetCol: Int16Array;
  private readonly offsetRow: Int16Array;
  private readonly radius: number;
  private readonly offsetDist: Float32Array;
  private readonly scratch: Float64Array;

  constructor(grid: TerrainGrid) {
    this.grid = grid;
    this.values = new Float32Array(grid.width * grid.height).fill(Number.NaN);
    const radius = Math.max(2, Math.round(WIND_SHELTER_RADIUS_M / grid.cell));
    this.radius = radius;
    const offsets: number[] = [];
    const cols: number[] = [];
    const rows: number[] = [];
    const dists: number[] = [];
    for (let dr = -radius; dr <= radius; dr++) {
      for (let dc = -radius; dc <= radius; dc++) {
        if ((dc === 0 && dr === 0) || dc * dc + dr * dr > radius * radius) continue;
        offsets.push(dr * grid.width + dc);
        cols.push(dc);
        rows.push(dr);
        dists.push(Math.hypot(dc, dr) * grid.cell);
      }
    }
    this.offsets = Int32Array.from(offsets);
    this.offsetCol = Int16Array.from(cols);
    this.offsetRow = Int16Array.from(rows);
    this.offsetDist = Float32Array.from(dists);
    this.scratch = new Float64Array(offsets.length);
  }

  /** Index at cell `i`, computed on first use. */
  at(i: number): number {
    const cached = this.values[i]!;
    if (!Number.isNaN(cached)) return cached;
    const value = this.compute(i);
    this.values[i] = value;
    return value;
  }

  private compute(i: number): number {
    const { width, height, altitude } = this.grid;
    const z = altitude[i]!;
    if (!Number.isFinite(z)) return 0;
    const col = i % width;
    const row = (i - col) / width;
    const r = this.radius;
    const inside = col >= r && row >= r && col + r < width && row + r < height;
    const values = this.scratch;
    let n = 0;
    for (let k = 0; k < this.offsets.length; k++) {
      if (!inside) {
        const c = col + this.offsetCol[k]!;
        const r = row + this.offsetRow[k]!;
        if (c < 0 || r < 0 || c >= width || r >= height) continue;
      }
      const zn = altitude[i + this.offsets[k]!]!;
      if (!Number.isFinite(zn)) continue;
      // Monotone in the angle: select on the gradient, take the angle at the end.
      values[n++] = (zn - z) / this.offsetDist[k]!;
    }
    // Plattner's index needs the neighbourhood; a cell on the scene edge
    // keeps the part of its disc inside the scene.
    if (n === 0) return 0;
    const position = WIND_SHELTER_QUANTILE * (n - 1);
    const k = Math.floor(position);
    const fraction = position - k;
    const low = selectKth(values, n, k);
    if (fraction === 0 || k + 1 >= n) return Math.atan(low);
    let high = Infinity;
    for (let j = k + 1; j < n; j++) if (values[j]! < high) high = values[j]!;
    // Linear interpolation between order statistics of the angles (numpy quantile).
    return Math.atan(low) + fraction * (Math.atan(high) - Math.atan(low));
  }
}

/** k-th smallest of `values[0..n)` (Hoare quickselect, reorders in place). */
function selectKth(values: Float64Array, n: number, k: number): number {
  let lo = 0;
  let hi = n - 1;
  while (lo < hi) {
    const pivot = values[(lo + hi) >> 1]!;
    let i = lo;
    let j = hi;
    while (i <= j) {
      while (values[i]! < pivot) i++;
      while (values[j]! > pivot) j--;
      if (i <= j) {
        const t = values[i]!;
        values[i] = values[j]!;
        values[j] = t;
        i++;
        j--;
      }
    }
    if (k <= j) hi = j;
    else if (k >= i) lo = i;
    else break;
  }
  return values[k]!;
}

export interface ReleaseAreas {
  /** Continuous PRA value 0–1. */
  pra: Float32Array;
  /** 1 on potential release cells (above the threshold, large enough). */
  release: Uint8Array;
}

/**
 * PRA of one scenario. `canopyPct` (0–100, NaN unknown) is the forest density;
 * `null` maps open terrain only, like AutoATES run without a forest layer.
 */
export function computeReleaseAreas(
  grid: TerrainGrid,
  wind: WindShelterField,
  canopyPct: Float32Array | null,
  scenario: AvalancheScenarioParams,
): ReleaseAreas {
  const { width, height, cell, slopeDeg } = grid;
  const count = width * height;
  const pra = new Float32Array(count);
  const release = new Uint8Array(count);
  for (let i = 0; i < count; i++) {
    const slope = slopeDeg[i]!;
    if (!Number.isFinite(slope)) continue;
    const muSlope = cauchy(slope, scenario.slope);
    const canopy = canopyPct ? canopyPct[i]! : 0;
    const muForest = cauchy(Number.isFinite(canopy) ? canopy : 0, FOREST_MEMBERSHIP);
    // The wind shelter index is the costly term: skip it where even a fully
    // sheltered cell would stay under the threshold.
    if (fuzzyAnd(muSlope, 1, muForest) < scenario.praThreshold) continue;
    const muWind = cauchy(wind.at(i), WIND_SHELTER_MEMBERSHIP);
    const value = fuzzyAnd(muSlope, muWind, muForest);
    pra[i] = value;
    if (value >= scenario.praThreshold) release[i] = 1;
  }
  sieve(release, width, height, Math.ceil(PRA_MIN_AREA_M2 / (cell * cell)));
  return { pra, release };
}

/** Removes the 4-connected groups of 1 smaller than `minCells` (GDAL sieve on the release cells only). */
function sieve(mask: Uint8Array, width: number, height: number, minCells: number): void {
  const seen = new Uint8Array(mask.length);
  const stack: number[] = [];
  const group: number[] = [];
  for (let seed = 0; seed < mask.length; seed++) {
    if (!mask[seed] || seen[seed]) continue;
    group.length = 0;
    seen[seed] = 1;
    stack.push(seed);
    while (stack.length > 0) {
      const i = stack.pop()!;
      group.push(i);
      const col = i % width;
      if (col > 0 && mask[i - 1] && !seen[i - 1]) { seen[i - 1] = 1; stack.push(i - 1); }
      if (col < width - 1 && mask[i + 1] && !seen[i + 1]) { seen[i + 1] = 1; stack.push(i + 1); }
      if (i >= width && mask[i - width] && !seen[i - width]) { seen[i - width] = 1; stack.push(i - width); }
      if (i < (height - 1) * width && mask[i + width] && !seen[i + width]) { seen[i + width] = 1; stack.push(i + width); }
    }
    if (group.length < minCells) for (const i of group) mask[i] = 0;
  }
}
