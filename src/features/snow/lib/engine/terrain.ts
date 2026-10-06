// ============================================================================
// Snow engine v2 — terrain analysis on the work grid
// ----------------------------------------------------------------------------
// Horn gradients, MicroMet curvature (Liston & Elder 2006), Winstral Sx
// (Winstral et al. 2002) reaching into the far-field DEM, and the terrain
// scaling parameters of Helbig et al. (2015).
// ============================================================================

import { sampleBilinear, type WorkGrid } from './grid';
import type { FarDem } from './types';

const DEG = 180 / Math.PI;
const RAD = Math.PI / 180;

export interface TerrainFields {
  /** dz/dx (east) and dz/dy (grid north), m/m. */
  gx: Float32Array;
  gy: Float32Array;
  slopeDeg: Float32Array;
  /** Downslope compass bearing relative to grid north, deg (0 on flats). */
  aspectGridDeg: Float32Array;
}

export function terrainGradients(grid: WorkGrid): TerrainFields {
  const { width: w, height: h, z, dx, dy } = grid;
  const n = w * h;
  const gx = new Float32Array(n);
  const gy = new Float32Array(n);
  for (let y = 0; y < h; y++) {
    const ym = Math.max(0, y - 1) * w;
    const y0 = y * w;
    const yp = Math.min(h - 1, y + 1) * w;
    const sy = (Math.min(h - 1, y + 1) - Math.max(0, y - 1)) * dy;
    for (let x = 0; x < w; x++) {
      const xm = Math.max(0, x - 1);
      const xp = Math.min(w - 1, x + 1);
      const sx = (xp - xm) * dx;
      gx[y0 + x] = ((z[ym + xp] + 2 * z[y0 + xp] + z[yp + xp]) - (z[ym + xm] + 2 * z[y0 + xm] + z[yp + xm])) / (4 * sx);
      gy[y0 + x] = ((z[yp + xm] + 2 * z[yp + x] + z[yp + xp]) - (z[ym + xm] + 2 * z[ym + x] + z[ym + xp])) / (4 * sy);
    }
  }
  const slopeDeg = new Float32Array(n);
  const aspectGridDeg = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    const g = Math.hypot(gx[i], gy[i]);
    slopeDeg[i] = Math.atan(g) * DEG;
    if (g > 1e-4) {
      // Downslope vector (−gx, −gy) as a compass bearing.
      let a = Math.atan2(-gx[i], -gy[i]) * DEG;
      if (a < 0) a += 360;
      aspectGridDeg[i] = a;
    }
  }
  return { gx, gy, slopeDeg, aspectGridDeg };
}

/**
 * MicroMet curvature at length scale η (Liston & Elder 2006, Eq. 15): mean of
 * the four directional second differences with neighbours η away, positive on
 * convex terrain (ridges), negative in hollows. The DEM is box-smoothed to the
 * scale first so that a 150 m curvature does not alias 2 m roughness.
 */
export function curvatureAtScale(grid: WorkGrid, scaleM: number, smoothed: Float32Array): Float32Array {
  const { width: w, height: h, ps } = grid;
  const k = Math.max(1, Math.round(scaleM / ps));
  const eta = k * ps;
  const z = smoothed;
  const out = new Float32Array(w * h);
  const at = (x: number, y: number) => z[Math.min(h - 1, Math.max(0, y)) * w + Math.min(w - 1, Math.max(0, x))];
  const inv1 = 1 / (2 * eta);
  const inv2 = 1 / (2 * Math.SQRT2 * eta);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const c = z[y * w + x];
      out[y * w + x] = 0.25 * (
        (c - (at(x - k, y) + at(x + k, y)) / 2) * inv1
        + (c - (at(x, y - k) + at(x, y + k)) / 2) * inv1
        + (c - (at(x - k, y - k) + at(x + k, y + k)) / 2) * inv2
        + (c - (at(x - k, y + k) + at(x + k, y - k)) / 2) * inv2
      );
    }
  }
  return out;
}

/** Altitude sampler reaching beyond the scene into the far-field DEM. */
export class AltitudeSampler {
  private readonly grid: WorkGrid;
  private readonly far: FarDem | null;

  constructor(grid: WorkGrid, far: FarDem | null) {
    this.grid = grid;
    this.far = far;
  }

  /** Altitude at scene-local metres (origin = SW node), NaN outside every DEM. */
  at(xm: number, ym: number): number {
    const g = this.grid;
    const fx = xm / g.dx;
    const fy = ym / g.dy;
    if (fx >= 0 && fy >= 0 && fx <= g.width - 1 && fy <= g.height - 1) {
      return g.z[Math.round(fy) * g.width + Math.round(fx)];
    }
    const far = this.far;
    if (!far) return Number.NaN;
    const ux = (xm - far.originX) / far.cell;
    const uy = (ym - far.originY) / far.cell;
    if (ux < 0 || uy < 0 || ux > far.width - 1 || uy > far.height - 1) return Number.NaN;
    return sampleBilinear(far.data, far.width, far.height, ux, uy);
  }

  /**
   * Largest (zs − zc − drop_k) / d_k (`drops` null: (zs − zc) / d_k) of the
   * samples zs = at(xm + ux·d_k, ym + uy·d_k), up to the first one outside
   * every DEM; `best` when none is higher. `at` inlined with the same
   * arithmetic: horizons and Winstral's Sx sample ~10⁸ points per scene.
   */
  maxRaySlope(
    xm: number, ym: number, ux: number, uy: number,
    distances: Float64Array, drops: Float64Array | null, zc: number, best: number,
  ): number {
    const g = this.grid;
    const far = this.far;
    const { dx, dy, width, z } = g;
    const xMax = g.width - 1;
    const yMax = g.height - 1;
    for (let k = 0; k < distances.length; k++) {
      const dist = distances[k];
      const qx = xm + ux * dist;
      const qy = ym + uy * dist;
      const fx = qx / dx;
      const fy = qy / dy;
      let zs: number;
      if (fx >= 0 && fy >= 0 && fx <= xMax && fy <= yMax) {
        zs = z[Math.round(fy) * width + Math.round(fx)];
      } else {
        if (!far) break;
        const fu = (qx - far.originX) / far.cell;
        const fv = (qy - far.originY) / far.cell;
        if (fu < 0 || fv < 0 || fu > far.width - 1 || fv > far.height - 1) break;
        zs = sampleBilinear(far.data, far.width, far.height, fu, fv);
      }
      if (!Number.isFinite(zs)) break;
      const t = drops ? (zs - zc - drops[k]) / dist : (zs - zc) / dist;
      if (t > best) best = t;
    }
    return best;
  }
}

/**
 * Winstral Sx: the maximum upwind slope angle (deg) of the terrain between
 * `dMinM` and `dMaxM` up the wind, positive when the node is sheltered,
 * negative when exposed. `windFromGridDeg` is where the wind comes from,
 * relative to grid north. Distances grow geometrically past 16 pixels.
 */
export function shelterIndex(
  grid: WorkGrid,
  sampler: AltitudeSampler,
  windFromGridDeg: number,
  dMinM: number,
  dMaxM: number,
): Float32Array {
  const { width: w, height: h, dx, dy, ps, z } = grid;
  const ux = Math.sin(windFromGridDeg * RAD);
  const uy = Math.cos(windFromGridDeg * RAD);
  const distances: number[] = [];
  let d = Math.max(ps, dMinM);
  while (d <= dMaxM + 1e-6) {
    distances.push(d);
    d = d < 16 * ps ? d + ps : d * 1.08;
  }
  const out = new Float32Array(w * h);
  const ray = Float64Array.from(distances);
  for (let y = 0; y < h; y++) {
    const ym = y * dy;
    for (let x = 0; x < w; x++) {
      const best = sampler.maxRaySlope(x * dx, ym, ux, uy, ray, null, z[y * w + x], -1e9);
      out[y * w + x] = best > -1e8 ? Math.atan(best) * DEG : 0;
    }
  }
  return out;
}

export interface HelbigTerrain {
  /** Mean squared slope parameter μ (Helbig 2015, Eq. 1). */
  mu: number;
  /** Correlation length ξ of the detrended DEM, m. */
  xi: number;
  /** Domain size L, m. */
  L: number;
}

/** μ = √(⟨(∂x z)² + (∂y z)²⟩ / 2), ξ = √2·σz/μ on the linearly detrended DEM. */
export function helbigTerrain(grid: WorkGrid, t: TerrainFields): HelbigTerrain {
  const { width: w, height: h, z } = grid;
  const n = w * h;
  let s2 = 0;
  for (let i = 0; i < n; i++) s2 += t.gx[i] * t.gx[i] + t.gy[i] * t.gy[i];
  const mu = Math.sqrt(s2 / n / 2);
  // Least-squares plane z ≈ a + b·x + c·y (x, y centred node indices).
  let sx = 0, sy = 0, sz = 0;
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) { sx += x; sy += y; sz += z[y * w + x]; }
  const mx = sx / n, my = sy / n, mz = sz / n;
  let sxx = 0, syy = 0, sxy = 0, sxz = 0, syz = 0;
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const cx = x - mx, cy = y - my, cz = z[y * w + x] - mz;
      sxx += cx * cx; syy += cy * cy; sxy += cx * cy; sxz += cx * cz; syz += cy * cz;
    }
  }
  const det = sxx * syy - sxy * sxy;
  const b = det !== 0 ? (sxz * syy - syz * sxy) / det : 0;
  const c = det !== 0 ? (syz * sxx - sxz * sxy) / det : 0;
  let v = 0;
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const r = z[y * w + x] - mz - b * (x - mx) - c * (y - my);
      v += r * r;
    }
  }
  const sigmaZ = Math.sqrt(v / n);
  const xi = mu > 1e-4 ? (Math.SQRT2 * sigmaZ) / mu : grid.sizeX;
  return { mu, xi, L: Math.sqrt(grid.sizeX * grid.sizeY) };
}

/** Helbig et al. (2015) Eq. 2: σ(HS) in m from the mean depth (m) and the terrain. */
export function helbigSigmaM(meanHsM: number, terrain: HelbigTerrain, a: number, b: number): number {
  if (meanHsM <= 0 || terrain.mu <= 0) return 0;
  return Math.pow(meanHsM, a) * Math.pow(terrain.mu, b) * Math.exp(-((terrain.xi / terrain.L) ** 2));
}

/** Separable Gaussian smoothing with renormalised edges. */
export function gaussianSmooth(data: Float32Array, w: number, h: number, sigma: number): Float32Array {
  if (sigma < 0.3) return new Float32Array(data);
  const radius = Math.ceil(sigma * 2.5);
  const kernel = new Float32Array(2 * radius + 1);
  for (let i = -radius; i <= radius; i++) kernel[i + radius] = Math.exp(-(i * i) / (2 * sigma * sigma));
  const tmp = new Float32Array(w * h);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      let s = 0, wt = 0;
      for (let k = -radius; k <= radius; k++) {
        const xx = x + k;
        if (xx < 0 || xx >= w) continue;
        const kv = kernel[k + radius];
        s += data[y * w + xx] * kv;
        wt += kv;
      }
      tmp[y * w + x] = s / wt;
    }
  }
  const out = new Float32Array(w * h);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      let s = 0, wt = 0;
      for (let k = -radius; k <= radius; k++) {
        const yy = y + k;
        if (yy < 0 || yy >= h) continue;
        const kv = kernel[k + radius];
        s += tmp[yy * w + x] * kv;
        wt += kv;
      }
      out[y * w + x] = s / wt;
    }
  }
  return out;
}

/** Robust scale: the |value| at the given upper quantile (ignores exact zeros). */
export function robustAbsQuantile(data: Float32Array, q: number): number {
  const step = Math.max(1, Math.floor(data.length / 50_000));
  const vals: number[] = [];
  for (let i = 0; i < data.length; i += step) {
    const v = Math.abs(data[i]);
    if (Number.isFinite(v) && v > 0) vals.push(v);
  }
  if (vals.length === 0) return 0;
  vals.sort((a, b) => a - b);
  return vals[Math.min(vals.length - 1, Math.floor(q * (vals.length - 1)))];
}
