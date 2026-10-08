// ============================================
// Outils du viewer LiDAR — requêtes sur le modèle de sol (MNT)
// ============================================
//
// Enveloppe la grille de hauteurs de la scène (retours sol, ≈ 1 m par cellule
// sur une tuile de 1 km, ligne 0 = bord sud, hauteurs relatives au centre de
// la scène) avec les requêtes dont chaque outil de terrain a besoin : altitude,
// pente/exposition, drapage et grilles plus grossières pour les modèles sur
// toute une zone (champ de vision 5 m, avalanches 10 m).

import { toWgs84, trueNorthGridBearingDeg } from '../../../lib/coordConvert';
import type { DetectedCrs } from '../../../types';
import type { ViewerRouteSceneParams } from '../../route/types';
import type { Vec3 } from '../types';

/**
 * Base (m) de la pente lue en un point. Les cartes de pentes avalanche
 * utilisent des modèles de 5–10 m : une base de 1 m lit chaque bloc et chaque
 * marche, pas la pente sur laquelle se tient un skieur ou une plaque.
 */
export const SLOPE_BASELINE_M = 6;
/** Cellule (m) de la grille d'analyse (champ de vision). */
const ANALYSIS_TARGET_CELL_M = 5;
/** Nombre maximal de cellules d'analyse (mémoire et taille du maillage de surcouche). */
const ANALYSIS_MAX_CELLS = 160_000;
/**
 * Cellule (m) de la grille de terrain avalanche : AutoATES tourne sur des
 * modèles de 10 m (Toft et al., 2024 ; peu de gain sous 5 m, Sykes et al.,
 * 2023), l'échelle des zones de départ et des couloirs plutôt que des blocs.
 */
const AVALANCHE_TARGET_CELL_M = 10;
const AVALANCHE_MAX_CELLS = 160_000;

export interface SlopeSample {
  /** Angle de pente, degrés. */
  slopeDeg: number;
  /** Azimut vrai de la direction de la ligne de pente (exposition), degrés dans le sens horaire depuis le nord. */
  aspectDeg: number;
  /** Gradient d'altitude selon les axes du CRS (m/m). */
  gradX: number;
  gradY: number;
}

/** Forme locale du sol : altitude, gradient et dérivées secondes (axes du CRS). */
export interface SurfaceSample {
  altitudeM: number;
  /** ∂z/∂x, ∂z/∂y (m/m). */
  gradX: number;
  gradY: number;
  /** ∂²z/∂x², ∂²z/∂y², ∂²z/∂x∂y (1/m). */
  hxx: number;
  hyy: number;
  hxy: number;
}

export interface DrapedSample {
  projX: number;
  projY: number;
  altitudeM: number;
  /** Distance horizontale cumulée, m. */
  distanceM: number;
  /** Distance cumulée le long de la surface du sol, m. */
  surfaceDistanceM: number;
}

/** Rééchantillonnage grossier du modèle de sol pour les analyses sur toute une zone. */
export interface AnalysisGrid {
  width: number;
  height: number;
  /** Côté de cellule, m. */
  cell: number;
  /** Position CRS du centre de la cellule (0, 0) (cellule du coin sud-ouest). */
  originX: number;
  originY: number;
  /** Altitude absolue par cellule, NaN là où la scène n'a pas de sol. */
  altitude: Float32Array;
  /** Angle de pente par cellule (degrés), NaN sans données. */
  slopeDeg: Float32Array;
}

export class TerrainField {
  readonly crs: DetectedCrs;
  readonly minX: number;
  readonly minY: number;
  readonly maxX: number;
  readonly maxY: number;
  readonly centerX: number;
  readonly centerY: number;
  readonly centerZ: number;
  /** Espacement natif de la grille, m. */
  readonly cellX: number;
  readonly cellY: number;
  private readonly grid: Float32Array;
  private readonly gridWidth: number;
  private readonly gridHeight: number;
  private readonly offsetZ: number;
  /** Gisement du nord vrai au centre de la scène (convergence des méridiens). */
  private readonly northConvergenceDeg: number;
  /** Plage d'altitude du modèle de sol, m. */
  readonly minAltitudeM: number;
  readonly maxAltitudeM: number;
  private analysis: AnalysisGrid | null = null;
  private avalanche: AnalysisGrid | null = null;

  private constructor(params: ViewerRouteSceneParams, grid: Float32Array, width: number, height: number) {
    this.crs = params.crs;
    this.minX = params.bounds.minX;
    this.minY = params.bounds.minY;
    this.maxX = params.bounds.maxX;
    this.maxY = params.bounds.maxY;
    this.centerX = params.centerX;
    this.centerY = params.centerY;
    this.centerZ = params.centerZ;
    this.grid = grid;
    this.gridWidth = width;
    this.gridHeight = height;
    this.offsetZ = params.heightGridOffsetZ ?? 0;
    this.cellX = (this.maxX - this.minX) / (width - 1);
    this.cellY = (this.maxY - this.minY) / (height - 1);
    this.northConvergenceDeg = trueNorthGridBearingDeg(this.centerX, this.centerY, this.crs);
    let min = Infinity;
    let max = -Infinity;
    for (let i = 0; i < grid.length; i++) {
      const z = grid[i]!;
      if (z < min) min = z;
      if (z > max) max = z;
    }
    const base = this.centerZ - this.offsetZ;
    this.minAltitudeM = Number.isFinite(min) ? min + base : this.centerZ;
    this.maxAltitudeM = Number.isFinite(max) ? max + base : this.centerZ;
  }

  static fromSceneParams(params: ViewerRouteSceneParams): TerrainField | null {
    const { heightGrid, gridWidth, gridHeight, bounds } = params;
    if (!heightGrid || !gridWidth || !gridHeight || gridWidth < 2 || gridHeight < 2) return null;
    if (!(bounds.maxX > bounds.minX) || !(bounds.maxY > bounds.minY)) return null;
    return new TerrainField(params, heightGrid, gridWidth, gridHeight);
  }

  /** Plus petit espacement natif, m. */
  get cell(): number {
    return Math.min(this.cellX, this.cellY);
  }

  contains(projX: number, projY: number): boolean {
    return projX >= this.minX && projX <= this.maxX && projY >= this.minY && projY <= this.maxY;
  }

  /** Altitude du sol (m, bilinéaire), `null` hors de la scène ou sur un trou. */
  altitudeAt(projX: number, projY: number): number | null {
    const gx = (projX - this.minX) / this.cellX;
    const gy = (projY - this.minY) / this.cellY;
    const w = this.gridWidth;
    if (!(gx >= 0 && gx <= w - 1 && gy >= 0 && gy <= this.gridHeight - 1)) return null;
    const x0 = Math.min(w - 2, Math.floor(gx));
    const y0 = Math.min(this.gridHeight - 2, Math.floor(gy));
    const fx = gx - x0;
    const fy = gy - y0;
    const i = y0 * w + x0;
    const g = this.grid;
    const z00 = g[i]!, z10 = g[i + 1]!, z01 = g[i + w]!, z11 = g[i + w + 1]!;
    const z = (1 - fy) * ((1 - fx) * z00 + fx * z10) + fy * ((1 - fx) * z01 + fx * z11);
    return Number.isFinite(z) ? z - this.offsetZ + this.centerZ : null;
  }

  /**
   * Pente et exposition sur `baselineM` (opérateur 3×3 de Horn sur des
   * échantillons espacés de `baselineM / 2`). `null` quand un échantillon tombe hors de la scène.
   */
  slopeAt(projX: number, projY: number, baselineM = SLOPE_BASELINE_M): SlopeSample | null {
    const r = Math.max(this.cell, baselineM / 2);
    const z = (dx: number, dy: number) => this.altitudeAt(projX + dx * r, projY + dy * r);
    const a = z(-1, 1), b = z(0, 1), c = z(1, 1);
    const d = z(-1, 0), f = z(1, 0);
    const g = z(-1, -1), h = z(0, -1), i = z(1, -1);
    if (a == null || b == null || c == null || d == null || f == null || g == null || h == null || i == null) {
      return null;
    }
    const gradX = ((c + 2 * f + i) - (a + 2 * d + g)) / (8 * r);
    const gradY = ((a + 2 * b + c) - (g + 2 * h + i)) / (8 * r);
    return this.slopeFromGradient(gradX, gradY);
  }

  /**
   * Gradient et courbure du sol sur `baselineM` (3×3 échantillons espacés de
   * `baselineM / 2` : gradient de Horn, différences secondes centrées), pour le
   * mouvement d'un corps sur la surface. `null` hors de la scène.
   */
  surfaceAt(projX: number, projY: number, baselineM: number): SurfaceSample | null {
    const r = Math.max(this.cell, baselineM / 2);
    const z = (dx: number, dy: number) => this.altitudeAt(projX + dx * r, projY + dy * r);
    const a = z(-1, 1), b = z(0, 1), c = z(1, 1);
    const d = z(-1, 0), e = z(0, 0), f = z(1, 0);
    const g = z(-1, -1), h = z(0, -1), i = z(1, -1);
    if (a == null || b == null || c == null || d == null || e == null || f == null || g == null || h == null || i == null) {
      return null;
    }
    const r2 = r * r;
    return {
      altitudeM: e,
      gradX: ((c + 2 * f + i) - (a + 2 * d + g)) / (8 * r),
      gradY: ((a + 2 * b + c) - (g + 2 * h + i)) / (8 * r),
      hxx: (d + f - 2 * e) / r2,
      hyy: (b + h - 2 * e) / r2,
      hxy: (c + g - a - i) / (4 * r2),
    };
  }

  slopeFromGradient(gradX: number, gradY: number): SlopeSample {
    const slopeDeg = (Math.atan(Math.hypot(gradX, gradY)) * 180) / Math.PI;
    // Direction de la ligne de pente (−gradient), en azimut de grille, puis vrai.
    const gridAzimuth = (Math.atan2(-gradX, -gradY) * 180) / Math.PI;
    return { slopeDeg, aspectDeg: this.gridToTrueAzimuth(gridAzimuth), gradX, gradY };
  }

  /** Azimut de grille (sens horaire depuis l'axe +Y du CRS) → azimut vrai. */
  gridToTrueAzimuth(gridAzimuthDeg: number): number {
    return (((gridAzimuthDeg - this.northConvergenceDeg) % 360) + 360) % 360;
  }

  toLocal(projX: number, projY: number, altitudeM: number): Vec3 {
    return [projX - this.centerX, altitudeM - this.centerZ, -(projY - this.centerY)];
  }

  fromLocal(local: Vec3): { projX: number; projY: number; altitudeM: number } {
    return {
      projX: local[0] + this.centerX,
      projY: this.centerY - local[2],
      altitudeM: local[1] + this.centerZ,
    };
  }

  toLonLat(projX: number, projY: number): [number, number] {
    return toWgs84(projX, projY, this.crs);
  }

  /** Altitude du sol sous une position du repère de rendu, en hauteur du repère de rendu. */
  localGroundY(x: number, z: number): number | null {
    const altitude = this.altitudeAt(x + this.centerX, this.centerY - z);
    return altitude == null ? null : altitude - this.centerZ;
  }

  /**
   * Premier croisement d'un rayon du repère de rendu avec le modèle de sol,
   * `null` s'il le manque (ciel, au-delà de la scène, ou au-dessus d'un trou).
   * Avance à peu près au pas de la grille (plus grossier au loin, comme
   * l'empreinte d'un pixel), puis procède par dichotomie.
   */
  raycast(origin: Vec3, direction: Vec3, maxDistance = Number.POSITIVE_INFINITY): { local: Vec3; distance: number } | null {
    const [ox, oy, oz] = origin;
    const [dx, dy, dz] = direction;
    let t0 = 0;
    let t1 = maxDistance;
    const slabs: Array<[number, number, number, number]> = [
      [ox, dx, this.minX - this.centerX, this.maxX - this.centerX],
      [oy, dy, this.minAltitudeM - this.centerZ - 1, this.maxAltitudeM - this.centerZ + 1],
      [oz, dz, -(this.maxY - this.centerY), -(this.minY - this.centerY)],
    ];
    for (const [o, d, lo, hi] of slabs) {
      if (Math.abs(d) < 1e-12) {
        if (o < lo || o > hi) return null;
        continue;
      }
      const a = (lo - o) / d;
      const b = (hi - o) / d;
      t0 = Math.max(t0, Math.min(a, b));
      t1 = Math.min(t1, Math.max(a, b));
      if (t0 > t1) return null;
    }
    const above = (t: number): number | null => {
      const ground = this.localGroundY(ox + dx * t, oz + dz * t);
      return ground == null ? null : oy + dy * t - ground;
    };
    let prevT = t0;
    let prev = above(t0);
    if (prev != null && prev < 0) return null; // commence sous le sol
    const baseStep = this.cell * 0.5;
    for (let t = t0; t < t1;) {
      t = Math.min(t1, t + Math.max(baseStep, t * 0.0015));
      const cur = above(t);
      if (cur != null && prev != null && cur <= 0) {
        let lo = prevT;
        let hi = t;
        for (let k = 0; k < 24; k++) {
          const mid = (lo + hi) / 2;
          const h = above(mid);
          if (h != null && h <= 0) hi = mid;
          else lo = mid;
        }
        const hit: Vec3 = [ox + dx * hi, 0, oz + dz * hi];
        hit[1] = this.localGroundY(hit[0], hit[2]) ?? oy + dy * hi;
        return { local: hit, distance: hi };
      }
      prevT = t;
      prev = cur;
      if (t >= t1) break;
    }
    return null;
  }

  /**
   * Le modèle de sol ne cache pas `point` à `eye` (repère de rendu). Sert à
   * estomper les parties d'une mesure derrière une crête ; la végétation est ignorée.
   */
  isVisibleFrom(point: Vec3, eye: Vec3): boolean {
    const vx = eye[0] - point[0];
    const vy = eye[1] - point[1];
    const vz = eye[2] - point[2];
    const length = Math.hypot(vx, vy, vz);
    if (length < 3) return true;
    const topY = this.maxAltitudeM - this.centerZ;
    const samples = Math.min(64, Math.max(8, Math.ceil(length / (this.cell * 4))));
    // Sauter les premiers mètres : le point repose sur le sol sur lequel il est dessiné.
    const start = Math.min(0.5, 2.5 / length);
    for (let k = 0; k < samples; k++) {
      const s = start + ((1 - start) * (k + 1)) / (samples + 1);
      const y = point[1] + vy * s;
      if (y > topY) return true; // au-dessus de tous les sommets à partir d'ici
      const ground = this.localGroundY(point[0] + vx * s, point[2] + vz * s);
      if (ground != null && ground > y + 0.3) return false;
    }
    return true;
  }

  /**
   * Échantillonne le sol le long d'une polyligne CRS tous les ≤ `stepM` (chaque
   * sommet gardé). Les tronçons sans sol sont sautés ; les distances continuent de compter.
   */
  drape(vertices: ReadonlyArray<{ projX: number; projY: number }>, stepM: number): DrapedSample[] {
    const out: DrapedSample[] = [];
    let distance = 0;
    let surface = 0;
    let prev: DrapedSample | null = null;
    const push = (projX: number, projY: number, distanceM: number) => {
      const altitudeM = this.altitudeAt(projX, projY);
      if (altitudeM == null) {
        prev = null;
        return;
      }
      if (prev) surface += Math.hypot(distanceM - prev.distanceM, altitudeM - prev.altitudeM);
      prev = { projX, projY, altitudeM, distanceM, surfaceDistanceM: surface };
      out.push(prev);
    };
    for (let k = 0; k < vertices.length; k++) {
      const v = vertices[k]!;
      if (k === 0) {
        push(v.projX, v.projY, 0);
        continue;
      }
      const p = vertices[k - 1]!;
      const length = Math.hypot(v.projX - p.projX, v.projY - p.projY);
      const steps = Math.max(1, Math.ceil(length / Math.max(0.05, stepM)));
      for (let s = 1; s <= steps; s++) {
        const t = s / steps;
        push(p.projX + (v.projX - p.projX) * t, p.projY + (v.projY - p.projY) * t, distance + length * t);
      }
      distance += length;
    }
    return out;
  }

  /** Grille d'analyse, construite au premier usage (cellules ≈ 5 m, au plus 160 k cellules). */
  getAnalysisGrid(): AnalysisGrid {
    if (!this.analysis) this.analysis = this.buildGrid(ANALYSIS_TARGET_CELL_M, ANALYSIS_MAX_CELLS, CELL_SAMPLES);
    return this.analysis;
  }

  /** Grille de terrain avalanche, construite au premier usage (cellules ≈ 10 m, au plus 160 k cellules). */
  getAvalancheGrid(): AnalysisGrid {
    if (!this.avalanche) this.avalanche = this.buildGrid(AVALANCHE_TARGET_CELL_M, AVALANCHE_MAX_CELLS, COARSE_CELL_SAMPLES);
    return this.avalanche;
  }

  private buildGrid(targetCell: number, maxCells: number, samples: ReadonlyArray<[number, number]>): AnalysisGrid {
    const rangeX = this.maxX - this.minX;
    const rangeY = this.maxY - this.minY;
    const cell = Math.max(targetCell, this.cell, Math.sqrt((rangeX * rangeY) / maxCells));
    const width = Math.max(2, Math.floor(rangeX / cell));
    const height = Math.max(2, Math.floor(rangeY / cell));
    const originX = this.minX + (rangeX - (width - 1) * cell) / 2;
    const originY = this.minY + (rangeY - (height - 1) * cell) / 2;
    const altitude = new Float32Array(width * height);
    // Moyenne de plusieurs échantillons par cellule : la valeur de la cellule, pas un seul point de sol.
    const q = cell / 4;
    for (let row = 0; row < height; row++) {
      const y = originY + row * cell;
      for (let col = 0; col < width; col++) {
        const x = originX + col * cell;
        let sum = 0;
        let n = 0;
        for (const [dx, dy] of samples) {
          const z = this.altitudeAt(x + dx * q, y + dy * q);
          if (z != null) {
            sum += z;
            n++;
          }
        }
        altitude[row * width + col] = n > 0 ? sum / n : Number.NaN;
      }
    }
    const slopeDeg = new Float32Array(width * height).fill(Number.NaN);
    for (let row = 1; row < height - 1; row++) {
      for (let col = 1; col < width - 1; col++) {
        const i = row * width + col;
        const a = altitude[i + width - 1]!, b = altitude[i + width]!, c = altitude[i + width + 1]!;
        const d = altitude[i - 1]!, f = altitude[i + 1]!;
        const g = altitude[i - width - 1]!, h = altitude[i - width]!, k = altitude[i - width + 1]!;
        const gx = ((c + 2 * f + k) - (a + 2 * d + g)) / (8 * cell);
        const gy = ((a + 2 * b + c) - (g + 2 * h + k)) / (8 * cell);
        const s = (Math.atan(Math.hypot(gx, gy)) * 180) / Math.PI;
        if (Number.isFinite(s)) slopeDeg[i] = s;
      }
    }
    return { width, height, cell, originX, originY, altitude, slopeDeg };
  }
}

/** Décalages des échantillons en quarts de cellule : 5 pour la grille d'analyse, 4 × 4 pour les cellules plus grossières. */
const CELL_SAMPLES: ReadonlyArray<[number, number]> = [[0, 0], [-1, -1], [1, -1], [-1, 1], [1, 1]];
const COARSE_CELL_SAMPLES: ReadonlyArray<[number, number]> = [-1.5, -0.5, 0.5, 1.5].flatMap((dy) => (
  [-1.5, -0.5, 0.5, 1.5].map((dx): [number, number] => [dx, dy])
));

/** Indice de la cellule d'analyse contenant un point CRS, -1 en dehors. */
export function analysisCellAt(grid: AnalysisGrid, projX: number, projY: number): number {
  const col = Math.round((projX - grid.originX) / grid.cell);
  const row = Math.round((projY - grid.originY) / grid.cell);
  if (col < 0 || row < 0 || col >= grid.width || row >= grid.height) return -1;
  return row * grid.width + col;
}
