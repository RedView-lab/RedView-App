// ============================================================================
// Snow engine v2 — what the past weeks of weather tell
// ----------------------------------------------------------------------------
// From the hourly weather at the scene (temperature, precipitation, wind):
//  - a flat snowpack per altitude band (precipitation phase by temperature,
//    Hock 1999 melt with the clear-sky radiation of the hour): how much has
//    melted so far at each altitude, and on which days;
//  - a transport-weighted wind rose: hours with snow on the ground and a wind
//    above the transport threshold of Li & Pomeroy (1997) (dry snow
//    9.43 + 0.18·T + 0.0033·T² m/s at 10 m, lower for fresh snow, ~11 m/s for
//    wet or crusted snow), weighted by (U − Ut)·U² ∝ u*(u*² − u*t²).
// ============================================================================

import type { SnowEngineConfig } from './config';
import { beamNormal, sunPosition } from './radiation';
import type { WeatherHistory } from './types';

const HOUR_MS = 3_600_000;
const DAY_MS = 86_400_000;
const SECTORS = 16;

export interface BandSnowModel {
  zM: Float32Array;
  /** Cumulative melt / snowfall (snow water equivalent), mm, at the analysis time. */
  meltSweMm: Float32Array;
  snowfallSweMm: Float32Array;
  sweMm: Float32Array;
  /** UTC start of every day of the history. */
  dayStartMs: number[];
  /** Positive degree-days on days with snow on the ground, [band·nDays + day], °C·d. */
  meltPdd: Float32Array;
}

export interface WindRose {
  /** Transport weight per sector (wind from N, NNE, …), sums to 1 (zeros when no transport). */
  weights: Float64Array;
  /** Transport-weighted wind speed and threshold per sector, m/s. */
  speedMs: Float64Array;
  thresholdMs: Float64Array;
  /** Total transport potential, (m/s)³·h. */
  transport: number;
}

/** Bulk snow density through the season, kg m⁻³ (settled snow). */
export function bulkDensity(timeMs: number, latDeg: number): number {
  const d = new Date(timeMs);
  let month = d.getUTCMonth();
  if (latDeg < 0) month = (month + 6) % 12;
  const table = [260, 290, 320, 360, 400, 420, 420, 420, 420, 200, 200, 230];
  return table[month];
}

function snowFraction(tempC: number, config: SnowEngineConfig): number {
  if (tempC <= config.snowTempC) return 1;
  if (tempC >= config.rainTempC) return 0;
  return (config.rainTempC - tempC) / (config.rainTempC - config.snowTempC);
}

function thresholdWind(tempC: number, fresh: boolean, wet: boolean): number {
  if (wet) return 11;
  const t = Math.min(0, tempC);
  const dry = 9.43 + 0.18 * t + 0.0033 * t * t;
  return fresh ? 0.8 * dry : dry;
}

/** Hours of the history up to the analysis time. */
function usableHours(w: WeatherHistory, analysisTimeMs: number): number {
  const n = Math.min(w.temperatureC.length, w.precipitationMm.length, w.windSpeedMs.length, w.windDirDeg.length);
  return Math.max(0, Math.min(n, Math.floor((analysisTimeMs - w.startMs) / HOUR_MS) + 1));
}

export function runBandSnowModel(
  w: WeatherHistory,
  bandsM: number[],
  latDeg: number,
  lonDeg: number,
  analysisTimeMs: number,
  config: SnowEngineConfig,
): BandSnowModel {
  const hours = usableHours(w, analysisTimeMs);
  const nb = bandsM.length;
  const day0 = Math.floor(w.startMs / DAY_MS) * DAY_MS;
  const nDays = Math.max(1, Math.ceil((w.startMs + hours * HOUR_MS - day0) / DAY_MS));
  const dayStartMs = Array.from({ length: nDays }, (_, d) => day0 + d * DAY_MS);
  const zM = Float32Array.from(bandsM);
  const swe = new Float32Array(nb);
  const melt = new Float32Array(nb);
  const fall = new Float32Array(nb);
  const meltPdd = new Float32Array(nb * nDays);
  const mfH = config.meltFactor / 24;
  const rfH = config.radiationFactor / 24;
  for (let t = 0; t < hours; t++) {
    const time = w.startMs + t * HOUR_MS;
    const day = Math.min(nDays - 1, Math.floor((time - day0) / DAY_MS));
    const sun = sunPosition(time + HOUR_MS / 2, latDeg, lonDeg);
    const sinEl = Math.max(0, Math.sin((sun.elevationDeg * Math.PI) / 180));
    const temp = w.temperatureC[t];
    const precip = Math.max(0, w.precipitationMm[t] || 0);
    for (let b = 0; b < nb; b++) {
      const tb = temp + config.lapseRate * (zM[b] - w.elevationM);
      const snow = precip * snowFraction(tb, config);
      swe[b] += snow;
      fall[b] += snow;
      if (tb > 0 && swe[b] > 0) {
        const iFlat = beamNormal(sun, zM[b], config.transmissivity) * sinEl;
        const m = Math.min(swe[b], (mfH + rfH * iFlat) * tb);
        swe[b] -= m;
        melt[b] += m;
        meltPdd[b * nDays + day] += tb / 24;
      }
    }
  }
  return { zM, meltSweMm: melt, snowfallSweMm: fall, sweMm: swe, dayStartMs, meltPdd };
}

/** Band values interpolated at an altitude (clamped at the ends). */
export function bandValueAt(band: BandSnowModel, values: Float32Array, z: number): number {
  const zs = band.zM;
  const n = zs.length;
  if (n === 0) return 0;
  if (z <= zs[0]) return values[0];
  if (z >= zs[n - 1]) return values[n - 1];
  const step = (zs[n - 1] - zs[0]) / (n - 1);
  const f = (z - zs[0]) / step;
  const k = Math.min(n - 2, Math.floor(f));
  return values[k] + (values[k + 1] - values[k]) * (f - k);
}

export function computeWindRose(
  w: WeatherHistory,
  sceneAltitudeM: number,
  analysisTimeMs: number,
  config: SnowEngineConfig,
  initialSweMm: number,
): WindRose {
  const hours = usableHours(w, analysisTimeMs);
  const weights = new Float64Array(SECTORS);
  const speedSum = new Float64Array(SECTORS);
  const thrSum = new Float64Array(SECTORS);
  let transport = 0;
  // Snow on the ground at the scene altitude, re-simulated hour by hour.
  let swe = initialSweMm;
  let lastSnowHour = -1e9;
  let lastWarmHour = -1e9;
  const mfH = config.meltFactor / 24;
  for (let t = 0; t < hours; t++) {
    const temp = w.temperatureC[t] + config.lapseRate * (sceneAltitudeM - w.elevationM);
    const precip = Math.max(0, w.precipitationMm[t] || 0);
    const snow = precip * snowFraction(temp, config);
    swe += snow;
    if (temp > 0) swe = Math.max(0, swe - mfH * 2 * temp);
    if (snow > 0.3) lastSnowHour = t;
    if (temp > 0.5) lastWarmHour = t;
    if (swe < 20) continue;
    const u = w.windSpeedMs[t];
    const fresh = t - lastSnowHour <= 24;
    const wet = !fresh && t - lastWarmHour <= 24;
    const ut = thresholdWind(temp, fresh, wet);
    if (!(u > ut)) continue;
    const q = (u - ut) * u * u;
    const dir = ((w.windDirDeg[t] % 360) + 360) % 360;
    const s = Math.floor(((dir + 360 / SECTORS / 2) % 360) / (360 / SECTORS));
    weights[s] += q;
    speedSum[s] += q * u;
    thrSum[s] += q * ut;
    transport += q;
  }
  const speedMs = new Float64Array(SECTORS);
  const thresholdMs = new Float64Array(SECTORS);
  for (let s = 0; s < SECTORS; s++) {
    if (weights[s] > 0) {
      speedMs[s] = speedSum[s] / weights[s];
      thresholdMs[s] = thrSum[s] / weights[s];
    }
  }
  if (transport > 0) for (let s = 0; s < SECTORS; s++) weights[s] /= transport;
  return { weights, speedMs, thresholdMs, transport };
}

/** Default rose when no history: the snow-bearing wind of the region, spread ±45°. */
export function defaultWindRose(fromDeg: number): WindRose {
  const weights = new Float64Array(SECTORS);
  let sum = 0;
  for (let s = 0; s < SECTORS; s++) {
    let d = Math.abs(s * (360 / SECTORS) - fromDeg) % 360;
    if (d > 180) d = 360 - d;
    weights[s] = Math.exp(-((d / 35) ** 2));
    sum += weights[s];
  }
  for (let s = 0; s < SECTORS; s++) weights[s] /= sum;
  return {
    weights,
    speedMs: new Float64Array(SECTORS).fill(12),
    thresholdMs: new Float64Array(SECTORS).fill(7.5),
    transport: 0,
  };
}

