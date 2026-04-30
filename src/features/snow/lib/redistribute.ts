// ============================================================================
// Snow redistribution — TypeScript port of RedView v0.1
// ----------------------------------------------------------------------------
// Source : crates/redview-scene/src/terrain/processing/snow/{mod, terrain_analysis,
//          flow, corrections, outliers, phases, postprocess, sampling}.rs
//
// Modèle physique (références) :
//   - López-Moreno & Nogués-Bravo (2006) : régression terrain GAM
//   - Bernhardt & Schulz (2010) : SnowSlide gravitational transport
//   - Tarboton (1997) : D-infinity flow routing
//   - Winstral et al. (2002) : indice d'abri Sx
//   - Liston & Elder (2006) : SnowModel (gradient + curvature)
//
// 7 phases :
//   A. Analyse terrain (slope/aspect/TPI/curvatures/TRI/Sx/D-inf/solar/cold-pool)
//   B. Régression terrain (facteurs multiplicatifs sur AROME upsamplé)
//   C. Transport gravitationnel itératif (D-inf SnowSlide)
//   D. Transport éolien (Winstral Sx, mass-conserving)
//   E. Sublimation des positions exposées
//   F. Cliff mask + smoothing gaussien
//   G. Conservation de masse adaptive
// ============================================================================

import type { SnowRedistributionConfig } from './config';
import type { SnowProgress } from '../types';
import {
  computeDinfFlow,
  computeElevationFactor,
  computeFlowAccumulationDinf,
  computePlanCurvature,
  computeProfileCurvature,
  computeRobustScale,
  computeShelterIndexMulti,
  computeSlopeAndAspect,
  computeTpi,
  computeTri,
  downsampleBox,
  gaussianSmoothLight,
  upsampleBilinear,
} from './redistributeTerrainMath';

const RAD = Math.PI / 180;

// ============================================================================
//  L O C A L   O U T L I E R   C A P
// ============================================================================

function capLocalOutliers(snow: Float32Array, w: number, h: number, ps: number, radiusM: number, maxRatio: number) {
  const radiusPx = Math.max(3, Math.round(radiusM / ps));
  const total = w * h;
  const sat = new Float64Array(total);
  for (let y = 0; y < h; y++) {
    let row = 0;
    for (let x = 0; x < w; x++) {
      row += snow[y * w + x];
      sat[y * w + x] = row + (y > 0 ? sat[(y - 1) * w + x] : 0);
    }
  }
  const cntSat = new Float64Array(total);
  for (let y = 0; y < h; y++) {
    let row = 0;
    for (let x = 0; x < w; x++) {
      row += snow[y * w + x] > 0.5 ? 1 : 0;
      cntSat[y * w + x] = row + (y > 0 ? cntSat[(y - 1) * w + x] : 0);
    }
  }
  const capped = new Float32Array(snow);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const idx = y * w + x;
      if (snow[idx] < 1) continue;
      const y0 = Math.max(0, y - radiusPx);
      const y1 = Math.min(h - 1, y + radiusPx);
      const x0 = Math.max(0, x - radiusPx);
      const x1 = Math.min(w - 1, x + radiusPx);
      const s11 = sat[y1 * w + x1];
      const s01 = x0 > 0 ? sat[y1 * w + (x0 - 1)] : 0;
      const s10 = y0 > 0 ? sat[(y0 - 1) * w + x1] : 0;
      const s00 = (x0 > 0 && y0 > 0) ? sat[(y0 - 1) * w + (x0 - 1)] : 0;
      const boxSum = s11 - s01 - s10 + s00;
      const c11 = cntSat[y1 * w + x1];
      const c01 = x0 > 0 ? cntSat[y1 * w + (x0 - 1)] : 0;
      const c10 = y0 > 0 ? cntSat[(y0 - 1) * w + x1] : 0;
      const c00 = (x0 > 0 && y0 > 0) ? cntSat[(y0 - 1) * w + (x0 - 1)] : 0;
      const cnt = c11 - c01 - c10 + c00;
      const localMean = cnt > 4
        ? boxSum / cnt
        : boxSum / ((y1 - y0 + 1) * (x1 - x0 + 1));
      const cap = Math.max(5, localMean * maxRatio);
      if (snow[idx] > cap) capped[idx] = cap;
    }
  }
  snow.set(capped);
}

// ============================================================================
//  W I N D   T R A N S P O R T
// ============================================================================

function applyWindTransport(
  snow: Float32Array, shelter: Float32Array, sxScale: number,
  triNorm: Float32Array, profCurvNorm: Float32Array, tpiCombined: Float32Array,
  total: number, config: SnowRedistributionConfig,
) {
  if (config.windStrength <= 0.001) return;
  const remove = new Float32Array(total);
  const depositW = new Float32Array(total);
  for (let i = 0; i < total; i++) {
    if (snow[i] < 0.3) continue;
    const sx = sxScale > 0.01 ? shelter[i] / sxScale : 0;
    const roughProt = Math.max(0.4, Math.min(1, 1 - Math.min(1.5, triNorm[i]) * 0.3));
    if (sx > 0.1) {
      const erode = Math.min(snow[i] * 0.5, Math.min(2, sx) * config.windStrength * snow[i] * 0.25 * roughProt);
      remove[i] = erode;
    } else if (sx < -0.1) {
      let dw = Math.min(2, -sx) * config.windStrength * 0.20;
      if (profCurvNorm[i] < -0.3 && tpiCombined[i] < 0) {
        const drift = Math.min(1, -profCurvNorm[i] - 0.3) * 0.3;
        dw *= 1 + drift;
      }
      depositW[i] = dw;
    }
  }
  let totalErode = 0, totalDw = 0;
  for (let i = 0; i < total; i++) { totalErode += remove[i]; totalDw += depositW[i]; }
  if (totalDw > 0.01 && totalErode > 0.01) {
    const ratio = totalErode / totalDw;
    for (let i = 0; i < total; i++) {
      snow[i] = Math.max(0, snow[i] - remove[i] + depositW[i] * ratio);
    }
  } else {
    for (let i = 0; i < total; i++) snow[i] = Math.max(0, snow[i] - remove[i]);
  }
}

function applyExposedSublimation(snow: Float32Array, tpiCombined: Float32Array, profCurvNorm: Float32Array, total: number) {
  for (let i = 0; i < total; i++) {
    if (snow[i] < 1) continue;
    if (tpiCombined[i] > 0.5 && profCurvNorm[i] > 0.3) {
      const exposure = Math.min(1, (tpiCombined[i] - 0.5) * 0.8);
      const convexity = Math.min(1, (profCurvNorm[i] - 0.3) * 0.8);
      const loss = exposure * convexity * 0.15;
      snow[i] *= Math.max(0.5, 1 - loss);
    }
  }
}

function applyCliffAndSmoothing(
  snow: Float32Array, slopeDeg: Float32Array, tpiCombined: Float32Array, profCurvNorm: Float32Array,
  originalMean: number, w: number, h: number, config: SnowRedistributionConfig,
): Float32Array {
  const total = snow.length;
  const cliffMargin = 8.0;
  for (let i = 0; i < total; i++) {
    const s = slopeDeg[i];
    if (s > config.frictionAngleDeg + cliffMargin) snow[i] = 0;
    else if (s > config.frictionAngleDeg) {
      const t = (s - config.frictionAngleDeg) / cliffMargin;
      snow[i] *= Math.max(0, 1 - t * t);
    }
  }
  for (let i = 0; i < total; i++) {
    if (tpiCombined[i] > 0.6 && slopeDeg[i] > 25) {
      const ridgeKill = Math.min(1, (tpiCombined[i] - 0.6) * 1.5) * Math.min(1, (slopeDeg[i] - 25) / 30);
      const convexBoost = profCurvNorm[i] > 0.3 ? 1 + Math.min(1, profCurvNorm[i] - 0.3) * 0.3 : 1;
      snow[i] *= Math.max(0, 1 - ridgeKill * 0.7 * convexBoost);
    }
  }
  let result = snow;
  if (config.finalSmoothSigma > 0.3) {
    result = gaussianSmoothLight(snow, w, h, config.finalSmoothSigma);
  }
  const cap = Math.max(400, originalMean * 6);
  for (let i = 0; i < result.length; i++) {
    result[i] = Math.max(0, Math.min(cap, result[i]));
  }
  return result;
}

// ============================================================================
//  M A I N   P I P E L I N E
// ============================================================================

export interface RedistributeInput {
  aromeData: Float32Array;
  aromeW: number;
  aromeH: number;
  aromeBounds: [number, number, number, number];
  heightmap: Float32Array;
  terrainW: number;
  terrainH: number;
  terrainOrigin: [number, number];
  terrainSize: [number, number];
  config: SnowRedistributionConfig;
}

export interface RedistributeOutput {
  data: Float32Array;
  width: number;
  height: number;
  meanCm: number;
  maxCm: number;
  coveragePct: number;
}

export function computeSnowRedistribution(
  input: RedistributeInput,
  progress?: SnowProgress,
): RedistributeOutput {
  const { aromeData, aromeW, aromeH, aromeBounds, config } = input;
  const { heightmap, terrainW, terrainH, terrainOrigin, terrainSize } = input;
  const report = (p: number, l: string) => progress?.(p, l);

  // Prep: downsample heightmap si > maxResolution
  const maxRes = Math.max(64, config.maxResolution);
  let workHm: Float32Array;
  let workW: number, workH: number;
  if (terrainW > maxRes || terrainH > maxRes) {
    const scale = Math.min(1, maxRes / Math.max(terrainW, terrainH));
    const nw = Math.max(2, Math.round(terrainW * scale));
    const nh = Math.max(2, Math.round(terrainH * scale));
    workHm = downsampleBox(heightmap, terrainW, terrainH, nw, nh);
    workW = nw; workH = nh;
  } else {
    workHm = new Float32Array(heightmap);
    workW = terrainW; workH = terrainH;
  }

  const tw = workW, th = workH, total = tw * th;
  const pixelSize = (terrainSize[0] / workW + terrainSize[1] / workH) * 0.5;
  console.log(`[snow] work ${workW}×${workH}, AROME ${aromeW}×${aromeH}, px=${pixelSize.toFixed(1)}m`);

  // Phase A — Terrain analysis
  report(2, 'Pente & exposition');
  const { slope: slopeDeg, aspect: aspectDeg } = computeSlopeAndAspect(workHm, tw, th, pixelSize);

  report(7, 'TPI multi-échelle');
  const tpiSmall = computeTpi(workHm, tw, th, pixelSize, 25);
  const tpiMedium = computeTpi(workHm, tw, th, pixelSize, 100);
  const tpiLarge = computeTpi(workHm, tw, th, pixelSize, 300);
  const tpiCombined = new Float32Array(total);
  for (let i = 0; i < total; i++) {
    tpiCombined[i] = tpiSmall[i] * 0.25 + tpiMedium[i] * 0.45 + tpiLarge[i] * 0.30;
  }
  const tpiScale = computeRobustScale(tpiCombined, 0.02);
  if (tpiScale > 0.01) {
    for (let i = 0; i < total; i++) tpiCombined[i] = Math.max(-2.5, Math.min(2.5, tpiCombined[i] / tpiScale));
  }

  report(13, 'Courbures');
  const planCurv = computePlanCurvature(workHm, tw, th, pixelSize);
  const planScale = computeRobustScale(planCurv, 0.02);
  if (planScale > 0.001) for (let i = 0; i < total; i++) planCurv[i] = Math.max(-2.5, Math.min(2.5, planCurv[i] / planScale));

  const profCurv = computeProfileCurvature(workHm, tw, th, pixelSize);
  const profScale = computeRobustScale(profCurv, 0.02);
  if (profScale > 0.001) for (let i = 0; i < total; i++) profCurv[i] = Math.max(-2.5, Math.min(2.5, profCurv[i] / profScale));

  const triRaw = computeTri(workHm, tw, th);
  const triScale = computeRobustScale(triRaw, 0.05);
  if (triScale > 0.01) for (let i = 0; i < total; i++) triRaw[i] = Math.max(0, Math.min(3, triRaw[i] / triScale));

  report(17, 'Indice d\'abri (Sx)');
  const shelter = computeShelterIndexMulti(workHm, tw, th, pixelSize, config.windDirectionDeg);
  const sxScale = computeRobustScale(shelter, 0.05);

  report(20, 'Flow D-infinity');
  const dinfFlow = computeDinfFlow(workHm, tw, th, pixelSize);
  const flowAccum = computeFlowAccumulationDinf(dinfFlow, workHm);
  let maxAccum = 1;
  for (let i = 0; i < total; i++) if (flowAccum[i] > maxAccum) maxAccum = flowAccum[i];
  const flowNorm = new Float32Array(total);
  if (maxAccum > 1) {
    const logMax = Math.log(maxAccum);
    for (let i = 0; i < total; i++) {
      if (flowAccum[i] > 1) flowNorm[i] = Math.max(0, Math.min(1, Math.log(flowAccum[i]) / logMax));
    }
  }

  report(22, 'Correction altitude');
  const elevFactor = computeElevationFactor(
    workHm, tw, th, aromeData, aromeW, aromeH, aromeBounds,
    terrainOrigin, terrainSize, config.precipitationGradient,
  );

  report(24, 'Radiation solaire');
  const solarFactor = new Float32Array(total).fill(1);
  for (let i = 0; i < total; i++) {
    if (slopeDeg[i] > 2) {
      const aspRad = aspectDeg[i] * RAD;
      const slpRad = slopeDeg[i] * RAD;
      const cosAsp = Math.cos(aspRad);
      const slpEff = Math.min(0.8, Math.sin(slpRad));
      solarFactor[i] = Math.max(0.6, Math.min(1.4, 1 + config.solarRadiationStrength * cosAsp * slpEff));
    }
  }

  // Cold pool
  const coldPoolFactor = new Float32Array(total).fill(1);
  for (let i = 0; i < total; i++) {
    if (tpiCombined[i] < -0.3) {
      const depth = Math.min(2, -tpiCombined[i] - 0.3);
      const flat = Math.max(0, Math.min(1, 1 - slopeDeg[i] / 30));
      coldPoolFactor[i] = 1 + config.coldPoolStrength * depth * flat;
    }
  }

  // Phase B — Régression terrain (initial snow)
  report(28, 'Régression terrain');
  const snow = upsampleBilinear(aromeData, aromeW, aromeH, aromeBounds, tw, th, terrainOrigin, terrainSize);

  let originalTotal = 0;
  for (let i = 0; i < total; i++) originalTotal += snow[i];
  const originalMean = originalTotal / Math.max(1, total);

  const fricRad = config.frictionAngleDeg * RAD;
  const tanFric = Math.tan(fricRad);

  for (let i = 0; i < total; i++) {
    if (snow[i] < 0.01) continue;
    const fElev = elevFactor[i];

    let fSlope: number;
    if (slopeDeg[i] >= config.frictionAngleDeg + 10) {
      fSlope = 0.05;
    } else if (slopeDeg[i] >= config.frictionAngleDeg) {
      const t = (slopeDeg[i] - config.frictionAngleDeg) / 10;
      fSlope = Math.max(0.05, 1 - t * 0.95);
    } else if (slopeDeg[i] > 25) {
      const thr = slopeDeg[i] * RAD;
      const hRatio = Math.cos(thr) * Math.tan(fricRad - thr) / tanFric;
      fSlope = Math.max(0.3, Math.min(1, hRatio));
    } else {
      fSlope = 1;
    }

    const cv = planCurv[i];
    const fCurv = Math.max(0.5, Math.min(2, 1 + config.curvatureStrength * Math.max(-1.5, Math.min(1.5, -cv))));

    const pv = profCurv[i];
    let fProf = 1;
    if (slopeDeg[i] > 10) {
      const slpMod = Math.min(1, (slopeDeg[i] - 10) / 20);
      fProf = Math.max(0.6, Math.min(1.8, 1 + config.profileCurvatureStrength * Math.max(-1.5, Math.min(1.5, -pv)) * slpMod));
    }

    const tpiV = tpiCombined[i];
    const fTpi = Math.max(0.4, Math.min(2.5, 1 + config.tpiStrength * Math.max(-1.5, Math.min(1.5, -tpiV))));

    const fFlow = Math.max(1, Math.min(2, 1 + config.flowAccumulationStrength * Math.min(1, flowNorm[i])));

    const triV = triRaw[i];
    let fRough: number;
    if (triV < 1.5) {
      fRough = 1 + config.roughnessAnchoringStrength * Math.min(1.5, triV) * 0.5;
    } else {
      fRough = 1 + config.roughnessAnchoringStrength * Math.max(-0.3, 1.5 * 0.5 - (triV - 1.5) * 0.3);
    }
    fRough = Math.max(0.7, Math.min(1.5, fRough));

    const fCold = Math.max(1, Math.min(1.5, coldPoolFactor[i]));

    const combined = Math.max(0, Math.min(5, fElev * fSlope * fCurv * fProf * fTpi * fFlow * fRough * fCold));
    snow[i] *= combined;
  }
  // Solar
  for (let i = 0; i < total; i++) snow[i] *= solarFactor[i];

  // Pre-gravity normalization
  let postRegrTotal = 0;
  for (let i = 0; i < total; i++) postRegrTotal += snow[i];
  if (postRegrTotal > 0.1 && originalTotal > 0.1) {
    const ratio = originalTotal / postRegrTotal;
    if (ratio > 1.05 && ratio < 3.0) {
      for (let i = 0; i < total; i++) snow[i] *= ratio;
    }
  }

  // Phase C — Gravitational transport (D-inf SnowSlide)
  report(32, 'Transport gravitationnel');
  const holding = new Float32Array(total);
  for (let i = 0; i < total; i++) {
    const thr = slopeDeg[i] * RAD;
    if (slopeDeg[i] < config.frictionAngleDeg) {
      const base = config.holdingDepthRefCm * Math.cos(thr) * Math.tan(fricRad - thr);
      const roughBonus = 1 + config.roughnessAnchoringStrength * Math.min(1.5, triRaw[i]) * 0.3;
      const concBonus = profCurv[i] < -0.3 ? 1 + Math.min(1, -profCurv[i] - 0.3) * 0.15 : 1;
      holding[i] = base * roughBonus * concBonus;
    }
  }

  // Sort indices by elevation desc
  const sortedIdx = new Int32Array(total);
  for (let i = 0; i < total; i++) sortedIdx[i] = i;
  const sortedArr = Array.from(sortedIdx).sort((a, b) => workHm[b] - workHm[a]);

  const isBoundary = (idx: number) => {
    const x = idx % tw, y = (idx / tw) | 0;
    return x === 0 || x === tw - 1 || y === 0 || y === th - 1;
  };

  let boundaryLoss = 0;
  for (let it = 0; it < config.gravityIterations; it++) {
    let movedAny = false;
    let iterMoved = 0;

    for (const idx of sortedArr) {
      const excess = snow[idx] - holding[idx];
      if (excess <= 0.1) continue;
      const fl = dinfFlow[idx];
      if (fl) {
        const sendFrac = it < 3 ? 0.7 : 0.85;
        const send = excess * sendFrac;
        snow[idx] -= send;
        iterMoved += send;
        const t1b = isBoundary(fl.target1);
        const t2b = isBoundary(fl.target2);
        const toT1 = send * fl.prop1;
        const toT2 = send * (1 - fl.prop1);
        if (t1b) { snow[fl.target1] += toT1 * 0.5; boundaryLoss += toT1 * 0.5; }
        else snow[fl.target1] += toT1;
        if (fl.target1 !== fl.target2) {
          if (t2b) { snow[fl.target2] += toT2 * 0.5; boundaryLoss += toT2 * 0.5; }
          else snow[fl.target2] += toT2;
        } else {
          snow[fl.target1] += toT2;
        }
        movedAny = true;
      } else {
        const pitBonus = holding[idx] * 0.5;
        if (snow[idx] > holding[idx] + pitBonus) snow[idx] = holding[idx] + pitBonus;
      }
    }
    const iterCap = it < 5 ? Math.max(500, originalMean * 8) : Math.max(400, originalMean * 6);
    for (let i = 0; i < total; i++) snow[i] = Math.max(0, Math.min(iterCap, snow[i]));

    let curTotal = 0;
    for (let i = 0; i < total; i++) curTotal += snow[i];
    if (!movedAny || (curTotal > 0.1 && iterMoved / curTotal < 0.005)) {
      console.log(`[snow] gravity converged at iter ${it + 1}`);
      break;
    }
    report(32 + Math.round(33 * (it + 1) / config.gravityIterations), 'Transport gravitationnel');
  }

  // Phase C-bis — outliers SAT
  report(66, 'Suppression outliers');
  capLocalOutliers(snow, tw, th, pixelSize, 50, 2.5);
  capLocalOutliers(snow, tw, th, pixelSize, 200, 2.0);

  // Phase D — Wind transport
  report(70, 'Transport éolien');
  applyWindTransport(snow, shelter, sxScale, triRaw, profCurv, tpiCombined, total, config);

  // Phase E — Sublimation exposée
  report(75, 'Sublimation');
  applyExposedSublimation(snow, tpiCombined, profCurv, total);

  // Phase F — Cliff + smoothing
  report(82, 'Falaises & lissage');
  const finalSnow = applyCliffAndSmoothing(snow, slopeDeg, tpiCombined, profCurv, originalMean, tw, th, config);

  // Phase G — Mass conservation
  report(92, 'Conservation masse');
  let curTotal = 0;
  for (let i = 0; i < total; i++) curTotal += finalSnow[i];
  if (curTotal > 0.1 && originalTotal > 0.1) {
    let cliffPx = 0;
    for (let i = 0; i < total; i++) if (slopeDeg[i] > config.frictionAngleDeg) cliffPx++;
    const cliffFrac = cliffPx / total;
    const legitLoss = boundaryLoss + originalTotal * cliffFrac * 0.5;
    const target = Math.max(originalTotal * 0.5, originalTotal - legitLoss);
    const ratio = target / curTotal;
    const cr = Math.max(0.7, Math.min(1.8, ratio));
    if (Math.abs(cr - 1) > 0.01) {
      for (let i = 0; i < total; i++) finalSnow[i] *= cr;
    }
  }

  // Stats
  let sum = 0, max = 0, validCount = 0;
  for (let i = 0; i < total; i++) {
    if (finalSnow[i] > 0.5) { sum += finalSnow[i]; validCount++; if (finalSnow[i] > max) max = finalSnow[i]; }
  }
  const mean = validCount > 0 ? sum / validCount : 0;
  const coverage = (validCount / total) * 100;
  console.log(`[snow] done: avg=${mean.toFixed(0)}cm max=${max.toFixed(0)}cm cov=${coverage.toFixed(1)}%`);

  report(100, 'Terminé');
  return { data: finalSnow, width: tw, height: th, meanCm: mean, maxCm: max, coveragePct: coverage };
}
