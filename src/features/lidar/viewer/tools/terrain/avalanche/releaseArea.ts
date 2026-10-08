// ============================================
// Outils du viewer LiDAR — zones de départ potentielles d'avalanche (PRA)
// ============================================
//
// PRA en logique floue de Veitinger et al. (2016) telle qu'utilisée par
// AutoATES v2.0/v3.0 : appartenances de Cauchy de la pente, de l'abri au vent
// et de la densité de forêt, combinées par le « ET flou » de Werners
//
//   μ = (1 − m)·m + m·mean(μs, μw, μf),   m = min(μs, μw, μf)
//
// puis seuillées et débarrassées des zones de départ trop petites pour
// produire une avalanche qui s'écoule. L'abri au vent est l'indice de
// Plattner : la médiane, sur un disque de 60 m, de l'angle de la cellule vers
// le haut (ou le bas) de ses voisines — positif dans un creux ou sous une crête
// où le vent dépose la neige, négatif sur une arête exposée. Tout ici est du
// terrain : pas de hauteur de neige, pas de météo.

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

function cauchy(x: number, p: CauchyParams): number {
  return 1 / (1 + Math.pow(Math.abs((x - p.c) / p.a), 2 * p.b));
}

/** ET flou de Werners de trois appartenances (monotone en chacune). */
function fuzzyAnd(slope: number, wind: number, forest: number): number {
  const m = Math.min(slope, wind, forest);
  return (1 - m) * m + (m * (slope + wind + forest)) / 3;
}

/** Indice d'abri au vent par cellule (radians), NaN là où il n'est pas encore calculé. */
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

  /** Indice à la cellule `i`, calculé au premier usage. */
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
      // Monotone en l'angle : sélectionner sur le gradient, prendre l'angle à la fin.
      values[n++] = (zn - z) / this.offsetDist[k]!;
    }
    // L'indice de Plattner a besoin du voisinage ; une cellule au bord de la
    // scène garde la partie de son disque qui est dans la scène.
    if (n === 0) return 0;
    const position = WIND_SHELTER_QUANTILE * (n - 1);
    const k = Math.floor(position);
    const fraction = position - k;
    const low = selectKth(values, n, k);
    if (fraction === 0 || k + 1 >= n) return Math.atan(low);
    let high = Infinity;
    for (let j = k + 1; j < n; j++) if (values[j]! < high) high = values[j]!;
    // Interpolation linéaire entre statistiques d'ordre des angles (quantile numpy).
    return Math.atan(low) + fraction * (Math.atan(high) - Math.atan(low));
  }
}

/** k-ième plus petit de `values[0..n)` (quickselect de Hoare, réordonne sur place). */
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
  /** Valeur PRA continue 0–1. */
  pra: Float32Array;
  /** 1 sur les cellules de départ potentielles (au-dessus du seuil, assez grandes). */
  release: Uint8Array;
}

/**
 * PRA d'un scénario. `canopyPct` (0–100, NaN inconnu) est la densité de forêt ;
 * `null` ne cartographie que le terrain ouvert, comme AutoATES lancé sans couche forêt.
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
    // L'indice d'abri au vent est le terme coûteux : le sauter là où même une
    // cellule entièrement abritée resterait sous le seuil.
    if (fuzzyAnd(muSlope, 1, muForest) < scenario.praThreshold) continue;
    const muWind = cauchy(wind.at(i), WIND_SHELTER_MEMBERSHIP);
    const value = fuzzyAnd(muSlope, muWind, muForest);
    pra[i] = value;
    if (value >= scenario.praThreshold) release[i] = 1;
  }
  sieve(release, width, height, Math.ceil(PRA_MIN_AREA_M2 / (cell * cell)));
  return { pra, release };
}

/** Retire les groupes 4-connexes de 1 plus petits que `minCells` (tamis GDAL sur les seules cellules de départ). */
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
