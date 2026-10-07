// ============================================================================
// Snow engine v2 — assimilation of measured snow depths
// ----------------------------------------------------------------------------
// Large scale (flat-field stations, avalanche bulletin levels): the downscaled
// coarse field is the background. AROME carries no snow analysis, so its
// errors are systematic, and of two kinds: the amount of precipitation and the
// rain/snow limit (temperature). They are corrected together as
//     HS(z) = k · background(z + Δz)
// (k a precipitation factor, Δz an altitude shift of the whole profile),
// fitted robustly (bisquare) on the measurements with priors k ~ 1 ± 30 %,
// Δz ~ 0 ± 250 m. Then
//   - a first-guess check on what the correction leaves (ECMWF:
//     |d| > 4·√(σb² + σo²) rejected),
//   - an optimal interpolation of the remaining innovations with the ECMWF
//     structure functions: horizontal (1 + r/L)·e^(−r/L), vertical
//     exp(−(Δz/h)²), background error proportional to depth.
// Every station is also predicted from all the others (leave-one-out), the
// honest measure of what the measurements bring.
// Fine scale (`point` measurements inside the scene): simple kriging of the
// final-field residuals with a short exponential covariance, after a shrunk
// global ratio when there are several of them.
// ============================================================================

import type { SnowEngineConfig } from './config';
import type { BraSnowProfile, SnowObservation, StationDiagnostic } from './types';

export interface StationSample {
  obs: SnowObservation;
  /** Local metric position (east, north), m, and altitude, m. */
  e: number;
  n: number;
  z: number;
  distanceKm: number;
}

interface ProfileCorrection {
  /** Precipitation factor. */
  ratio: number;
  /** Altitude shift of the background profile, m (read the background at z + shiftM). */
  shiftM: number;
}

const NO_CORRECTION: ProfileCorrection = { ratio: 1, shiftM: 0 };

export interface LargeScaleAnalysis {
  correction: ProfileCorrection;
  /** Accepted stations with their OI weights. */
  used: StationSample[];
  alpha: Float64Array;
  /** Background error σb at the used stations, cm. */
  sigmaB: Float64Array;
  diagnostics: StationDiagnostic[];
  braUsed: boolean;
}

function sigmaBackground(b: number, config: SnowEngineConfig): number {
  return Math.max(config.backgroundErrorMinCm, config.backgroundErrorRel * Math.max(0, b));
}

function sigmaObs(o: SnowObservation, config: SnowEngineConfig): number {
  const e = o.errorCm ?? config.obsErrorCm;
  return Math.hypot(e, config.obsRepresentativenessRel * Math.max(0, o.hsCm));
}

function horizontalCorrelation(rKm: number, lKm: number): number {
  const x = rKm / lKm;
  return (1 + x) * Math.exp(-x);
}

function verticalCorrelation(dz: number, hM: number): number {
  return Math.exp(-((dz / hM) ** 2));
}

/** Solve a small SPD system (Cholesky); returns null when singular. */
function solveSpd(a: Float64Array, n: number, rhs: Float64Array): Float64Array | null {
  const l = new Float64Array(n * n);
  for (let i = 0; i < n; i++) {
    for (let j = 0; j <= i; j++) {
      let s = a[i * n + j];
      for (let k = 0; k < j; k++) s -= l[i * n + k] * l[j * n + k];
      if (i === j) {
        if (s <= 1e-12) return null;
        l[i * n + i] = Math.sqrt(s);
      } else {
        l[i * n + j] = s / l[j * n + j];
      }
    }
  }
  const y = new Float64Array(n);
  for (let i = 0; i < n; i++) {
    let s = rhs[i];
    for (let k = 0; k < i; k++) s -= l[i * n + k] * y[k];
    y[i] = s / l[i * n + i];
  }
  const x = new Float64Array(n);
  for (let i = n - 1; i >= 0; i--) {
    let s = y[i];
    for (let k = i + 1; k < n; k++) s -= l[k * n + i] * x[k];
    x[i] = s / l[i * n + i];
  }
  return x;
}

function covariance(a: StationSample, b: StationSample, sa: number, sb: number, config: SnowEngineConfig): number {
  const r = Math.hypot(a.e - b.e, a.n - b.n) / 1000;
  return sa * sb * horizontalCorrelation(r, config.oiHorizontalKm) * verticalCorrelation(a.z - b.z, config.oiVerticalM);
}

/** OI weights α = (B + R)⁻¹·d for a set of stations. */
function oiWeights(stations: StationSample[], innov: Float64Array, sigmaB: Float64Array, config: SnowEngineConfig): Float64Array | null {
  const n = stations.length;
  const m = new Float64Array(n * n);
  for (let i = 0; i < n; i++) {
    for (let j = 0; j <= i; j++) {
      let c = covariance(stations[i], stations[j], sigmaB[i], sigmaB[j], config);
      if (i === j) c += sigmaObs(stations[i].obs, config) ** 2;
      m[i * n + j] = c;
      m[j * n + i] = c;
    }
  }
  return solveSpd(m, n, innov);
}

/** A measurement the profile correction is fitted on. */
interface CorrectionDatum {
  observed: number;
  /** Background at the datum's altitude shifted by `shiftM`. */
  background: (shiftM: number) => number;
  /** Error variance (measurement + background), cm². */
  variance: number;
  /** Horizontal relevance (1 at the scene, decreasing with distance). */
  relevance: number;
}

const SHIFT_PRIOR_M = 250;
const RATIO_PRIOR = 0.3;

/**
 * Robust weighted fit of k and Δz. For each Δz of a 20 m grid the factor k
 * has a closed form (weighted least squares with its prior); the Δz with the
 * lowest penalised cost wins. Two bisquare reweightings tame outliers. Δz is
 * only fitted when the measurements span 250 m of altitude or more, or when
 * some of them are below the background's snow line (no snow measured where
 * snow is modelled, or the reverse).
 */
function fitCorrection(data: CorrectionDatum[], altitudes: number[]): ProfileCorrection {
  if (data.length === 0) return NO_CORRECTION;
  const span = altitudes.length > 0 ? Math.max(...altitudes) - Math.min(...altitudes) : 0;
  const anyContrast = data.some((d) => (d.observed < 1) !== (d.background(0) < 1));
  const shifts: number[] = [];
  if (span >= 250 || anyContrast) for (let s = -600; s <= 600; s += 20) shifts.push(s);
  else shifts.push(0);
  const robust = data.map(() => 1);
  let best: ProfileCorrection = NO_CORRECTION;
  // Negative log-posterior: Σ w·(o − k·b)² + ((k − 1)/σk)² + (Δz/σz)², w = 1/variance.
  const tau = 1 / (RATIO_PRIOR * RATIO_PRIOR);
  for (let pass = 0; pass < 3; pass++) {
    let bestCost = Infinity;
    const weights = data.map((d, i) => (robust[i] * d.relevance) / d.variance);
    for (const s of shifts) {
      let sob = 0, sbb = 0;
      const bs = data.map((d) => d.background(s));
      for (let i = 0; i < data.length; i++) {
        sob += weights[i] * data[i].observed * bs[i];
        sbb += weights[i] * bs[i] * bs[i];
      }
      const k = Math.max(0.3, Math.min(3, (sob + tau) / (sbb + tau)));
      let cost = tau * (k - 1) ** 2 + (s / SHIFT_PRIOR_M) ** 2;
      for (let i = 0; i < data.length; i++) cost += weights[i] * (data[i].observed - k * bs[i]) ** 2;
      if (cost < bestCost) { bestCost = cost; best = { ratio: k, shiftM: s }; }
    }
    if (pass === 2) break;
    const res = data.map((d) => Math.abs(d.observed - best.ratio * d.background(best.shiftM)) / Math.sqrt(d.variance));
    for (let i = 0; i < data.length; i++) {
      const u = res[i] / 4.685;
      robust[i] = u < 1 ? (1 - u * u) ** 2 : 0;
    }
  }
  return best;
}

export interface LargeScaleInput {
  stations: StationSample[];
  bra: BraSnowProfile | null;
  /** Uncorrected background at a station, read at its altitude + shift. */
  stationBackground: (s: StationSample, shiftM: number) => number;
  /** Uncorrected background at the scene centre for an altitude (BRA levels). */
  centerBackground: (z: number) => number;
  config: SnowEngineConfig;
}

function corrected(c: ProfileCorrection, background: (shiftM: number) => number): number {
  return Math.max(0, c.ratio * background(c.shiftM));
}

export function analyseLargeScale(input: LargeScaleInput): LargeScaleAnalysis {
  const { stations, bra, config } = input;

  const stationDatum = (s: StationSample): CorrectionDatum => {
    const b0 = input.stationBackground(s, 0);
    return {
      observed: s.obs.hsCm,
      background: (shift) => input.stationBackground(s, shift),
      variance: sigmaBackground(b0, config) ** 2 + sigmaObs(s.obs, config) ** 2,
      relevance: horizontalCorrelation(s.distanceKm, config.oiHorizontalKm * 1.5),
    };
  };
  const braData: CorrectionDatum[] = [];
  const braAltitudes: number[] = [];
  if (bra) {
    for (const lvl of bra.levels) {
      if (!Number.isFinite(lvl.northCm) || !Number.isFinite(lvl.southCm)) continue;
      const value = (lvl.northCm + lvl.southCm) / 2;
      const b0 = input.centerBackground(lvl.altitudeM);
      braData.push({
        observed: value,
        background: (shift) => input.centerBackground(lvl.altitudeM + shift),
        variance: Math.max(config.braErrorCm, config.braErrorRel * value) ** 2 + sigmaBackground(b0, config) ** 2,
        relevance: 1,
      });
      braAltitudes.push(lvl.altitudeM);
    }
  }
  const allStationData = stations.map(stationDatum);

  // 1. Correction on everything, 2. first-guess check of what it leaves.
  const correction = fitCorrection([...allStationData, ...braData], [...stations.map((s) => s.z), ...braAltitudes]);
  const diagnostics: StationDiagnostic[] = [];
  const accepted: StationSample[] = [];
  for (const s of stations) {
    const b0 = input.stationBackground(s, 0);
    const bc = corrected(correction, (shift) => input.stationBackground(s, shift));
    const diag: StationDiagnostic = {
      id: s.obs.id, source: s.obs.source, name: s.obs.name, elevationM: s.z, distanceKm: s.distanceKm,
      observedCm: s.obs.hsCm, backgroundCm: b0, looAnalysisCm: b0, used: false,
    };
    if (Math.abs(s.obs.hsCm - bc) > config.qcSigma * Math.hypot(sigmaBackground(bc, config), sigmaObs(s.obs, config))) {
      diag.rejectedReason = 'first-guess';
    } else {
      diag.used = true;
      accepted.push(s);
    }
    diagnostics.push(diag);
  }

  // 3. OI of the innovations left after the correction.
  const oiOf = (set: StationSample[], corr: ProfileCorrection) => {
    const innov = new Float64Array(set.length);
    const sigmaB = new Float64Array(set.length);
    set.forEach((s, i) => {
      const b = corrected(corr, (shift) => input.stationBackground(s, shift));
      innov[i] = s.obs.hsCm - b;
      sigmaB[i] = sigmaBackground(b, config);
    });
    const alpha = set.length > 0 ? (oiWeights(set, innov, sigmaB, config) ?? new Float64Array(set.length)) : new Float64Array(0);
    return { alpha, sigmaB };
  };
  const { alpha, sigmaB } = oiOf(accepted, correction);

  // Leave-one-out: each used station predicted by the others alone
  // (correction refitted without it, then OI of the others).
  for (let k = 0; k < accepted.length; k++) {
    const sk = accepted[k];
    const others = accepted.filter((_, i) => i !== k);
    const corrK = fitCorrection([...others.map(stationDatum), ...braData], [...others.map((s) => s.z), ...braAltitudes]);
    const bk = corrected(corrK, (shift) => input.stationBackground(sk, shift));
    let inc = 0;
    if (others.length > 0) {
      const o = oiOf(others, corrK);
      const sbk = sigmaBackground(bk, config);
      others.forEach((s, i) => { inc += covariance(sk, s, sbk, o.sigmaB[i], config) * o.alpha[i]; });
    }
    const diag = diagnostics.find((dg) => dg.id === sk.obs.id && dg.used);
    if (diag) diag.looAnalysisCm = Math.max(0, bk + inc);
  }

  return { correction, used: accepted, alpha, sigmaB, diagnostics, braUsed: braData.length > 0 };
}

/** OI increment at a point (local metres, altitude) whose corrected background is `b`. */
export function oiIncrementAt(a: LargeScaleAnalysis, e: number, n: number, z: number, b: number, config: SnowEngineConfig): number {
  if (a.used.length === 0) return 0;
  const sx = sigmaBackground(b, config);
  let inc = 0;
  for (let k = 0; k < a.used.length; k++) {
    const s = a.used[k];
    const r = Math.hypot(e - s.e, n - s.n) / 1000;
    inc += sx * a.sigmaB[k] * horizontalCorrelation(r, config.oiHorizontalKm) * verticalCorrelation(z - s.z, config.oiVerticalM) * a.alpha[k];
  }
  return inc;
}

// ---------------------------------------------------------------------------
//  Fine scale: point measurements inside the scene
// ---------------------------------------------------------------------------

export interface PointSample {
  obs: SnowObservation;
  /** Fractional work-grid node coordinates. */
  fx: number;
  fy: number;
}

/**
 * Corrects the final field with in-scene point measurements: a global ratio
 * (shrunk towards 1 by n/(n + 3)) when there are at least 3, then simple
 * kriging of the residuals (exponential covariance, range `pointRangeM`).
 */
export function assimilatePoints(
  hs: Float32Array, w: number, h: number, ps: number, points: PointSample[], config: SnowEngineConfig,
): number {
  if (points.length === 0) return 0;
  const sample = (p: PointSample) => {
    const x = Math.min(w - 1, Math.max(0, Math.round(p.fx)));
    const y = Math.min(h - 1, Math.max(0, Math.round(p.fy)));
    return hs[y * w + x];
  };
  if (points.length >= 3) {
    let s = 0;
    for (const p of points) s += Math.log((p.obs.hsCm + 5) / (sample(p) + 5));
    const g = Math.exp((s / points.length) * (points.length / (points.length + 3)));
    for (let i = 0; i < hs.length; i++) hs[i] = Math.max(0, (hs[i] + 5) * g - 5);
  }
  const n = points.length;
  const resid = new Float64Array(n);
  for (let i = 0; i < n; i++) resid[i] = points[i].obs.hsCm - sample(points[i]);
  // Residual variance: the model's own spread at that scale, floor 10 cm.
  let mean = 0;
  for (let i = 0; i < hs.length; i++) mean += hs[i];
  mean /= hs.length;
  const sill = Math.max(10, 0.4 * mean) ** 2;
  const range = config.pointRangeM;
  const dist = (a: PointSample, b: PointSample) => Math.hypot((a.fx - b.fx) * ps, (a.fy - b.fy) * ps);
  const m = new Float64Array(n * n);
  for (let i = 0; i < n; i++) {
    for (let j = 0; j <= i; j++) {
      let c = sill * Math.exp(-dist(points[i], points[j]) / range);
      if (i === j) c += (points[i].obs.errorCm ?? config.pointErrorCm) ** 2;
      m[i * n + j] = c;
      m[j * n + i] = c;
    }
  }
  const alpha = solveSpd(m, n, resid);
  if (!alpha) return n;
  const reach = Math.ceil((4 * range) / ps);
  for (let k = 0; k < n; k++) {
    const p = points[k];
    const x0 = Math.max(0, Math.floor(p.fx) - reach);
    const x1 = Math.min(w - 1, Math.ceil(p.fx) + reach);
    const y0 = Math.max(0, Math.floor(p.fy) - reach);
    const y1 = Math.min(h - 1, Math.ceil(p.fy) + reach);
    for (let y = y0; y <= y1; y++) {
      for (let x = x0; x <= x1; x++) {
        const d = Math.hypot((x - p.fx) * ps, (y - p.fy) * ps);
        const i = y * w + x;
        hs[i] = Math.max(0, hs[i] + sill * Math.exp(-d / range) * alpha[k]);
      }
    }
  }
  return n;
}
