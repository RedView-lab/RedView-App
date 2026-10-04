// ============================================================================
// Snow engine v2 — potential clear-sky direct radiation (Hock 1999)
// ----------------------------------------------------------------------------
// I = S0·E0·τ^(m·p/p0)·cos θi, θi the incidence angle on the slope, zero when
// the sun is under the local horizon. Horizons are traced once per azimuth
// sector on the scene DTM, then on the far-field DEM (the mountains around a
// 1 km LiDAR tile shade it far more than its own relief).
// ============================================================================

import { sampleBilinear, resampleNodeGrid, type WorkGrid } from './grid';
import type { AltitudeSampler } from './terrain';

const RAD = Math.PI / 180;
const DEG = 180 / Math.PI;
const SOLAR_CONSTANT = 1367;
const EARTH_RADIUS_M = 6_371_000;
/** Light bends over the horizon: effective Earth curvature reduced by ~13 %. */
const REFRACTION_K = 0.13;

export interface SunPosition {
  /** Deg true, clockwise from north. */
  azimuthDeg: number;
  elevationDeg: number;
  /** Earth–Sun distance factor (Rm/R)². */
  eccentricity: number;
}

/** NOAA low-precision solar position (error < 0.1° over 1950–2050). */
export function sunPosition(timeMs: number, latDeg: number, lonDeg: number): SunPosition {
  const jd = timeMs / 86_400_000 + 2_440_587.5;
  const n = jd - 2_451_545.0;
  const L = (280.46 + 0.9856474 * n) % 360;
  const g = ((357.528 + 0.9856003 * n) % 360) * RAD;
  const lambda = (L + 1.915 * Math.sin(g) + 0.02 * Math.sin(2 * g)) * RAD;
  const epsilon = (23.439 - 0.0000004 * n) * RAD;
  const ra = Math.atan2(Math.cos(epsilon) * Math.sin(lambda), Math.cos(lambda));
  const dec = Math.asin(Math.sin(epsilon) * Math.sin(lambda));
  const gmst = (18.697374558 + 24.06570982441908 * n) % 24;
  const lst = (gmst * 15 + lonDeg) * RAD;
  const ha = lst - ra;
  const lat = latDeg * RAD;
  const sinEl = Math.sin(lat) * Math.sin(dec) + Math.cos(lat) * Math.cos(dec) * Math.cos(ha);
  const el = Math.asin(Math.max(-1, Math.min(1, sinEl)));
  const az = Math.atan2(-Math.sin(ha), Math.tan(dec) * Math.cos(lat) - Math.sin(lat) * Math.cos(ha));
  const r = 1.00014 - 0.01671 * Math.cos(g) - 0.00014 * Math.cos(2 * g);
  return { azimuthDeg: ((az * DEG) % 360 + 360) % 360, elevationDeg: el * DEG, eccentricity: 1 / (r * r) };
}

/** Beam irradiance normal to the rays at altitude z, W m⁻² (0 below the horizon). */
export function beamNormal(sun: SunPosition, altitudeM: number, transmissivity: number): number {
  if (sun.elevationDeg <= 0.5) return 0;
  const sinEl = Math.sin(sun.elevationDeg * RAD);
  // Kasten–Young air mass, pressure-corrected (Hock 1999: p/p0 = exp(−z/8434.5)).
  const airMass = 1 / (sinEl + 0.50572 * Math.pow(sun.elevationDeg + 6.07995, -1.6364));
  const pressure = Math.exp(-Math.max(0, altitudeM) / 8434.5);
  return SOLAR_CONSTANT * sun.eccentricity * Math.pow(transmissivity, airMass * pressure);
}

/** cos of the incidence angle on a slope (deg) of a given aspect (deg true). */
export function incidenceCos(sun: SunPosition, slopeDeg: number, aspectTrueDeg: number): number {
  const el = sun.elevationDeg * RAD;
  const s = slopeDeg * RAD;
  return Math.max(0, Math.cos(s) * Math.sin(el) + Math.sin(s) * Math.cos(el) * Math.cos((sun.azimuthDeg - aspectTrueDeg) * RAD));
}

/** Sun positions every `stepMin` minutes of a UTC day (sun above the horizon only). */
export function daySunPath(dayStartMs: number, latDeg: number, lonDeg: number, stepMin: number): SunPosition[] {
  const out: SunPosition[] = [];
  for (let m = stepMin / 2; m < 1440; m += stepMin) {
    const p = sunPosition(dayStartMs + m * 60_000, latDeg, lonDeg);
    if (p.elevationDeg > 0.5) out.push(p);
  }
  return out;
}

/** Daily mean direct radiation on an unshaded surface, W m⁻². */
export function dailyMeanDirect(
  path: SunPosition[], stepMin: number, altitudeM: number, transmissivity: number, slopeDeg: number, aspectTrueDeg: number,
): number {
  let sum = 0;
  for (const p of path) sum += beamNormal(p, altitudeM, transmissivity) * incidenceCos(p, slopeDeg, aspectTrueDeg);
  return (sum * stepMin) / 1440;
}

/** Horizon elevation (tan) per azimuth sector on a (possibly reduced) copy of the work grid. */
export interface HorizonField {
  width: number;
  height: number;
  /** Sector centres, deg true. */
  azimuthsDeg: number[];
  sectorDeg: number;
  /** One tan(horizon elevation) grid per sector. */
  tan: Float32Array[];
}

export function computeHorizons(
  grid: WorkGrid,
  sampler: AltitudeSampler,
  gridNorthBearingDeg: number,
  azimuthsDeg: number[],
  sectorDeg: number,
  maxDistanceM: number,
  reduce: number,
): HorizonField {
  const w = Math.max(2, Math.round((grid.width - 1) / reduce) + 1);
  const h = Math.max(2, Math.round((grid.height - 1) / reduce) + 1);
  const z = resampleNodeGrid(grid.z, grid.width, grid.height, w, h);
  const cellX = grid.sizeX / (w - 1);
  const cellY = grid.sizeY / (h - 1);
  const step0 = Math.min(cellX, cellY);
  const distances: number[] = [];
  let d = step0;
  while (d <= maxDistanceM) {
    distances.push(d);
    d = d < 8 * step0 ? d + step0 : d * 1.12;
  }
  const curvature = (1 - REFRACTION_K) / (2 * EARTH_RADIUS_M);
  const tan: Float32Array[] = [];
  for (const azTrue of azimuthsDeg) {
    const azGrid = (azTrue - gridNorthBearingDeg) * RAD;
    const ux = Math.sin(azGrid);
    const uy = Math.cos(azGrid);
    const out = new Float32Array(w * h);
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        const xm = x * cellX;
        const ym = y * cellY;
        const zc = z[y * w + x];
        let best = -1;
        for (let k = 0; k < distances.length; k++) {
          const dist = distances[k];
          const zs = sampler.at(xm + ux * dist, ym + uy * dist);
          if (!Number.isFinite(zs)) break;
          const t = (zs - zc - dist * dist * curvature) / dist;
          if (t > best) best = t;
        }
        out[y * w + x] = best;
      }
    }
    tan.push(out);
  }
  return { width: w, height: h, azimuthsDeg, sectorDeg, tan };
}

/**
 * Daily mean clear-sky direct radiation of every node (W m⁻²), on the
 * reduced horizon grid, shaded by the horizons.
 */
/** Per-node geometry reused by every sun position of every day. */
export interface SurfaceGeometry {
  n: number;
  cosS: Float32Array;
  sinS: Float32Array;
  cosA: Float32Array;
  sinA: Float32Array;
  /** Altitude bin (50 m) of the beam look-up table. */
  altBin: Uint16Array;
  altMin: number;
  altBins: number;
}

const ALT_BIN_M = 50;

export function surfaceGeometry(slopeDeg: Float32Array, aspectTrueDeg: Float32Array, altitudeM: Float32Array): SurfaceGeometry {
  const n = slopeDeg.length;
  const cosS = new Float32Array(n);
  const sinS = new Float32Array(n);
  const cosA = new Float32Array(n);
  const sinA = new Float32Array(n);
  let altMin = Infinity;
  let altMax = -Infinity;
  for (let i = 0; i < n; i++) {
    const s = slopeDeg[i] * RAD;
    const a = aspectTrueDeg[i] * RAD;
    cosS[i] = Math.cos(s);
    sinS[i] = Math.sin(s);
    cosA[i] = Math.cos(a);
    sinA[i] = Math.sin(a);
    if (altitudeM[i] < altMin) altMin = altitudeM[i];
    if (altitudeM[i] > altMax) altMax = altitudeM[i];
  }
  const altBins = Math.max(1, Math.ceil((altMax - altMin) / ALT_BIN_M) + 1);
  const altBin = new Uint16Array(n);
  for (let i = 0; i < n; i++) altBin[i] = Math.min(altBins - 1, Math.floor((altitudeM[i] - altMin) / ALT_BIN_M));
  return { n, cosS, sinS, cosA, sinA, altBin, altMin, altBins };
}

export function dailyRadiationField(
  horizons: HorizonField,
  geom: SurfaceGeometry,
  path: SunPosition[],
  stepMin: number,
  transmissivity: number,
): Float32Array {
  const n = geom.n;
  const out = new Float32Array(n);
  const nSec = horizons.azimuthsDeg.length;
  const first = horizons.azimuthsDeg[0] - horizons.sectorDeg / 2;
  const beamLut = new Float32Array(geom.altBins);
  for (const p of path) {
    let sec = Math.floor((((p.azimuthDeg - first) % 360) + 360) % 360 / horizons.sectorDeg);
    if (sec >= nSec) sec = -1;
    const el = p.elevationDeg * RAD;
    const tanEl = Math.tan(el);
    const sinEl = Math.sin(el);
    const cosEl = Math.cos(el);
    const cosAz = Math.cos(p.azimuthDeg * RAD);
    const sinAz = Math.sin(p.azimuthDeg * RAD);
    for (let b = 0; b < geom.altBins; b++) beamLut[b] = beamNormal(p, geom.altMin + (b + 0.5) * ALT_BIN_M, transmissivity);
    const hor = sec >= 0 ? horizons.tan[sec] : null;
    for (let i = 0; i < n; i++) {
      if (hor && hor[i] >= tanEl) continue;
      const c = geom.cosS[i] * sinEl + geom.sinS[i] * cosEl * (cosAz * geom.cosA[i] + sinAz * geom.sinA[i]);
      if (c <= 0) continue;
      out[i] += beamLut[geom.altBin[i]] * c;
    }
  }
  const k = stepMin / 1440;
  for (let i = 0; i < n; i++) out[i] *= k;
  return out;
}

/** Upsample a reduced-grid field to the work grid (same extent, node grids). */
export function upsampleToWork(field: Float32Array, fw: number, fh: number, w: number, h: number): Float32Array {
  if (fw === w && fh === h) return field;
  const out = new Float32Array(w * h);
  const sx = (fw - 1) / Math.max(1, w - 1);
  const sy = (fh - 1) / Math.max(1, h - 1);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) out[y * w + x] = sampleBilinear(field, fw, fh, x * sx, y * sy);
  return out;
}
