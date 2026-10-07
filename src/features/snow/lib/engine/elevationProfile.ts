// ============================================================================
// Snow engine v2 — elevation downscaling of the coarse field
// ----------------------------------------------------------------------------
// AROME gives the snow of a flat 1.3 km cell at the height of its smoothed
// orography. Inside a LiDAR tile the real ground spans hundreds of metres
// around that height, and the elevation is the first-order control of snow
// depth at that scale (Grünewald et al. 2013, 2014: +6 to +25 cm per 100 m).
//
// 1. The local snow–elevation profile P(z) is learnt from the coarse cells
//    themselves (robust local linear regression in altitude, cells weighted by
//    their distance to the scene), made non-decreasing, and extrapolated above
//    and below the cells with the edge gradient, capped.
// 2. What a cell holds beyond its profile (precipitation and snow-line
//    anomalies) is carried by a smooth residual field, as a ratio high on the
//    profile and as an altitude shift near the snow line, where a ratio would
//    blow up.
// 3. The flat-terrain depth of a pixel is the profile read at the pixel's own
//    altitude, modulated by the residual.
// ============================================================================

import type { SnowEngineConfig } from './config';
import type { SceneFrame } from './grid';
import type { CoarseSnowGrid } from './types';

const M_PER_DEG_LAT = 110_540;
const LUT_STEP_M = 10;

export interface ElevationProfile {
  zMin: number;
  step: number;
  /** HS (cm) at zMin + k·step. */
  values: Float32Array;
  cellsUsed: number;
  orography: 'model' | 'scene-dtm';
}

export function profileAt(p: ElevationProfile, z: number): number {
  const f = (z - p.zMin) / p.step;
  if (f <= 0) return p.values[0];
  const last = p.values.length - 1;
  if (f >= last) return p.values[last];
  const k = Math.floor(f);
  return p.values[k] + (p.values[k + 1] - p.values[k]) * (f - k);
}

/** Lowest altitude where the profile reaches `hs` (cm); the profile is non-decreasing. */
function profileInverse(p: ElevationProfile, hs: number): number {
  const v = p.values;
  if (hs <= v[0]) return p.zMin;
  for (let k = 1; k < v.length; k++) {
    if (v[k] >= hs) {
      const t = v[k] > v[k - 1] ? (hs - v[k - 1]) / (v[k] - v[k - 1]) : 0;
      return p.zMin + (k - 1 + t) * p.step;
    }
  }
  return p.zMin + (v.length - 1) * p.step;
}

export function profileGradientCmPer100m(p: ElevationProfile, z: number): number {
  return (profileAt(p, z + 50) - profileAt(p, z - 50));
}

export function profileSnowline(p: ElevationProfile): number | null {
  for (let k = 0; k < p.values.length; k++) if (p.values[k] > 0.5) return p.zMin + k * p.step;
  return null;
}

interface ProfileCell {
  index: number;
  hs: number;
  z: number;
  w: number;
}

/** Pool-adjacent-violators: weighted least-squares non-decreasing fit. */
function isotonic(values: Float64Array, weights: Float64Array): Float64Array {
  const n = values.length;
  const level = new Float64Array(n);
  const weight = new Float64Array(n);
  const size = new Int32Array(n);
  let top = 0;
  for (let i = 0; i < n; i++) {
    level[top] = values[i];
    weight[top] = Math.max(1e-9, weights[i]);
    size[top] = 1;
    top++;
    while (top > 1 && level[top - 2] > level[top - 1]) {
      const wsum = weight[top - 2] + weight[top - 1];
      level[top - 2] = (level[top - 2] * weight[top - 2] + level[top - 1] * weight[top - 1]) / wsum;
      weight[top - 2] = wsum;
      size[top - 2] += size[top - 1];
      top--;
    }
  }
  const out = new Float64Array(n);
  let k = 0;
  for (let b = 0; b < top; b++) for (let j = 0; j < size[b]; j++) out[k++] = level[b];
  return out;
}

function weightedQuantile(cells: ProfileCell[], q: number): number {
  const sorted = [...cells].sort((a, b) => a.z - b.z);
  const total = sorted.reduce((s, c) => s + c.w, 0);
  let acc = 0;
  for (const c of sorted) {
    acc += c.w;
    if (acc >= q * total) return c.z;
  }
  return sorted[sorted.length - 1].z;
}

/** Local linear fit of HS against altitude around z0 (tricube kernel, robustness weights). */
function localLinear(cells: ProfileCell[], robust: Float64Array, z0: number, minHalfWidth: number, totalW: number): { value: number; mass: number } {
  // Adaptive half-width: wide enough to hold 30 % of the weight.
  const byDist = cells.map((c, i) => ({ d: Math.abs(c.z - z0), w: c.w * robust[i] })).sort((a, b) => a.d - b.d);
  let acc = 0;
  let halfWidth = minHalfWidth;
  for (const e of byDist) {
    acc += e.w;
    if (acc >= 0.3 * totalW) { halfWidth = Math.max(minHalfWidth, e.d * 1.05); break; }
  }
  let sw = 0, sz = 0, sh = 0, szz = 0, szh = 0;
  for (let i = 0; i < cells.length; i++) {
    const c = cells[i];
    const u = Math.abs(c.z - z0) / halfWidth;
    if (u >= 1) continue;
    const k = (1 - u * u * u) ** 3 * c.w * robust[i];
    const dz = c.z - z0;
    sw += k; sz += k * dz; sh += k * c.hs; szz += k * dz * dz; szh += k * dz * c.hs;
  }
  if (sw <= 0) return { value: 0, mass: 0 };
  const det = sw * szz - sz * sz;
  const value = det > 1e-9 * sw * sw ? (sh * szz - sz * szh) / det : sh / sw;
  return { value: Math.max(0, value), mass: sw };
}

/**
 * Fit P(z) over [zLo, zHi] (scene altitudes with margin). Cells need an
 * orography; `fallbackHs` is used when too few cells qualify.
 */
export function fitElevationProfile(
  coarse: CoarseSnowGrid,
  orography: Float32Array,
  orographySource: ElevationProfile['orography'],
  frame: SceneFrame,
  zLo: number,
  zHi: number,
  config: SnowEngineConfig,
): ElevationProfile {
  const cells: ProfileCell[] = [];
  const r2 = (config.profileRadiusKm * 1000) ** 2;
  const mPerDegLon = 111_320 * Math.cos((frame.center.lat * Math.PI) / 180);
  for (let j = 0; j < coarse.height; j++) {
    for (let i = 0; i < coarse.width; i++) {
      const idx = j * coarse.width + i;
      const z = orography[idx];
      const hs = coarse.hsCm[idx];
      if (!Number.isFinite(z) || !Number.isFinite(hs) || hs < 0) continue;
      const de = (coarse.lonMin + i * coarse.dLon - frame.center.lon) * mPerDegLon;
      const dn = (coarse.latMin + j * coarse.dLat - frame.center.lat) * M_PER_DEG_LAT;
      const w = Math.exp(-(de * de + dn * dn) / r2);
      if (w < 0.01) continue;
      cells.push({ index: idx, hs: Math.min(hs, config.profileFitCapCm), z, w });
    }
  }

  const zMin = Math.floor((zLo - 50) / LUT_STEP_M) * LUT_STEP_M;
  const zMax = Math.ceil((zHi + 50) / LUT_STEP_M) * LUT_STEP_M;
  const nLut = Math.max(2, Math.round((zMax - zMin) / LUT_STEP_M) + 1);
  const values = new Float32Array(nLut);

  if (cells.length < 6) {
    // Too few cells: their weighted mean with a default gradient of 5 % of the
    // mean depth per 100 m (Grünewald 2013 pooled model: 7.9 cm/100 m at ~1.5 m).
    const tw = cells.reduce((s, c) => s + c.w, 0);
    const meanHs = tw > 0 ? cells.reduce((s, c) => s + c.w * c.hs, 0) / tw : 0;
    const meanZ = tw > 0 ? cells.reduce((s, c) => s + c.w * c.z, 0) / tw : (zLo + zHi) / 2;
    const g = (0.05 * meanHs) / 100;
    for (let k = 0; k < nLut; k++) values[k] = Math.max(0, meanHs + g * (zMin + k * LUT_STEP_M - meanZ));
    return { zMin, step: LUT_STEP_M, values, cellsUsed: cells.length, orography: orographySource };
  }

  const totalW = cells.reduce((s, c) => s + c.w, 0);
  const supLo = weightedQuantile(cells, 0.02);
  const supHi = weightedQuantile(cells, 0.98);

  // Support grid every 25 m, robust LOESS (two bisquare reweightings).
  const nodes: number[] = [];
  for (let z = supLo; z <= supHi + 1e-6; z += 25) nodes.push(z);
  if (nodes.length < 2) nodes.push(supLo + 25);
  const robust = new Float64Array(cells.length).fill(1);
  let fit: Float64Array = new Float64Array(nodes.length);
  let mass: Float64Array = new Float64Array(nodes.length);
  const evalAt = (z: number) => {
    const f = (z - nodes[0]) / 25;
    const k = Math.max(0, Math.min(nodes.length - 2, Math.floor(f)));
    const t = Math.max(0, Math.min(1, f - k));
    return fit[k] + (fit[k + 1] - fit[k]) * t;
  };
  for (let pass = 0; pass < 3; pass++) {
    fit = new Float64Array(nodes.length);
    mass = new Float64Array(nodes.length);
    for (let k = 0; k < nodes.length; k++) {
      const r = localLinear(cells, robust, nodes[k], config.profileBandwidthM, totalW);
      fit[k] = r.value;
      mass[k] = r.mass;
    }
    if (pass === 2) break;
    const res = cells.map((c) => Math.abs(c.hs - evalAt(c.z)));
    const sorted = [...res].sort((a, b) => a - b);
    const mad = Math.max(2, sorted[Math.floor(sorted.length / 2)]);
    for (let i = 0; i < cells.length; i++) {
      const u = res[i] / (6 * mad);
      robust[i] = u < 1 ? (1 - u * u) ** 2 : 0;
    }
  }
  fit = isotonic(fit, mass);

  // Edge gradients over the outer 300 m of the support, capped and ≥ 0.
  const capG = config.maxGradientCmPer100m / 100;
  const span = Math.min(300, (supHi - supLo) / 2);
  const gTop = Math.max(0, Math.min(capG, span > 0 ? (evalAt(supHi) - evalAt(supHi - span)) / span : 0));
  const gBot = Math.max(0, Math.min(capG, span > 0 ? (evalAt(supLo + span) - evalAt(supLo)) / span : 0));
  for (let k = 0; k < nLut; k++) {
    const z = zMin + k * LUT_STEP_M;
    let v: number;
    if (z > supHi) v = evalAt(supHi) + gTop * (z - supHi);
    else if (z < supLo) v = evalAt(supLo) - gBot * (supLo - z);
    else v = evalAt(z);
    values[k] = Math.max(0, v);
  }
  return { zMin, step: LUT_STEP_M, values, cellsUsed: cells.length, orography: orographySource };
}

/**
 * Residual of every coarse cell against the profile: log-ratio, altitude shift
 * and the blend weight between the two (ratio high on the profile, shift near
 * the snow line).
 */
export interface ResidualField {
  lnRatio: Float32Array;
  shiftM: Float32Array;
  ratioWeight: Float32Array;
}

function smoothstep(e0: number, e1: number, x: number): number {
  const t = Math.max(0, Math.min(1, (x - e0) / (e1 - e0)));
  return t * t * (3 - 2 * t);
}

export function computeResiduals(
  coarse: CoarseSnowGrid,
  orography: Float32Array,
  profile: ElevationProfile,
  config: SnowEngineConfig,
): ResidualField {
  const n = coarse.width * coarse.height;
  const lnRatio = new Float32Array(n);
  const shiftM = new Float32Array(n);
  const ratioWeight = new Float32Array(n).fill(1);
  const eps = config.residualEpsilonCm;
  const lnClamp = Math.log(config.residualRatioClamp);
  const snowline = profileSnowline(profile);
  for (let i = 0; i < n; i++) {
    const z = orography[i];
    const hs = coarse.hsCm[i];
    if (!Number.isFinite(z) || !Number.isFinite(hs)) { lnRatio[i] = Number.NaN; continue; }
    const hsc = Math.min(Math.max(0, hs), config.profileFitCapCm * 2);
    const p = profileAt(profile, z);
    lnRatio[i] = Math.max(-lnClamp, Math.min(lnClamp, Math.log((hsc + eps) / (p + eps))));
    let shift = 0;
    if (hsc > 0.5) shift = profileInverse(profile, hsc) - z;
    else if (p > 0.5 && snowline != null) shift = snowline - z - LUT_STEP_M;
    shiftM[i] = Math.max(-600, Math.min(600, shift));
    ratioWeight[i] = smoothstep(20, 80, Math.max(p, hsc));
  }
  return { lnRatio, shiftM, ratioWeight };
}

/** Gaussian-kernel interpolation of the cell residuals at a WGS84 point. */
export class ResidualInterpolator {
  private readonly coarse: CoarseSnowGrid;
  private readonly residuals: ResidualField;
  private readonly sigmaM: number;
  private readonly mPerDegLon: number;

  constructor(coarse: CoarseSnowGrid, residuals: ResidualField, centerLat: number) {
    this.coarse = coarse;
    this.residuals = residuals;
    this.sigmaM = 0.9 * coarse.resolutionM;
    this.mPerDegLon = 111_320 * Math.cos((centerLat * Math.PI) / 180);
  }

  at(lon: number, lat: number): { lnRatio: number; shiftM: number; ratioWeight: number; inside: boolean } {
    const c = this.coarse;
    const fi = (lon - c.lonMin) / c.dLon;
    const fj = (lat - c.latMin) / c.dLat;
    const inside = fi >= -0.5 && fj >= -0.5 && fi <= c.width - 0.5 && fj <= c.height - 0.5;
    const reach = 3;
    const i0 = Math.max(0, Math.floor(fi) - reach);
    const i1 = Math.min(c.width - 1, Math.ceil(fi) + reach);
    const j0 = Math.max(0, Math.floor(fj) - reach);
    const j1 = Math.min(c.height - 1, Math.ceil(fj) + reach);
    const inv = 1 / (2 * this.sigmaM * this.sigmaM);
    let sw = 0, sl = 0, ss = 0, sr = 0;
    for (let j = j0; j <= j1; j++) {
      const dn = (fj - j) * c.dLat * M_PER_DEG_LAT;
      for (let i = i0; i <= i1; i++) {
        const idx = j * c.width + i;
        const l = this.residuals.lnRatio[idx];
        if (!Number.isFinite(l)) continue;
        const de = (fi - i) * c.dLon * this.mPerDegLon;
        const w = Math.exp(-(de * de + dn * dn) * inv);
        sw += w; sl += w * l; ss += w * this.residuals.shiftM[idx]; sr += w * this.residuals.ratioWeight[idx];
      }
    }
    if (sw < 1e-6) return { lnRatio: 0, shiftM: 0, ratioWeight: 1, inside: false };
    return { lnRatio: sl / sw, shiftM: ss / sw, ratioWeight: sr / sw, inside };
  }
}

/** Flat open-terrain snow depth at altitude z given the local residual. */
export function flatDepth(profile: ElevationProfile, z: number, r: { lnRatio: number; shiftM: number; ratioWeight: number }, epsCm: number): number {
  const byRatio = (profileAt(profile, z) + epsCm) * Math.exp(r.lnRatio) - epsCm;
  const byShift = profileAt(profile, z + r.shiftM);
  return Math.max(0, r.ratioWeight * byRatio + (1 - r.ratioWeight) * byShift);
}
