// ============================================================================
// Synthetic snow world for the snow-quality bench
// ----------------------------------------------------------------------------
// A 48 km alpine relief (ridged fBm, 60 m) holds a 2.4 km "LiDAR" scene
// (3.76 m, with metre-scale ribs and couloirs). The weather of the last 75
// days (storms, foehn, fair days) drives a reference snow model written here,
// independently of the engine and with different formulations and parameters:
//   - flat snowpack per altitude: classic degree-day (no radiation term),
//     orographic precipitation +5 %/100 m, lapse −0.6 °C/100 m, ρ = 300;
//   - wind: Winstral-type multiplier on Sx(100 m) along the storm wind plus a
//     curvature term, renormalised (statistical, Grünewald/Winstral style);
//   - gravity: exponential holding depth 20·e^(−0.065·S) m (holds 25–55 % less
//     than CHM's power law on steep faces), trigger 28°, multiple-flow routing
//     ∝ drop⁴ on the depression-filled DEM, deposits ≤ 6 m spread laterally;
//   - melt by exposure: degree-day × (1 + 0.9·sin S·(−cos aspect)), no horizons;
//   - forest −35 % of accumulation; correlated multiplicative noise σ ≈ 12 %.
// "AROME" is the flat reference snowpack at a smoothed model orography, with a
// precipitation and snow-line bias; stations are flat-field reference values
// plus 3 cm noise. The engine sees only what the app would see.
// ============================================================================

import type {
  BraSnowProfile,
  CoarseSnowGrid,
  FarDem,
  SnowEngineInput,
  SnowObservation,
  WeatherHistory,
} from '../../src/features/snow/lib/engine/types';
import { DEFAULT_SNOW_ENGINE_CONFIG } from '../../src/features/snow/lib/engine/config';
import { GradientNoise, Rng } from './noise';

const DEG = Math.PI / 180;
const HOUR_MS = 3_600_000;
const DAY_MS = 86_400_000;
const M_PER_DEG_LAT = 110_540;

export interface StormSpec {
  /** Days before the analysis. */
  daysAgo: number;
  hours: number;
  windFromDeg: number;
  windMs: number;
  precipMmH: number;
  tempOffsetC: number;
}

export interface WorldSpec {
  name: string;
  seed: number;
  analysisIso: string;
  /** Temperature at 1500 m: seasonal mean over the 75 days, and its trend (°C per day). */
  temp1500C: number;
  tempTrendCPerDay: number;
  storms: StormSpec[];
  /** Foehn: dry strong southerly wind hours. */
  foehnDaysAgo: number[];
  /** Horizontal precipitation anomaly amplitude. */
  precipAnomaly: number;
  forest: boolean;
  /** Reference-model wind effect (Sx multiplier per degree). */
  truthWindPerDeg: number;
  noiseSigma: number;
  aromePrecipBias: number;
  aromeTempBiasC: number;
  orographyNoiseM: number;
  stationCount: number;
  braNoiseCm: number | null;
  /** Perturbation of the weather handed to the engine (σ of temperature noise, °C). */
  weatherNoiseC: number;
}

export interface World {
  spec: WorldSpec;
  /** Engine input (what the app would assemble). */
  input: SnowEngineInput;
  /** Reference snow depth on the scene grid, cm. */
  truth: Float32Array;
  /** Reference flat-field depth on the scene grid (before terrain processes), cm. */
  truthFlat: Float32Array;
  sceneW: number;
  sceneH: number;
  sceneCell: number;
  sceneZ: Float32Array;
  canopy: Float32Array;
  /** Coarse grid as scene-local metre bounds, for the legacy engine. */
  legacy: { aromeData: Float32Array; aromeW: number; aromeH: number; aromeBounds: [number, number, number, number] };
  centerLon: number;
  centerLat: number;
  /** Reference-model components on the scene grid (diagnostics only). */
  parts: { windMul: Float32Array; gravityChange: Float32Array; meltFactor: Float32Array; noise: Float32Array };
}

const FAR_SIZE_M = 48_000;
const FAR_CELL = 60;
const SCENE_N = 640;
const SCENE_SIZE_M = 2_400;

function sampleBilinear(src: Float32Array, w: number, h: number, fx: number, fy: number): number {
  const x = Math.min(w - 1, Math.max(0, fx));
  const y = Math.min(h - 1, Math.max(0, fy));
  const x0 = Math.min(w - 2, Math.floor(x));
  const y0 = Math.min(h - 2, Math.floor(y));
  const tx = x - x0;
  const ty = y - y0;
  const i = y0 * w + x0;
  const a = src[i] + (src[i + 1] - src[i]) * tx;
  const b = src[i + w] + (src[i + w + 1] - src[i + w]) * tx;
  return a + (b - a) * ty;
}

function blur(src: Float32Array, w: number, h: number, r: number): Float32Array {
  const tmp = new Float32Array(w * h);
  const out = new Float32Array(w * h);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      let s = 0, n = 0;
      for (let k = -r; k <= r; k++) { const xx = x + k; if (xx >= 0 && xx < w) { s += src[y * w + xx]; n++; } }
      tmp[y * w + x] = s / n;
    }
  }
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      let s = 0, n = 0;
      for (let k = -r; k <= r; k++) { const yy = y + k; if (yy >= 0 && yy < h) { s += tmp[yy * w + x]; n++; } }
      out[y * w + x] = s / n;
    }
  }
  return out;
}

function slopeAspect(z: Float32Array, w: number, h: number, cell: number) {
  const slope = new Float32Array(w * h);
  const aspect = new Float32Array(w * h);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const zx = (z[y * w + Math.min(w - 1, x + 1)] - z[y * w + Math.max(0, x - 1)]) / (cell * (Math.min(w - 1, x + 1) - Math.max(0, x - 1)));
      const zy = (z[Math.min(h - 1, y + 1) * w + x] - z[Math.max(0, y - 1) * w + x]) / (cell * (Math.min(h - 1, y + 1) - Math.max(0, y - 1)));
      slope[y * w + x] = Math.atan(Math.hypot(zx, zy)) / DEG;
      let a = Math.atan2(-zx, -zy) / DEG;
      if (a < 0) a += 360;
      aspect[y * w + x] = a;
    }
  }
  return { slope, aspect };
}

/** Priority-flood depression filling with an ε gradient (every cell drains to the edge). */
function fillDepressions(z: Float32Array, w: number, h: number): Float64Array {
  const out = Float64Array.from(z);
  const done = new Uint8Array(w * h);
  // Binary heap of (elevation, index).
  const heapZ: number[] = [];
  const heapI: number[] = [];
  const push = (zz: number, i: number) => {
    heapZ.push(zz); heapI.push(i);
    let c = heapZ.length - 1;
    while (c > 0) {
      const p = (c - 1) >> 1;
      if (heapZ[p] <= heapZ[c]) break;
      [heapZ[p], heapZ[c]] = [heapZ[c], heapZ[p]];
      [heapI[p], heapI[c]] = [heapI[c], heapI[p]];
      c = p;
    }
  };
  const pop = (): number => {
    const top = heapI[0];
    const lz = heapZ.pop() as number;
    const li = heapI.pop() as number;
    if (heapZ.length > 0) {
      heapZ[0] = lz; heapI[0] = li;
      let c = 0;
      for (;;) {
        const l = 2 * c + 1, r = l + 1;
        let m = c;
        if (l < heapZ.length && heapZ[l] < heapZ[m]) m = l;
        if (r < heapZ.length && heapZ[r] < heapZ[m]) m = r;
        if (m === c) break;
        [heapZ[m], heapZ[c]] = [heapZ[c], heapZ[m]];
        [heapI[m], heapI[c]] = [heapI[c], heapI[m]];
        c = m;
      }
    }
    return top;
  };
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    if (x === 0 || y === 0 || x === w - 1 || y === h - 1) { done[y * w + x] = 1; push(out[y * w + x], y * w + x); }
  }
  while (heapZ.length > 0) {
    const i = pop();
    const x = i % w, y = (i - x) / w;
    for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) {
      const xx = x + dx, yy = y + dy;
      if ((!dx && !dy) || xx < 0 || yy < 0 || xx >= w || yy >= h) continue;
      const j = yy * w + xx;
      if (done[j]) continue;
      done[j] = 1;
      if (out[j] <= out[i]) out[j] = out[i] + 1e-3;
      push(out[j], j);
    }
  }
  return out;
}

/** Reference flat snowpack table: depth (cm) by altitude and precipitation multiplier. */
class FlatSnowTable {
  readonly z0 = 300;
  readonly dz = 50;
  readonly nz = 90;
  readonly a0 = 0.4;
  readonly da = 0.05;
  readonly na = 29;
  readonly depth: Float32Array;
  readonly melt: Float32Array;

  constructor(weather: { temp1500: Float32Array; precip: Float32Array }, rhoTruth: number) {
    this.depth = new Float32Array(this.nz * this.na);
    this.melt = new Float32Array(this.nz * this.na);
    const ddf = 3.0 / 24; // mm / °C / h, classic degree-day on flat terrain
    for (let iz = 0; iz < this.nz; iz++) {
      const z = this.z0 + iz * this.dz;
      for (let ia = 0; ia < this.na; ia++) {
        const a = this.a0 + ia * this.da;
        let swe = 0;
        let melted = 0;
        for (let t = 0; t < weather.temp1500.length; t++) {
          const temp = weather.temp1500[t] - 0.006 * (z - 1500);
          const p = weather.precip[t] * a * Math.max(0.3, 1 + 0.05 * (z - 1500) / 100);
          const phase = temp <= -0.5 ? 1 : temp >= 1.5 ? 0 : (1.5 - temp) / 2;
          swe += p * phase;
          if (temp > 0 && swe > 0) {
            const m = Math.min(swe, ddf * temp);
            swe -= m;
            melted += m;
          }
        }
        this.depth[iz * this.na + ia] = (swe * 100) / rhoTruth;
        this.melt[iz * this.na + ia] = (melted * 100) / rhoTruth;
      }
    }
  }

  private lookup(table: Float32Array, z: number, a: number): number {
    const fz = Math.max(0, Math.min(this.nz - 1, (z - this.z0) / this.dz));
    const fa = Math.max(0, Math.min(this.na - 1, (a - this.a0) / this.da));
    return sampleBilinear(table, this.na, this.nz, fa, fz);
  }

  depthAt(z: number, a: number): number { return this.lookup(this.depth, z, a); }
  meltAt(z: number, a: number): number { return this.lookup(this.melt, z, a); }
}

export function buildWorld(spec: WorldSpec): World {
  const rng = new Rng(spec.seed);
  const relief = new GradientNoise(spec.seed * 7 + 1);
  const detail = new GradientNoise(spec.seed * 7 + 2);
  const climate = new GradientNoise(spec.seed * 7 + 3);
  const forestNoise = new GradientNoise(spec.seed * 7 + 4);
  const snowNoise = new GradientNoise(spec.seed * 7 + 5);

  // ---- Far relief -----------------------------------------------------------
  // Continuous relief function: the far grid samples it, the scene evaluates
  // it at full resolution (no bilinear facets in the slopes).
  const reliefAt = (x: number, y: number) => {
    const wx = x + 2500 * relief.fbm(x / 9000, y / 9000, 3);
    const wy = y + 2500 * relief.fbm(x / 9000 + 5, y / 9000 - 3, 3);
    const r = relief.ridged(wx / 16000, wy / 16000, 9, 0.52);
    const base = relief.fbm(x / 30000 + 11, y / 30000, 2);
    return 700 + 3300 * Math.pow(r, 1.15) + 500 * base;
  };
  const farN = Math.round(FAR_SIZE_M / FAR_CELL) + 1;
  const far = new Float32Array(farN * farN);
  const half = FAR_SIZE_M / 2;
  for (let j = 0; j < farN; j++) {
    for (let i = 0; i < farN; i++) far[j * farN + i] = reliefAt(-half + i * FAR_CELL, -half + j * FAR_CELL);
  }

  // Scene centre: high relief, mean altitude ~2000–2700 m, in the central 16 km.
  let best = -Infinity;
  let cx = 0;
  let cy = 0;
  const win = Math.round(1200 / FAR_CELL);
  for (let j = Math.round((half - 8000) / FAR_CELL); j <= Math.round((half + 8000) / FAR_CELL); j += 4) {
    for (let i = Math.round((half - 8000) / FAR_CELL); i <= Math.round((half + 8000) / FAR_CELL); i += 4) {
      let mn = Infinity, mx = -Infinity, s = 0, k = 0;
      for (let dj = -win; dj <= win; dj += 2) {
        for (let di = -win; di <= win; di += 2) {
          const v = far[(j + dj) * farN + (i + di)];
          mn = Math.min(mn, v); mx = Math.max(mx, v); s += v; k++;
        }
      }
      const mean = s / k;
      const score = (mx - mn) - 3 * Math.abs(mean - 2350);
      if (score > best) { best = score; cx = -half + i * FAR_CELL; cy = -half + j * FAR_CELL; }
    }
  }

  // ---- Scene DTM: far relief + ribs, couloirs and roughness -----------------
  // The reference snow is computed on the scene plus a 400 m margin (snow
  // sliding or blowing in from outside the tile), then cropped.
  const sceneCell = SCENE_SIZE_M / (SCENE_N - 1);
  const PAD = Math.round(400 / sceneCell);
  const TN = SCENE_N + 2 * PAD;
  const ox = cx - SCENE_SIZE_M / 2;
  const oy = cy - SCENE_SIZE_M / 2;
  const tox = ox - PAD * sceneCell;
  const toy = oy - PAD * sceneCell;
  const tz = new Float32Array(TN * TN);
  for (let j = 0; j < TN; j++) {
    for (let i = 0; i < TN; i++) {
      const x = tox + i * sceneCell;
      const y = toy + j * sceneCell;
      const baseZ = reliefAt(x, y);
      const ribs = 28 * (detail.ridged(x / 520, y / 520, 4, 0.55) - 0.35);
      const rough = 9 * detail.fbm(x / 140, y / 140, 4) + 2.5 * detail.fbm(x / 30, y / 30, 3);
      tz[j * TN + i] = baseZ + ribs + rough;
    }
  }
  const crop = (src: Float32Array) => {
    const out = new Float32Array(SCENE_N * SCENE_N);
    for (let j = 0; j < SCENE_N; j++) for (let i = 0; i < SCENE_N; i++) out[j * SCENE_N + i] = src[(j + PAD) * TN + i + PAD];
    return out;
  };
  const sceneZ = crop(tz);

  // ---- Weather of the last 75 days -------------------------------------------
  const analysisMs = Date.parse(spec.analysisIso);
  const hours = 75 * 24;
  const startMs = analysisMs - (hours - 1) * HOUR_MS;
  const temp1500 = new Float32Array(hours);
  const precip = new Float32Array(hours);
  const windMs = new Float32Array(hours);
  const windDir = new Float32Array(hours);
  const snowfall = new Float32Array(hours);
  for (let t = 0; t < hours; t++) {
    const daysAgo = (hours - 1 - t) / 24;
    const time = startMs + t * HOUR_MS;
    const hourUtc = new Date(time).getUTCHours();
    const synoptic = 3.5 * Math.sin((2 * Math.PI * t) / (24 * 7.3) + spec.seed);
    const diurnal = 4 * Math.cos((2 * Math.PI * (hourUtc - 13)) / 24);
    temp1500[t] = spec.temp1500C - spec.tempTrendCPerDay * daysAgo + synoptic + diurnal;
    windMs[t] = 3 + 2.5 * rng.next();
    windDir[t] = (200 + 160 * rng.next()) % 360;
  }
  for (const s of spec.storms) {
    const t0 = hours - 1 - Math.round(s.daysAgo * 24);
    for (let k = 0; k < s.hours; k++) {
      const t = t0 + k;
      if (t < 0 || t >= hours) continue;
      precip[t] = s.precipMmH * (0.6 + 0.8 * rng.next());
      windMs[t] = s.windMs * (0.75 + 0.5 * rng.next());
      windDir[t] = s.windFromDeg + 25 * rng.normal();
      temp1500[t] += s.tempOffsetC;
    }
    // Post-frontal wind with the storm direction.
    for (let k = s.hours; k < s.hours + 12; k++) {
      const t = t0 + k;
      if (t < 0 || t >= hours) continue;
      windMs[t] = s.windMs * 0.8;
      windDir[t] = s.windFromDeg + 15 * rng.normal();
    }
  }
  for (const d of spec.foehnDaysAgo) {
    const t0 = hours - 1 - Math.round(d * 24);
    for (let k = 0; k < 30; k++) {
      const t = t0 + k;
      if (t < 0 || t >= hours) continue;
      windMs[t] = 13 + 5 * rng.next();
      windDir[t] = 180 + 15 * rng.normal();
      temp1500[t] += 4;
    }
  }
  for (let t = 0; t < hours; t++) snowfall[t] = temp1500[t] < 1 ? precip[t] * 1.1 : 0;

  // ---- Reference snowpack ---------------------------------------------------
  const rhoTruth = 300;
  const table = new FlatSnowTable({ temp1500, precip }, rhoTruth);
  const anomaly = (x: number, y: number) => 1 + spec.precipAnomaly * 1.6 * climate.fbm(x / 12000, y / 12000, 3);

  const tn = TN * TN;
  const tFlat = new Float32Array(tn);
  const meltFlat = new Float32Array(tn);
  for (let j = 0; j < TN; j++) {
    for (let i = 0; i < TN; i++) {
      const x = tox + i * sceneCell;
      const y = toy + j * sceneCell;
      const a = anomaly(x, y);
      const z = tz[j * TN + i];
      tFlat[j * TN + i] = table.depthAt(z, a);
      meltFlat[j * TN + i] = table.meltAt(z, a);
    }
  }
  const { slope, aspect } = slopeAspect(tz, TN, TN, sceneCell);

  // Canopy: below a ragged tree line, not on steep rock.
  const tCanopy = new Float32Array(tn);
  if (spec.forest) {
    for (let j = 0; j < TN; j++) {
      for (let i = 0; i < TN; i++) {
        const x = tox + i * sceneCell;
        const y = toy + j * sceneCell;
        const idx = j * TN + i;
        const treeline = 2050 + 120 * forestNoise.fbm(x / 900, y / 900, 3);
        const below = Math.max(0, Math.min(1, (treeline - tz[idx]) / 150));
        const patch = Math.max(0, Math.min(1, 0.55 + 1.2 * forestNoise.fbm(x / 160, y / 160, 3)));
        tCanopy[idx] = slope[idx] < 42 ? below * patch * 0.9 : 0;
      }
    }
  }

  // Reference wind: Winstral-type multiplier on Sx(100 m) along the storm wind.
  const windFrom = spec.storms.length > 0 ? spec.storms[0].windFromDeg : 300;
  const ux = Math.sin(windFrom * DEG);
  const uy = Math.cos(windFrom * DEG);
  const sx = new Float32Array(tn);
  const steps = Math.round(100 / sceneCell);
  for (let j = 0; j < TN; j++) {
    for (let i = 0; i < TN; i++) {
      const zc = tz[j * TN + i];
      let bestT = -1e9;
      for (let k = 1; k <= steps; k++) {
        const xi = Math.round(i + ux * k);
        const yj = Math.round(j + uy * k);
        let zs: number;
        if (xi < 0 || yj < 0 || xi >= TN || yj >= TN) {
          const x = tox + xi * sceneCell;
          const y = toy + yj * sceneCell;
          zs = sampleBilinear(far, farN, farN, (x + half) / FAR_CELL, (y + half) / FAR_CELL);
        } else zs = tz[yj * TN + xi];
        const tt = (zs - zc) / (k * sceneCell);
        if (tt > bestT) bestT = tt;
      }
      sx[j * TN + i] = Math.atan(bestT) / DEG;
    }
  }
  const smooth = blur(tz, TN, TN, 6);
  const lap = new Float32Array(tn);
  for (let j = 1; j < TN - 1; j++) {
    for (let i = 1; i < TN - 1; i++) {
      const c = smooth[j * TN + i];
      lap[j * TN + i] = (4 * c - smooth[j * TN + i - 1] - smooth[j * TN + i + 1] - smooth[(j - 1) * TN + i] - smooth[(j + 1) * TN + i]);
    }
  }
  let lapScale = 0;
  for (let i = 0; i < tn; i++) lapScale = Math.max(lapScale, Math.abs(lap[i]));
  lapScale = lapScale * 0.3 || 1;

  // Accumulation before melt, with forest and wind (mass kept over the domain).
  const acc = new Float32Array(tn);
  const tWindMul = new Float32Array(tn);
  let accBefore = 0, accAfter = 0;
  for (let i = 0; i < tn; i++) {
    const base = (tFlat[i] + meltFlat[i]) * (1 - 0.35 * tCanopy[i]);
    accBefore += base;
    const windMul = Math.max(0.15, Math.min(2.4, 1 + spec.truthWindPerDeg * sx[i] - 0.35 * Math.max(-1, Math.min(1, lap[i] / lapScale))));
    acc[i] = base * windMul;
    tWindMul[i] = windMul;
    accAfter += acc[i];
  }
  const renorm = accAfter > 0 ? accBefore / accAfter : 1;
  for (let i = 0; i < tn; i++) acc[i] *= renorm;

  // Gravity: exponential holding depth, multiple-flow-direction routing on the
  // depression-filled DEM (priority flood with ε, Barnes et al. 2014) so a
  // release always runs out downhill; deposits cap at 6 m per cell (the excess
  // runs on); deposits spread laterally.
  const beforeGravity = new Float32Array(acc);
  const routeZ = fillDepressions(tz, TN, TN);
  const order = Array.from({ length: tn }, (_, i) => i).sort((a, b) => routeZ[b] - routeZ[a]);
  for (const i of order) {
    const sl = slope[i];
    const hold = sl < 28 ? 600 : Math.max(5, 20 * Math.exp(-0.065 * sl) * 100);
    if (acc[i] <= hold) continue;
    const x = i % TN;
    const y = (i - x) / TN;
    // Multiple flow directions, weights ∝ (drop/dist)^4 (concentrated, not a single line).
    let wsum = 0;
    const wts: number[] = [];
    const tgt: number[] = [];
    for (let dy = -1; dy <= 1; dy++) {
      for (let dx = -1; dx <= 1; dx++) {
        if (!dx && !dy) continue;
        const xx = x + dx, yy = y + dy;
        if (xx < 0 || yy < 0 || xx >= TN || yy >= TN) continue;
        const drop = (routeZ[i] - routeZ[yy * TN + xx]) / Math.hypot(dx, dy);
        if (drop <= 0) continue;
        const wgt = drop ** 4;
        wts.push(wgt); tgt.push(yy * TN + xx); wsum += wgt;
      }
    }
    const excess = acc[i] - hold;
    for (let k = 0; k < tgt.length; k++) acc[tgt[k]] += (excess * wts[k]) / wsum;
    acc[i] = hold;
  }
  {
    const change = new Float32Array(tn);
    for (let i = 0; i < tn; i++) change[i] = acc[i] - beforeGravity[i];
    const spread = blur(blur(change, TN, TN, 2), TN, TN, 2);
    for (let i = 0; i < tn; i++) acc[i] = Math.max(0, beforeGravity[i] + spread[i]);
  }
  const tGravity = new Float32Array(tn);
  for (let i = 0; i < tn; i++) tGravity[i] = acc[i] - beforeGravity[i];
  const tMeltF = new Float32Array(tn);
  const tNoise = new Float32Array(tn);

  // Melt by exposure (strength by month, northern hemisphere), correlated noise.
  const seasonRad = [0.2, 0.35, 0.6, 0.85, 1, 1, 1, 1, 1, 0.3, 0.2, 0.15][new Date(analysisMs).getUTCMonth()];
  const tTruth = new Float32Array(tn);
  for (let j = 0; j < TN; j++) {
    for (let i = 0; i < TN; i++) {
      const idx = j * TN + i;
      const southness = -Math.cos(aspect[idx] * DEG);
      const f = Math.max(0.1, 1 + 0.9 * seasonRad * Math.sin(slope[idx] * DEG) * southness) * (1 - 0.5 * tCanopy[idx]);
      const x = tox + i * sceneCell;
      const y = toy + j * sceneCell;
      const noise = Math.exp(spec.noiseSigma * 2.2 * snowNoise.fbm(x / 25, y / 25, 3));
      tTruth[idx] = Math.max(0, acc[idx] - meltFlat[idx] * f) * noise;
      tMeltF[idx] = f;
      tNoise[idx] = noise;
    }
  }
  const truth = crop(tTruth);
  const truthFlat = crop(tFlat);
  const canopy = crop(tCanopy);

  // ---- Geography ---------------------------------------------------------------
  const centerLon = 6.9;
  const centerLat = 45.95;
  const mPerDegLon = 111_320 * Math.cos(centerLat * DEG);
  const toLon = (x: number) => centerLon + (x - cx) / mPerDegLon;
  const toLat = (y: number) => centerLat + (y - cy) / M_PER_DEG_LAT;
  const corners: SnowEngineInput['geo']['corners'] = [
    { lon: toLon(ox), lat: toLat(oy) },
    { lon: toLon(ox + SCENE_SIZE_M), lat: toLat(oy) },
    { lon: toLon(ox + SCENE_SIZE_M), lat: toLat(oy + SCENE_SIZE_M) },
    { lon: toLon(ox), lat: toLat(oy + SCENE_SIZE_M) },
  ];

  // ---- "AROME": flat reference snowpack at a smoothed model orography ------
  const dLon = 0.01, dLat = 0.01;
  const lonMin = Math.ceil(toLon(-half + 1500) / dLon) * dLon;
  const lonMax = Math.floor(toLon(half - 1500) / dLon) * dLon;
  const latMin = Math.ceil(toLat(-half + 1500) / dLat) * dLat;
  const latMax = Math.floor(toLat(half - 1500) / dLat) * dLat;
  const aw = Math.round((lonMax - lonMin) / dLon) + 1;
  const ah = Math.round((latMax - latMin) / dLat) + 1;
  const smoothFar = blur(far, farN, farN, 11);
  const oro = new Float32Array(aw * ah);
  const aromeHs = new Float32Array(aw * ah);
  const tempShiftM = spec.aromeTempBiasC / 0.006;
  for (let j = 0; j < ah; j++) {
    for (let i = 0; i < aw; i++) {
      const lon = lonMin + i * dLon;
      const lat = latMin + j * dLat;
      const x = cx + (lon - centerLon) * mPerDegLon;
      const y = cy + (lat - centerLat) * M_PER_DEG_LAT;
      const z = sampleBilinear(smoothFar, farN, farN, (x + half) / FAR_CELL, (y + half) / FAR_CELL);
      oro[j * aw + i] = z;
      const a = anomaly(x, y) * (1 + spec.aromePrecipBias);
      aromeHs[j * aw + i] = Math.max(0, table.depthAt(z - tempShiftM, a) * (1 + 0.05 * rng.normal()));
    }
  }
  const coarse: CoarseSnowGrid = {
    source: 'arome',
    width: aw,
    height: ah,
    lonMin,
    latMin,
    dLon,
    dLat,
    hsCm: aromeHs,
    orographyM: Float32Array.from(oro, (v) => v + spec.orographyNoiseM * rng.normal()),
    resolutionM: 1100,
  };

  // ---- Far DEM handed to the engine: ±7 km around the scene -------------------
  const farHalf = 7000;
  const fw = Math.round((2 * farHalf + SCENE_SIZE_M) / FAR_CELL) + 1;
  const farData = new Float32Array(fw * fw);
  const fox = -farHalf;
  for (let j = 0; j < fw; j++) {
    for (let i = 0; i < fw; i++) {
      const x = ox + fox + i * FAR_CELL;
      const y = oy + fox + j * FAR_CELL;
      farData[j * fw + i] = sampleBilinear(far, farN, farN, (x + half) / FAR_CELL, (y + half) / FAR_CELL);
    }
  }
  const farDem: FarDem = { data: farData, width: fw, height: fw, originX: fox, originY: fox, cell: FAR_CELL };

  // ---- Stations on flat open ground within 35 km --------------------------------
  const observations: SnowObservation[] = [];
  let tries = 0;
  while (observations.length < spec.stationCount && tries < 20000) {
    tries++;
    const x = cx + (rng.next() * 2 - 1) * 20000;
    const y = cy + (rng.next() * 2 - 1) * 20000;
    if (Math.abs(x) > half - 300 || Math.abs(y) > half - 300) continue;
    const fx = (x + half) / FAR_CELL;
    const fy = (y + half) / FAR_CELL;
    const z = sampleBilinear(far, farN, farN, fx, fy);
    if (z < 1100 || z > 2900) continue;
    const zx = sampleBilinear(far, farN, farN, fx + 1, fy) - sampleBilinear(far, farN, farN, fx - 1, fy);
    const zy = sampleBilinear(far, farN, farN, fx, fy + 1) - sampleBilinear(far, farN, farN, fx, fy - 1);
    if (Math.atan(Math.hypot(zx, zy) / (2 * FAR_CELL)) / DEG > 10) continue;
    const value = Math.max(0, table.depthAt(z, anomaly(x, y)) + 3 * rng.normal());
    observations.push({
      id: `st${observations.length + 1}`,
      source: 'synthetic',
      name: `Station ${observations.length + 1}`,
      lon: toLon(x),
      lat: toLat(y),
      elevationM: Math.round(z),
      hsCm: Math.round(value),
      kind: 'flat',
    });
  }

  // ---- BRA: north / south 30° slopes of the massif at three altitudes -----------
  let bra: BraSnowProfile | null = null;
  if (spec.braNoiseCm != null) {
    const levels = [1500, 2000, 2500].map((alt) => {
      const flatV = table.depthAt(alt, 1);
      const meltV = table.meltAt(alt, 1);
      const north = Math.max(0, flatV + meltV * (1 - Math.max(0.1, 1 - 0.9 * seasonRad * 0.5)));
      const south = Math.max(0, flatV + meltV * (1 - Math.max(0.1, 1 + 0.9 * seasonRad * 0.5)));
      return {
        altitudeM: alt,
        northCm: Math.round(Math.max(0, north + (spec.braNoiseCm as number) * rng.normal()) / 5) * 5,
        southCm: Math.round(Math.max(0, south + (spec.braNoiseCm as number) * rng.normal()) / 5) * 5,
      };
    });
    bra = { massif: 'SYNTHETIQUE', date: spec.analysisIso, levels, limitNorthM: null, limitSouthM: null };
  }

  // ---- Weather handed to the engine: at 1500 m, perturbed -------------------------
  const weather: WeatherHistory = {
    startMs,
    elevationM: 1500,
    temperatureC: Float32Array.from(temp1500, (v) => v + spec.weatherNoiseC * rng.normal()),
    precipitationMm: Float32Array.from(precip, (v) => v * (0.85 + 0.3 * rng.next())),
    snowfallCm: snowfall,
    windSpeedMs: Float32Array.from(windMs, (v) => v * 0.9),
    windDirDeg: windDir,
  };

  const legacyBounds: [number, number, number, number] = [
    (lonMin - corners[0].lon) * mPerDegLon,
    (latMin - corners[0].lat) * M_PER_DEG_LAT,
    (lonMin + (aw - 1) * dLon - corners[0].lon) * mPerDegLon,
    (latMin + (ah - 1) * dLat - corners[0].lat) * M_PER_DEG_LAT,
  ];

  return {
    spec,
    input: {
      dem: { data: sceneZ, width: SCENE_N, height: SCENE_N, sizeX: SCENE_SIZE_M, sizeY: SCENE_SIZE_M },
      geo: { corners, gridNorthBearingDeg: 0 },
      coarse,
      farDem,
      canopy: spec.forest ? { data: canopy, width: SCENE_N, height: SCENE_N } : null,
      observations,
      bra,
      weather,
      analysisTimeMs: analysisMs,
      config: { ...DEFAULT_SNOW_ENGINE_CONFIG, maxResolution: SCENE_N },
    },
    truth,
    truthFlat,
    sceneW: SCENE_N,
    sceneH: SCENE_N,
    sceneCell,
    sceneZ,
    canopy,
    legacy: { aromeData: aromeHs, aromeW: aw, aromeH: ah, aromeBounds: legacyBounds },
    centerLon,
    centerLat,
    parts: { windMul: crop(tWindMul), gravityChange: crop(tGravity), meltFactor: crop(tMeltF), noise: crop(tNoise) },
  };
}

export const DAY = DAY_MS;
