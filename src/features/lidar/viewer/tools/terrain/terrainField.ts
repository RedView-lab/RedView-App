// ============================================
// LiDAR viewer tools — ground model (DTM) queries
// ============================================
//
// Wraps the scene height grid (ground returns, ≈ 1 m per cell on a 1 km
// tile, row 0 = south edge, heights relative to the scene centre) with the
// queries every terrain tool needs: altitude, slope/aspect, draping and
// coarser grids for the area-wide models (viewshed 5 m, avalanche 10 m).

import { toWgs84, trueNorthGridBearingDeg } from '../../../lib/coordConvert';
import type { DetectedCrs } from '../../../types';
import type { ViewerRouteSceneParams } from '../../route/types';
import type { Vec3 } from '../types';

/**
 * Baseline (m) of the slope read at a point. Avalanche slope maps use 5–10 m
 * models: a 1 m baseline reads every boulder and step, not the slope a
 * skier or a slab stands on.
 */
export const SLOPE_BASELINE_M = 6;
/** Cell (m) of the analysis grid (viewshed). */
const ANALYSIS_TARGET_CELL_M = 5;
/** Upper bound of analysis cells (memory and overlay mesh size). */
const ANALYSIS_MAX_CELLS = 160_000;
/**
 * Cell (m) of the avalanche terrain grid: AutoATES runs on 10 m models
 * (Toft et al., 2024; little gain under 5 m, Sykes et al., 2023), the scale
 * of release areas and avalanche paths rather than of boulders.
 */
const AVALANCHE_TARGET_CELL_M = 10;
const AVALANCHE_MAX_CELLS = 160_000;

export interface SlopeSample {
  /** Slope angle, degrees. */
  slopeDeg: number;
  /** True azimuth of the downslope direction (aspect), degrees clockwise from north. */
  aspectDeg: number;
  /** Altitude gradient along the CRS axes (m/m). */
  gradX: number;
  gradY: number;
}

/** Local shape of the ground: altitude, gradient and second derivatives (CRS axes). */
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
  /** Cumulative horizontal distance, m. */
  distanceM: number;
  /** Cumulative distance along the ground surface, m. */
  surfaceDistanceM: number;
}

/** Coarse resampling of the ground model for area-wide analyses. */
export interface AnalysisGrid {
  width: number;
  height: number;
  /** Cell edge, m. */
  cell: number;
  /** CRS position of the centre of cell (0, 0) (south-west corner cell). */
  originX: number;
  originY: number;
  /** Absolute altitude per cell, NaN where the scene has no ground. */
  altitude: Float32Array;
  /** Slope angle per cell (degrees), NaN without data. */
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
  /** Native grid spacing, m. */
  readonly cellX: number;
  readonly cellY: number;
  private readonly grid: Float32Array;
  private readonly gridWidth: number;
  private readonly gridHeight: number;
  private readonly offsetZ: number;
  /** Grid bearing of true north at the scene centre (meridian convergence). */
  private readonly northConvergenceDeg: number;
  /** Altitude range of the ground model, m. */
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

  /** Smallest native spacing, m. */
  get cell(): number {
    return Math.min(this.cellX, this.cellY);
  }

  contains(projX: number, projY: number): boolean {
    return projX >= this.minX && projX <= this.maxX && projY >= this.minY && projY <= this.maxY;
  }

  /** Ground altitude (m, bilinear), `null` outside the scene or on a hole. */
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
   * Slope and aspect over `baselineM` (Horn's 3×3 operator on samples
   * `baselineM / 2` apart). `null` when a sample falls outside the scene.
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
   * Gradient and curvature of the ground over `baselineM` (3×3 samples
   * `baselineM / 2` apart: Horn's gradient, central second differences),
   * for the motion of a body on the surface. `null` off the scene.
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
    // Downslope direction (−gradient), as a grid azimuth, then true.
    const gridAzimuth = (Math.atan2(-gradX, -gradY) * 180) / Math.PI;
    return { slopeDeg, aspectDeg: this.gridToTrueAzimuth(gridAzimuth), gradX, gradY };
  }

  /** Grid azimuth (clockwise from the CRS +Y axis) → true azimuth. */
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

  /** Ground altitude under a render-frame position, as a render-frame height. */
  localGroundY(x: number, z: number): number | null {
    const altitude = this.altitudeAt(x + this.centerX, this.centerY - z);
    return altitude == null ? null : altitude - this.centerZ;
  }

  /**
   * First crossing of a render-frame ray with the ground model, `null` when
   * it misses (sky, beyond the scene, or over a hole). Marches at about the
   * grid spacing (coarser far away, like the pixel footprint), then bisects.
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
    if (prev != null && prev < 0) return null; // starts under the ground
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
   * The ground model does not hide `point` from `eye` (render frame). Used to
   * fade the parts of a measurement behind a ridge; vegetation is ignored.
   */
  isVisibleFrom(point: Vec3, eye: Vec3): boolean {
    const vx = eye[0] - point[0];
    const vy = eye[1] - point[1];
    const vz = eye[2] - point[2];
    const length = Math.hypot(vx, vy, vz);
    if (length < 3) return true;
    const topY = this.maxAltitudeM - this.centerZ;
    const samples = Math.min(64, Math.max(8, Math.ceil(length / (this.cell * 4))));
    // Skip the first metres: the point lies on the ground it is drawn on.
    const start = Math.min(0.5, 2.5 / length);
    for (let k = 0; k < samples; k++) {
      const s = start + ((1 - start) * (k + 1)) / (samples + 1);
      const y = point[1] + vy * s;
      if (y > topY) return true; // above every summit from here on
      const ground = this.localGroundY(point[0] + vx * s, point[2] + vz * s);
      if (ground != null && ground > y + 0.3) return false;
    }
    return true;
  }

  /**
   * Samples the ground along a CRS polyline every ≤ `stepM` (every vertex
   * kept). Stretches without ground are skipped; distances keep counting.
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

  /** Analysis grid, built on first use (≈ 5 m cells, at most 160 k cells). */
  getAnalysisGrid(): AnalysisGrid {
    if (!this.analysis) this.analysis = this.buildGrid(ANALYSIS_TARGET_CELL_M, ANALYSIS_MAX_CELLS, CELL_SAMPLES);
    return this.analysis;
  }

  /** Avalanche terrain grid, built on first use (≈ 10 m cells, at most 160 k cells). */
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
    // Mean of several samples per cell: the cell value, not one ground point.
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

/** Sample offsets in quarter cells: 5 for the analysis grid, 4 × 4 for coarser cells. */
const CELL_SAMPLES: ReadonlyArray<[number, number]> = [[0, 0], [-1, -1], [1, -1], [-1, 1], [1, 1]];
const COARSE_CELL_SAMPLES: ReadonlyArray<[number, number]> = [-1.5, -0.5, 0.5, 1.5].flatMap((dy) => (
  [-1.5, -0.5, 0.5, 1.5].map((dx): [number, number] => [dx, dy])
));

/** Index of the analysis cell holding a CRS point, -1 outside. */
export function analysisCellAt(grid: AnalysisGrid, projX: number, projY: number): number {
  const col = Math.round((projX - grid.originX) / grid.cell);
  const row = Math.round((projY - grid.originY) / grid.cell);
  if (col < 0 || row < 0 || col >= grid.width || row >= grid.height) return -1;
  return row * grid.width + col;
}
