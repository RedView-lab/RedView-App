// ============================================================================
// Snow engine v2 — orchestration
// ----------------------------------------------------------------------------
//  A. Terrain analysis of the scene DTM (work grid).
//  B. Flat open-terrain depth: elevation profile learnt from the coarse cells
//     against their model orography, read at every pixel's altitude, plus the
//     smooth residual of the cells.
//  C. Measurements: elevation-dependent bias + optimal interpolation of the
//     flat-field stations (and the avalanche bulletin's levels).
//  D. Accumulation = flat depth + what has melted on the flat so far, reduced
//     under the canopy, redistributed by the wind (drift flux divergence) and
//     by gravity (SnowSlide).
//  E. Melt by exposure (shaded potential radiation × degree-days).
//  F. The wind amplitude, the least constrained quantity, is set between its
//     physical estimate ×0.4 and ×2.5 so the scene's σ(HS) matches Helbig et
//     al. (2015); then light smoothing and in-scene point measurements.
// ============================================================================

import { analyseLargeScale, assimilatePoints, oiIncrementAt, type PointSample, type StationSample } from './assimilation';
import {
  ResidualInterpolator,
  computeResiduals,
  fitElevationProfile,
  flatDepth,
  profileGradientCmPer100m,
  profileSnowline,
} from './elevationProfile';
import { snowSlide } from './gravity';
import { SceneFrame, buildWorkGrid, nodeLonLat, resampleNodeGrid, sampleBilinear } from './grid';
import { buildMeltModel } from './melt';
import { computeHorizons, surfaceGeometry, upsampleToWork } from './radiation';
import { AltitudeSampler, gaussianSmooth, helbigSigmaM, helbigTerrain, terrainGradients } from './terrain';
import type { CoarseSnowGrid, EngineProgress, SnowDiagnostics, SnowEngineInput, SnowEngineResult } from './types';
import { bulkDensity, computeWindRose, defaultWindRose, runBandSnowModel } from './weatherHistory';
import { applyWind, computeWindPattern } from './wind';

const now = () => (typeof performance !== 'undefined' ? performance.now() : Date.now());

function smoothstep(e0: number, e1: number, x: number): number {
  const t = Math.max(0, Math.min(1, (x - e0) / (e1 - e0)));
  return t * t * (3 - 2 * t);
}

/** Mean scene altitude of the nodes falling in each coarse cell (NaN where none). */
function orographyFromScene(coarse: CoarseSnowGrid, z: Float32Array, lon: Float64Array, lat: Float64Array): Float32Array {
  const nCells = coarse.width * coarse.height;
  const sum = new Float64Array(nCells);
  const count = new Uint32Array(nCells);
  for (let i = 0; i < z.length; i++) {
    const ci = Math.round((lon[i] - coarse.lonMin) / coarse.dLon);
    const cj = Math.round((lat[i] - coarse.latMin) / coarse.dLat);
    if (ci < 0 || cj < 0 || ci >= coarse.width || cj >= coarse.height) continue;
    sum[cj * coarse.width + ci] += z[i];
    count[cj * coarse.width + ci]++;
  }
  const out = new Float32Array(nCells).fill(Number.NaN);
  for (let c = 0; c < nCells; c++) if (count[c] > 20) out[c] = sum[c] / count[c];
  return out;
}

function emptyResult(w: number, h: number, pixelM: number, coarse: CoarseSnowGrid, timings: Record<string, number>): SnowEngineResult {
  const diagnostics: SnowDiagnostics = {
    workGrid: { width: w, height: h, pixelM },
    coarseSource: coarse.source,
    profile: { altitudesM: [], hsCm: [], cellsUsed: 0, gradientCmPer100m: 0, snowlineM: null, orography: coarse.orographyM ? 'model' : 'scene-dtm' },
    assimilation: { stations: [], profileCorrectionCm: 0, precipitationFactor: 1, snowlineShiftM: 0, braUsed: false, pointsUsed: 0 },
    wind: { source: 'default', rose: [], fluxCmM: 0, redistributedPct: 0 },
    gravity: { movedPct: 0 },
    melt: { source: 'season', flatMeltCm: 0, radiationScale: 1, braCalibrated: false },
    forest: { meanCanopyPct: null },
    variability: { targetSigmaCm: 0, modelSigmaCm: 0 },
    timingsMs: timings,
  };
  return { hsCm: new Float32Array(w * h), width: w, height: h, stats: { meanCm: 0, maxCm: 0, coveragePct: 0 }, diagnostics };
}

export function computeSnowDistribution(input: SnowEngineInput, progress?: EngineProgress): SnowEngineResult {
  const { config, coarse } = input;
  const timings: Record<string, number> = {};
  let t0 = now();
  const mark = (name: string) => {
    const t = now();
    timings[name] = Math.round(t - t0);
    t0 = t;
  };
  const report = (pct: number, label: string) => progress?.(pct, label);

  // ---- A. Terrain ---------------------------------------------------------
  report(2, 'Analyse du terrain');
  const grid = buildWorkGrid(input.dem, config.maxResolution);
  const frame = new SceneFrame(input.geo);
  const { width: w, height: h } = grid;
  const n = w * h;
  const terrain = terrainGradients(grid);
  const aspectTrue = new Float32Array(n);
  for (let i = 0; i < n; i++) aspectTrue[i] = (terrain.aspectGridDeg[i] + frame.gridNorthBearingDeg + 360) % 360;
  const sampler = new AltitudeSampler(grid, input.farDem);
  const { lon, lat } = nodeLonLat(frame, w, h);
  let zMinScene = Infinity, zMaxScene = -Infinity, zSum = 0;
  for (let i = 0; i < n; i++) {
    const z = grid.z[i];
    if (z < zMinScene) zMinScene = z;
    if (z > zMaxScene) zMaxScene = z;
    zSum += z;
  }
  const zMean = zSum / n;
  mark('terrain');

  const anySnow = coarse.hsCm.some((v) => v > 0.5)
    || input.observations.some((o) => o.hsCm > 0.5)
    || (input.bra?.levels.some((l) => l.northCm > 0 || l.southCm > 0) ?? false);
  if (!anySnow) return emptyResult(w, h, grid.ps, coarse, timings);

  // ---- B. Elevation profile and flat field -------------------------------
  report(8, 'Profil altitudinal');
  let orography = coarse.orographyM;
  let orographySource: 'model' | 'scene-dtm' = 'model';
  if (!orography) {
    orography = orographyFromScene(coarse, grid.z, lon, lat);
    orographySource = 'scene-dtm';
  }
  const stationObs = input.observations.filter((o) => o.kind === 'flat'
    && Number.isFinite(o.hsCm) && o.hsCm >= 0
    && o.elevationM != null && Number.isFinite(o.elevationM)
    && frame.distanceKm(o.lon, o.lat) <= config.stationRadiusKm);
  const altitudes = [zMinScene, zMaxScene, ...stationObs.map((o) => o.elevationM as number), ...(input.bra?.levels.map((l) => l.altitudeM) ?? [])];
  for (let c = 0; c < orography.length; c++) if (Number.isFinite(orography[c])) altitudes.push(orography[c]);
  const zLo = Math.min(...altitudes) - 300;
  const zHi = Math.max(...altitudes) + 300;
  const profile = fitElevationProfile(coarse, orography, orographySource, frame, zLo, zHi, config);
  const residuals = computeResiduals(coarse, orography, profile, config);
  const interp = new ResidualInterpolator(coarse, residuals, frame.center.lat);
  const eps = config.residualEpsilonCm;
  const flatBackground = (lo: number, la: number, z: number) => flatDepth(profile, z, interp.at(lo, la), eps);

  // Residual of the coarse cells on a lattice of every 8th node, then bilinear.
  const step = 8;
  const lw = Math.ceil((w - 1) / step) + 1;
  const lh = Math.ceil((h - 1) / step) + 1;
  const latLnR = new Float32Array(lw * lh);
  const latShift = new Float32Array(lw * lh);
  const latRw = new Float32Array(lw * lh);
  for (let j = 0; j < lh; j++) {
    for (let i = 0; i < lw; i++) {
      const node = Math.min(h - 1, j * step) * w + Math.min(w - 1, i * step);
      const r = interp.at(lon[node], lat[node]);
      latLnR[j * lw + i] = r.lnRatio;
      latShift[j * lw + i] = r.shiftM;
      latRw[j * lw + i] = r.ratioWeight;
    }
  }
  const latticeCoord = (v: number, size: number, cells: number) => {
    const i = Math.min(cells - 2, Math.floor(v / step));
    const p0 = i * step;
    const p1 = Math.min(size - 1, (i + 1) * step);
    return i + (p1 > p0 ? (v - p0) / (p1 - p0) : 0);
  };
  const nodeResidual = (x: number, y: number) => {
    const fx = lw > 1 ? latticeCoord(x, w, lw) : 0;
    const fy = lh > 1 ? latticeCoord(y, h, lh) : 0;
    return {
      lnRatio: sampleBilinear(latLnR, lw, lh, fx, fy),
      shiftM: sampleBilinear(latShift, lw, lh, fx, fy),
      ratioWeight: sampleBilinear(latRw, lw, lh, fx, fy),
    };
  };
  mark('profile');

  // ---- C. Measurements ----------------------------------------------------
  report(14, 'Assimilation des mesures');
  const stations: StationSample[] = stationObs.map((o) => {
    const p = frame.toLocal(o.lon, o.lat);
    return { obs: o, e: p.e, n: p.n, z: o.elevationM as number, distanceKm: frame.distanceKm(o.lon, o.lat) };
  });
  const large = analyseLargeScale({
    stations,
    bra: input.bra,
    stationBackground: (st, shiftM) => flatBackground(st.obs.lon, st.obs.lat, st.z + shiftM),
    centerBackground: (z) => flatBackground(frame.center.lon, frame.center.lat, z),
    config,
  });
  const corr = large.correction;
  const flat = new Float32Array(n);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const i = y * w + x;
      flat[i] = corr.ratio * flatDepth(profile, grid.z[i] + corr.shiftM, nodeResidual(x, y), eps);
    }
  }
  if (large.used.length > 0) {
    for (let i = 0; i < n; i++) {
      const p = frame.toLocal(lon[i], lat[i]);
      flat[i] = Math.max(0, flat[i] + oiIncrementAt(large, p.e, p.n, grid.z[i], flat[i], config));
    }
  }
  mark('assimilation');

  // ---- Weather history ----------------------------------------------------
  report(20, 'Historique météo');
  const rho = bulkDensity(input.analysisTimeMs, frame.center.lat);
  let flatMeanCm = 0;
  for (let i = 0; i < n; i++) flatMeanCm += flat[i];
  flatMeanCm /= n;
  const bandLo = Math.floor((Math.min(zMinScene, ...(input.bra?.levels.map((l) => l.altitudeM) ?? [])) - 300) / 100) * 100;
  const bandHi = Math.ceil((Math.max(zMaxScene, ...(input.bra?.levels.map((l) => l.altitudeM) ?? [])) + 300) / 100) * 100;
  const bands: number[] = [];
  for (let z = bandLo; z <= bandHi; z += 100) bands.push(z);
  const band = input.weather ? runBandSnowModel(input.weather, bands, frame.center.lat, frame.center.lon, input.analysisTimeMs, config) : null;
  let rose = input.weather ? computeWindRose(input.weather, zMean, input.analysisTimeMs, config, (flatMeanCm * rho) / 200) : null;
  let windTransport = 0;
  let windSource: 'history' | 'default';
  if (rose && rose.transport > 0) {
    windSource = 'history';
    windTransport = rose.transport;
  } else {
    windSource = 'default';
    rose = defaultWindRose(config.defaultWindFromDeg);
  }
  // A calm history (no transport hour): only the drifts of earlier storms.
  const calmHistory = input.weather != null && windSource === 'default';
  mark('weather');

  // ---- E (prep). Horizons and melt model ---------------------------------
  report(26, 'Horizons et rayonnement');
  const reduce = w > 900 ? 3 : w > 400 ? 2 : 1;
  const azimuths = Array.from({ length: 24 }, (_, k) => k * 15);
  const farExtent = input.farDem ? Math.max(input.farDem.width, input.farDem.height) * input.farDem.cell : 0;
  const maxHorizon = Math.max(Math.hypot(grid.sizeX, grid.sizeY), Math.min(12_000, farExtent / 2));
  const horizons = computeHorizons(grid, sampler, frame.gridNorthBearingDeg, azimuths, 15, maxHorizon, reduce);
  const reducedGrid = {
    width: horizons.width, height: horizons.height,
    dx: grid.sizeX / (horizons.width - 1), dy: grid.sizeY / (horizons.height - 1),
    ps: (grid.sizeX / (horizons.width - 1) + grid.sizeY / (horizons.height - 1)) / 2,
    sizeX: grid.sizeX, sizeY: grid.sizeY,
    z: resampleNodeGrid(grid.z, w, h, horizons.width, horizons.height),
  };
  const reducedTerrain = terrainGradients(reducedGrid);
  const reducedAspect = new Float32Array(reducedTerrain.aspectGridDeg.length);
  for (let i = 0; i < reducedAspect.length; i++) reducedAspect[i] = (reducedTerrain.aspectGridDeg[i] + frame.gridNorthBearingDeg + 360) % 360;
  const melt = buildMeltModel({
    horizons,
    geometry: surfaceGeometry(reducedTerrain.slopeDeg, reducedAspect, reducedGrid.z),
    altitude: reducedGrid.z,
    frame,
    band,
    profile,
    bra: input.bra,
    analysisTimeMs: input.analysisTimeMs,
    config,
  });
  const meltRatio = upsampleToWork(melt.ratio, melt.ratioWidth, melt.ratioHeight, w, h);
  mark('melt');

  // ---- Forest ---------------------------------------------------------------
  let canopy: Float32Array | null = null;
  let canopySum = 0;
  if (input.canopy) {
    const c = input.canopy;
    const raw = Float32Array.from(c.data, (v) => (Number.isFinite(v) ? Math.max(0, Math.min(1, v)) : 0));
    canopy = resampleNodeGrid(raw, c.width, c.height, w, h);
    for (let i = 0; i < n; i++) canopySum += canopy[i];
  }

  // ---- D. Wind pattern ------------------------------------------------------
  report(40, 'Transport éolien');
  const windPattern = computeWindPattern(grid, input.farDem, frame, rose, config);
  mark('wind');

  // ---- Accumulation, melt per node, evaluation -----------------------------
  const acc0 = new Float32Array(n);
  const meltNode = new Float32Array(n);
  const meltCache = new Map<number, number>();
  const flatMeltAt = (z: number) => {
    const key = Math.round(z / 10);
    let v = meltCache.get(key);
    if (v === undefined) { v = melt.flatMeltCm(key * 10); meltCache.set(key, v); }
    return v;
  };
  for (let i = 0; i < n; i++) {
    const fc = canopy ? canopy[i] : 0;
    const m = flatMeltAt(grid.z[i]);
    acc0[i] = (flat[i] + m) * (1 - config.forestAccumulationSlope * fc);
    meltNode[i] = m * meltRatio[i] * (1 - config.forestAblationSlope * fc);
  }
  const bra = input.bra;
  const taper = new Float32Array(n).fill(1);
  if (bra && (bra.limitNorthM != null || bra.limitSouthM != null)) {
    const limN = bra.limitNorthM ?? bra.limitSouthM as number;
    const limS = bra.limitSouthM ?? bra.limitNorthM as number;
    for (let i = 0; i < n; i++) {
      const northness = terrain.slopeDeg[i] > 5 ? Math.cos((aspectTrue[i] * Math.PI) / 180) : 0;
      const lim = limS + (limN - limS) * (1 + northness) / 2;
      taper[i] = smoothstep(lim - 400, lim, grid.z[i]);
    }
  }

  let windMoved = 0;
  let gravityMoved = 0;
  const evaluate = (q0: number, passes: number): Float32Array => {
    const a = new Float32Array(acc0);
    windMoved = applyWind(a, windPattern, q0, config);
    gravityMoved = snowSlide(a, grid, config, passes).moved;
    for (let i = 0; i < n; i++) a[i] = Math.max(0, a[i] - meltNode[i]) * taper[i];
    return a;
  };
  const stdOf = (a: Float32Array) => {
    let s = 0, s2 = 0;
    for (let i = 0; i < n; i++) { s += a[i]; s2 += a[i] * a[i]; }
    const m = s / n;
    return { mean: m, sigma: Math.sqrt(Math.max(0, s2 / n - m * m)) };
  };

  let accMean = 0;
  for (let i = 0; i < n; i++) accMean += acc0[i];
  accMean /= n;
  // Physical flat flux: from the transport potential of the history (an
  // absolute amount: the same storm moves a larger share of a thin pack),
  // capped by the snow available.
  let q0Phys = 0;
  if (windPattern.meanAbs > 1e-9) {
    const cap = (config.maxWindRedistribution * 2 * accMean) / windPattern.meanAbs;
    if (windSource === 'history') q0Phys = Math.min(cap, config.windFluxPerTransport * windTransport);
    else q0Phys = (config.defaultWindRedistribution * (calmHistory ? 0.3 : 1) * 2 * accMean) / windPattern.meanAbs;
  }

  // ---- F. Helbig's σ as a ceiling on the wind amplitude ----------------------
  // The drift pattern is the least certain part of the model: inflating it to
  // reach a target variance would add misplaced drifts (double penalty), so the
  // physical amplitude is only lowered, when the scene comes out more variable
  // than Helbig et al. (2015) allow for its terrain and mean depth.
  report(60, 'Calibration de la variabilité');
  const helbig = helbigTerrain(grid, terrain);
  const first = stdOf(evaluate(q0Phys, 2));
  const targetSigma = helbigSigmaM(first.mean / 100, helbig, config.helbigA, config.helbigB) * 100;
  let bestScale = 1;
  if (q0Phys > 0 && targetSigma > 0 && first.sigma > targetSigma) {
    let a = Math.log(config.windAmplitudeMin);
    let b = 0;
    if (stdOf(evaluate(q0Phys * config.windAmplitudeMin, 2)).sigma >= targetSigma) b = a;
    for (let it = 0; it < 6 && b - a > 1e-3; it++) {
      const mid = (a + b) / 2;
      if (stdOf(evaluate(q0Phys * Math.exp(mid), 2)).sigma > targetSigma) b = mid; else a = mid;
    }
    bestScale = Math.exp((a + b) / 2);
  }
  const q0 = q0Phys * bestScale;
  report(85, 'Redistribution finale');
  const raw = evaluate(q0, config.gravityPasses);
  mark('redistribution');

  // ---- Final smoothing, point measurements, cap ------------------------------
  const hs = config.finalSmoothSigmaPx > 0.3 ? gaussianSmooth(raw, w, h, config.finalSmoothSigmaPx) : raw;
  const points: PointSample[] = [];
  for (const o of input.observations) {
    if (o.kind !== 'point' || !Number.isFinite(o.hsCm) || o.hsCm < 0) continue;
    const uv = frame.sceneUvOf(o.lon, o.lat);
    if (uv.u < 0 || uv.v < 0 || uv.u > 1 || uv.v > 1) continue;
    points.push({ obs: o, fx: uv.u * (w - 1), fy: uv.v * (h - 1) });
  }
  const pointsUsed = assimilatePoints(hs, w, h, grid.ps, points, config);
  let sum = 0, max = 0, covered = 0;
  for (let i = 0; i < n; i++) {
    const v = Math.min(config.maxDepthCm, Math.max(0, hs[i]));
    hs[i] = v;
    if (v > 0.5) { sum += v; covered++; if (v > max) max = v; }
  }
  const finalStats = stdOf(hs);
  mark('final');
  report(100, 'Terminé');

  const profAlt: number[] = [];
  const profHs: number[] = [];
  for (let k = 0; k < profile.values.length; k += 5) {
    profAlt.push(profile.zMin + k * profile.step);
    profHs.push(Math.round(profile.values[k] * 10) / 10);
  }
  const diagnostics: SnowDiagnostics = {
    workGrid: { width: w, height: h, pixelM: grid.ps },
    coarseSource: coarse.source,
    profile: {
      altitudesM: profAlt,
      hsCm: profHs,
      cellsUsed: profile.cellsUsed,
      gradientCmPer100m: profileGradientCmPer100m(profile, zMean),
      snowlineM: profileSnowline(profile),
      orography: profile.orography,
    },
    assimilation: {
      stations: large.diagnostics,
      profileCorrectionCm: corr.ratio * flatBackground(frame.center.lon, frame.center.lat, zMean + corr.shiftM) - flatBackground(frame.center.lon, frame.center.lat, zMean),
      precipitationFactor: corr.ratio,
      snowlineShiftM: -corr.shiftM,
      braUsed: large.braUsed,
      pointsUsed,
    },
    wind: {
      source: windSource,
      rose: Array.from(rose.weights, (v) => Math.round(v * 1000) / 1000),
      fluxCmM: q0,
      redistributedPct: windMoved * 100,
    },
    gravity: { movedPct: gravityMoved * 100 },
    melt: {
      source: melt.source,
      flatMeltCm: melt.flatMeltCm(zMean),
      radiationScale: melt.radiationScale,
      braCalibrated: melt.braCalibrated,
    },
    forest: { meanCanopyPct: canopy ? (canopySum / n) * 100 : null },
    variability: { targetSigmaCm: targetSigma, modelSigmaCm: finalStats.sigma },
    timingsMs: timings,
  };
  return {
    hsCm: hs,
    width: w,
    height: h,
    stats: { meanCm: covered > 0 ? sum / covered : 0, maxCm: max, coveragePct: (covered / n) * 100 },
    diagnostics,
  };
}
