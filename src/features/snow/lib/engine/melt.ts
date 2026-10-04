// ============================================================================
// Snow engine v2 — differential melt by exposure
// ----------------------------------------------------------------------------
// AROME melts the snow of a flat, unshaded cell. On a slope the melt of a day
// scales with Hock's (1999) melt index MF + r·I, I the potential direct
// radiation of that slope with its horizons. So each node melts
//     M(x) = M_flat(z)·(MF + r·Ī_w(x)) / (MF + r·Ī_w,flat(z)),
// Ī_w the daily radiation weighted by the positive degree-days of the days
// the snow was melting at that altitude (from the band snowpack). M_flat(z)
// is the band snowpack's cumulative melt, capped by its cumulative snowfall.
// When the avalanche bulletin gives north and south depths, the radiation
// factor is rescaled so the modelled north–south difference matches them.
// ============================================================================

import type { SnowEngineConfig } from './config';
import { type ElevationProfile, profileAt } from './elevationProfile';
import type { SceneFrame } from './grid';
import {
  type HorizonField,
  type SurfaceGeometry,
  dailyMeanDirect,
  dailyRadiationField,
  daySunPath,
} from './radiation';
import type { BraSnowProfile } from './types';
import { type BandSnowModel, bandValueAt, bulkDensity } from './weatherHistory';

const STEP_MIN = 20;
const DAY_MS = 86_400_000;

export interface MeltModel {
  source: 'history' | 'season';
  /** Melt of a node relative to flat open ground at its altitude (reduced horizon grid). */
  ratio: Float32Array;
  ratioWidth: number;
  ratioHeight: number;
  /** Cumulative flat melt at altitude z, cm of snow. */
  flatMeltCm: (z: number) => number;
  radiationScale: number;
  braCalibrated: boolean;
}

interface DayWeights {
  sampleDays: number[];
  /** Per band, weight of each sample day (sums to 1 where the band melted). */
  perBand: Float64Array[];
}

function pickSampleDays(band: BandSnowModel): DayWeights | null {
  const nb = band.zM.length;
  const nDays = band.dayStartMs.length;
  const dayTotal = new Float64Array(nDays);
  for (let b = 0; b < nb; b++) for (let d = 0; d < nDays; d++) dayTotal[d] += band.meltPdd[b * nDays + d];
  const meltDays = [];
  for (let d = 0; d < nDays; d++) if (dayTotal[d] > 0) meltDays.push(d);
  if (meltDays.length === 0) return null;
  const first = meltDays[0];
  const last = meltDays[meltDays.length - 1];
  const k = Math.min(10, Math.max(1, Math.ceil((last - first + 1) / 6)));
  const sampleIdx = k === 1 ? [Math.round((first + last) / 2)] : Array.from({ length: k }, (_, i) => Math.round(first + (i * (last - first)) / (k - 1)));
  const perBand: Float64Array[] = [];
  for (let b = 0; b < nb; b++) {
    const wts = new Float64Array(k);
    for (let d = 0; d < nDays; d++) {
      const pdd = band.meltPdd[b * nDays + d];
      if (pdd <= 0) continue;
      if (k === 1) { wts[0] += pdd; continue; }
      let s = 0;
      while (s < k - 2 && sampleIdx[s + 1] < d) s++;
      const span = sampleIdx[s + 1] - sampleIdx[s];
      const t = span > 0 ? Math.max(0, Math.min(1, (d - sampleIdx[s]) / span)) : 0;
      wts[s] += pdd * (1 - t);
      wts[s + 1] += pdd * t;
    }
    const sum = wts.reduce((a, v) => a + v, 0);
    if (sum > 0) for (let s = 0; s < k; s++) wts[s] /= sum;
    perBand.push(wts);
  }
  return { sampleDays: sampleIdx.map((d) => band.dayStartMs[d]), perBand };
}

/** Band position of an altitude: lower band index and blend weight. */
function bandPos(band: BandSnowModel, z: number): [number, number] {
  const zs = band.zM;
  const n = zs.length;
  if (n === 1 || z <= zs[0]) return [0, 0];
  if (z >= zs[n - 1]) return [n - 2, 1];
  const step = (zs[n - 1] - zs[0]) / (n - 1);
  const f = (z - zs[0]) / step;
  const k = Math.min(n - 2, Math.floor(f));
  return [k, f - k];
}

export interface MeltInput {
  horizons: HorizonField;
  geometry: SurfaceGeometry;
  /** Altitude of each node of the reduced horizon grid. */
  altitude: Float32Array;
  frame: SceneFrame;
  band: BandSnowModel | null;
  profile: ElevationProfile;
  bra: BraSnowProfile | null;
  analysisTimeMs: number;
  config: SnowEngineConfig;
}

function ratioFromIndex(mf: number, r: number, iw: number, iflat: number): number {
  return (mf + r * iw) / Math.max(1e-6, mf + r * iflat);
}

export function buildMeltModel(input: MeltInput): MeltModel {
  const { horizons, geometry, altitude, frame, band, config } = input;
  const n = geometry.n;
  const lat = frame.center.lat;
  const lon = frame.center.lon;
  const tau = config.transmissivity;
  const rho = bulkDensity(input.analysisTimeMs, lat);
  const weights = band ? pickSampleDays(band) : null;

  if (band && weights) {
    const k = weights.sampleDays.length;
    const paths = weights.sampleDays.map((d) => daySunPath(d, lat, lon, STEP_MIN));
    const fields = paths.map((p) => dailyRadiationField(horizons, geometry, p, STEP_MIN, tau));
    const nb = band.zM.length;
    // Flat unshaded radiation per band and sample day, then weighted per band.
    const flatW = new Float64Array(nb);
    for (let b = 0; b < nb; b++) {
      for (let s = 0; s < k; s++) flatW[b] += weights.perBand[b][s] * dailyMeanDirect(paths[s], STEP_MIN, band.zM[b], tau, 0, 0);
    }
    const aspectWeighted = (slope: number, aspect: number, z: number): number => {
      const [b0, t] = bandPos(band, z);
      let sum = 0;
      for (let s = 0; s < k; s++) {
        const w = weights.perBand[b0][s] * (1 - t) + (weights.perBand[b0 + 1]?.[s] ?? weights.perBand[b0][s]) * t;
        sum += w * dailyMeanDirect(paths[s], STEP_MIN, z, tau, slope, aspect);
      }
      return sum;
    };
    const flatAt = (z: number) => {
      const [b0, t] = bandPos(band, z);
      return flatW[b0] * (1 - t) + (flatW[Math.min(nb - 1, b0 + 1)]) * t;
    };
    const meltSwe = (z: number) => Math.min(bandValueAt(band, band.meltSweMm, z), bandValueAt(band, band.snowfallSweMm, z));
    const flatMeltCm = (z: number) => (meltSwe(z) * 100) / rho;

    // Optional calibration of the radiation factor on the BRA north/south depths.
    let scale = 1;
    let braCalibrated = false;
    if (input.bra) {
      const levels = input.bra.levels.filter((l) => flatMeltCm(l.altitudeM) > 3 && Math.max(l.northCm, l.southCm) > 0);
      if (levels.length > 0) {
        const cost = (lnK: number) => {
          const kk = Math.exp(lnK);
          let c = 0;
          for (const l of levels) {
            const fl = flatAt(l.altitudeM);
            const fN = ratioFromIndex(config.meltFactor, config.radiationFactor * kk, aspectWeighted(30, 0, l.altitudeM), fl);
            const fS = ratioFromIndex(config.meltFactor, config.radiationFactor * kk, aspectWeighted(30, 180, l.altitudeM), fl);
            const model = flatMeltCm(l.altitudeM) * (fS - fN);
            c += (model - (l.northCm - l.southCm)) ** 2;
          }
          return c;
        };
        let a = Math.log(0.25);
        let b = Math.log(4);
        const g = (Math.sqrt(5) - 1) / 2;
        for (let it = 0; it < 24; it++) {
          const c1 = b - g * (b - a);
          const c2 = a + g * (b - a);
          if (cost(c1) < cost(c2)) b = c2; else a = c1;
        }
        scale = Math.exp((a + b) / 2);
        braCalibrated = true;
      }
    }

    const r = config.radiationFactor * scale;
    const ratio = new Float32Array(n);
    for (let i = 0; i < n; i++) {
      const [b0, t] = bandPos(band, altitude[i]);
      const wa = weights.perBand[b0];
      const wb = weights.perBand[Math.min(nb - 1, b0 + 1)];
      let iw = 0;
      for (let s = 0; s < k; s++) iw += (wa[s] * (1 - t) + wb[s] * t) * fields[s][i];
      ratio[i] = ratioFromIndex(config.meltFactor, r, iw, flatAt(altitude[i]));
    }
    return { source: 'history', ratio, ratioWidth: horizons.width, ratioHeight: horizons.height, flatMeltCm, radiationScale: scale, braCalibrated };
  }

  // No usable history: a seasonal guess. Share of the flat accumulation melted
  // so far by month (northern hemisphere), radiation of the last 30 days.
  const date = new Date(input.analysisTimeMs);
  let month = date.getUTCMonth();
  if (lat < 0) month = (month + 6) % 12;
  const seasonShare = [0.05, 0.12, 0.3, 0.55, 0.75, 0.9, 0.9, 0.9, 0.9, 0.1, 0.05, 0.03][month];
  const days = [0, 10, 20, 30].map((d) => Math.floor((input.analysisTimeMs - d * DAY_MS) / DAY_MS) * DAY_MS);
  const paths = days.map((d) => daySunPath(d, lat, lon, STEP_MIN));
  const fields = paths.map((p) => dailyRadiationField(horizons, geometry, p, STEP_MIN, tau));
  const flatCache = new Map<number, number>();
  const flatAt = (z: number) => {
    const key = Math.round(z / 50);
    let v = flatCache.get(key);
    if (v === undefined) {
      v = 0;
      for (const p of paths) v += dailyMeanDirect(p, STEP_MIN, key * 50, tau, 0, 0) / paths.length;
      flatCache.set(key, v);
    }
    return v;
  };
  const ratio = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    let iw = 0;
    for (let s = 0; s < paths.length; s++) iw += fields[s][i] / paths.length;
    ratio[i] = ratioFromIndex(config.meltFactor, config.radiationFactor, iw, flatAt(altitude[i]));
  }
  const profile = input.profile;
  return {
    source: 'season',
    ratio,
    ratioWidth: horizons.width,
    ratioHeight: horizons.height,
    flatMeltCm: (z: number) => seasonShare * 0.6 * profileAt(profile, z),
    radiationScale: 1,
    braCalibrated: false,
  };
}
