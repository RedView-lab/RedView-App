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

import type { SnowRedistributionConfig } from '../config';
import type { SnowProgress } from '../types';

// ============================================================================
//  S A M P L I N G
// ============================================================================

export function downsampleBox(
  src: Float32Array, srcW: number, srcH: number, dstW: number, dstH: number,
): Float32Array {
  const out = new Float32Array(dstW * dstH);
  const counts = new Uint32Array(dstW * dstH);
  const sx = srcW / dstW;
  const sy = srcH / dstH;
  for (let y = 0; y < srcH; y++) {
    const dy = Math.min(dstH - 1, (y / sy) | 0);
    for (let x = 0; x < srcW; x++) {
      const dx = Math.min(dstW - 1, (x / sx) | 0);
      const v = src[y * srcW + x];
      if (Number.isFinite(v)) {
        const di = dy * dstW + dx;
        out[di] += v;
        counts[di]++;
      }
    }
  }
  for (let i = 0; i < out.length; i++) {
    if (counts[i] > 0) out[i] /= counts[i];
  }
  return out;
}

/** Bilinear upsampling de la grille AROME → résolution terrain. */
export function upsampleBilinear(
  arome: Float32Array, aw: number, ah: number,
  aromeBounds: [number, number, number, number],
  tw: number, th: number,
  terrainOrigin: [number, number],
  terrainSize: [number, number],
): Float32Array {
  const out = new Float32Array(tw * th);
  const ax0 = aromeBounds[0], ay0 = aromeBounds[1];
  const arx = aromeBounds[2] - aromeBounds[0];
  const ary = aromeBounds[3] - aromeBounds[1];
  if (arx <= 0 || ary <= 0 || aw === 0 || ah === 0) return out;

  for (let ty = 0; ty < th; ty++) {
    for (let tx = 0; tx < tw; tx++) {
      const wx = terrainOrigin[0] + (tx + 0.5) / tw * terrainSize[0];
      const wy = terrainOrigin[1] + (ty + 0.5) / th * terrainSize[1];
      const au = (wx - ax0) / arx;
      const av = (wy - ay0) / ary;
      if (au < 0 || au > 1 || av < 0 || av > 1) continue;
      const axf = au * (aw - 1);
      const ayf = av * (ah - 1);
      const ax0i = Math.min(aw - 1, Math.floor(axf));
      const ax1i = Math.min(aw - 1, ax0i + 1);
      const ay0i = Math.min(ah - 1, Math.floor(ayf));
      const ay1i = Math.min(ah - 1, ay0i + 1);
      const fx = axf - Math.floor(axf);
      const fy = ayf - Math.floor(ayf);
      const v00 = arome[ay0i * aw + ax0i];
      const v10 = arome[ay0i * aw + ax1i];
      const v01 = arome[ay1i * aw + ax0i];
      const v11 = arome[ay1i * aw + ax1i];
      const top = v00 * (1 - fx) + v10 * fx;
      const bot = v01 * (1 - fx) + v11 * fx;
      out[ty * tw + tx] = Math.max(0, top * (1 - fy) + bot * fy);
    }
  }
  return out;
}

/** Lissage gaussien séparable (1D × 2). */
export function gaussianSmoothLight(
  data: Float32Array, w: number, h: number, sigma: number,
): Float32Array {
  if (sigma < 0.3) return new Float32Array(data);
  const radius = Math.ceil(sigma * 2.5);
  const ks = 2 * radius + 1;
  const kernel = new Float32Array(ks);
  const inv2s2 = 1 / (2 * sigma * sigma);
  let ksum = 0;
  for (let i = 0; i < ks; i++) {
    const d = i - radius;
    const k = Math.exp(-d * d * inv2s2);
    kernel[i] = k; ksum += k;
  }
  for (let i = 0; i < ks; i++) kernel[i] /= ksum;

  const tmp = new Float32Array(w * h);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      let s = 0, wt = 0;
      for (let ki = 0; ki < ks; ki++) {
        const sx = x + (ki - radius);
        if (sx >= 0 && sx < w) {
          s += data[y * w + sx] * kernel[ki];
          wt += kernel[ki];
        }
      }
      tmp[y * w + x] = wt > 0 ? s / wt : data[y * w + x];
    }
  }
  const out = new Float32Array(w * h);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      let s = 0, wt = 0;
      for (let ki = 0; ki < ks; ki++) {
        const sy = y + (ki - radius);
        if (sy >= 0 && sy < h) {
          s += tmp[sy * w + x] * kernel[ki];
          wt += kernel[ki];
        }
      }
      out[y * w + x] = wt > 0 ? s / wt : tmp[y * w + x];
    }
  }
  return out;
}

// ============================================================================
//  T E R R A I N   A N A L Y S I S
// ============================================================================

const DEG = 180 / Math.PI;
const RAD = Math.PI / 180;

function hornDerivatives(hm: Float32Array, w: number, h: number, ps: number) {
  const total = w * h;
  const dzdx = new Float32Array(total);
  const dzdy = new Float32Array(total);
  for (let y = 1; y < h - 1; y++) {
    for (let x = 1; x < w - 1; x++) {
      const idx = y * w + x;
      const z = (dx: number, dy: number) => hm[(y + dy) * w + (x + dx)];
      dzdx[idx] = (z(1, -1) + 2 * z(1, 0) + z(1, 1)
                 - z(-1, -1) - 2 * z(-1, 0) - z(-1, 1)) / (8 * ps);
      dzdy[idx] = (z(-1, 1) + 2 * z(0, 1) + z(1, 1)
                 - z(-1, -1) - 2 * z(0, -1) - z(1, -1)) / (8 * ps);
    }
  }
  // Bords
  for (let x = 0; x < w; x++) {
    dzdx[x] = dzdx[w + x];
    dzdx[(h - 1) * w + x] = dzdx[(h - 2) * w + x];
    dzdy[x] = dzdy[w + x];
    dzdy[(h - 1) * w + x] = dzdy[(h - 2) * w + x];
  }
  for (let y = 0; y < h; y++) {
    dzdx[y * w] = dzdx[y * w + 1];
    dzdx[y * w + w - 1] = dzdx[y * w + w - 2];
    dzdy[y * w] = dzdy[y * w + 1];
    dzdy[y * w + w - 1] = dzdy[y * w + w - 2];
  }
  return { dzdx, dzdy };
}

export function computeSlopeAndAspect(hm: Float32Array, w: number, h: number, ps: number) {
  const { dzdx, dzdy } = hornDerivatives(hm, w, h, ps);
  const total = w * h;
  const slope = new Float32Array(total);
  const aspect = new Float32Array(total);
  for (let i = 0; i < total; i++) {
    const gx = dzdx[i], gy = dzdy[i];
    const grad = Math.sqrt(gx * gx + gy * gy);
    slope[i] = Math.atan(grad) * DEG;
    if (grad > 0.001) {
      const rad = Math.atan2(-gy, -gx);
      let deg = 90 - rad * DEG;
      if (deg < 0) deg += 360;
      if (deg >= 360) deg -= 360;
      aspect[i] = deg;
    }
  }
  return { slope, aspect };
}

/** TPI multi-échelle via integral image (O(n)). */
export function computeTpi(hm: Float32Array, w: number, h: number, ps: number, radiusM: number): Float32Array {
  const total = w * h;
  const radiusPx = Math.max(2, Math.round(radiusM / ps));
  const sat = new Float64Array(total);
  for (let y = 0; y < h; y++) {
    let row = 0;
    for (let x = 0; x < w; x++) {
      row += hm[y * w + x];
      sat[y * w + x] = row + (y > 0 ? sat[(y - 1) * w + x] : 0);
    }
  }
  const tpi = new Float32Array(total);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const idx = y * w + x;
      const hc = hm[idx];
      const y0 = Math.max(0, y - radiusPx);
      const y1 = Math.min(h - 1, y + radiusPx);
      const x0 = Math.max(0, x - radiusPx);
      const x1 = Math.min(w - 1, x + radiusPx);
      const s11 = sat[y1 * w + x1];
      const s01 = x0 > 0 ? sat[y1 * w + (x0 - 1)] : 0;
      const s10 = y0 > 0 ? sat[(y0 - 1) * w + x1] : 0;
      const s00 = (x0 > 0 && y0 > 0) ? sat[(y0 - 1) * w + (x0 - 1)] : 0;
      const boxSum = s11 - s01 - s10 + s00;
      const count = (y1 - y0 + 1) * (x1 - x0 + 1);
      tpi[idx] = hc - boxSum / count;
    }
  }
  return tpi;
}

function evansYoung(hm: Float32Array, w: number, h: number, ps: number, profile: boolean): Float32Array {
  const total = w * h;
  const out = new Float32Array(total);
  const ps2 = ps * ps;
  for (let y = 1; y < h - 1; y++) {
    for (let x = 1; x < w - 1; x++) {
      const idx = y * w + x;
      const z = (dx: number, dy: number) => hm[(y + dy) * w + (x + dx)];
      const p = (z(1, -1) + 2 * z(1, 0) + z(1, 1) - z(-1, -1) - 2 * z(-1, 0) - z(-1, 1)) / (8 * ps);
      const q = (z(-1, 1) + 2 * z(0, 1) + z(1, 1) - z(-1, -1) - 2 * z(0, -1) - z(1, -1)) / (8 * ps);
      const r = (z(1, 0) - 2 * z(0, 0) + z(-1, 0)) / ps2;
      const s = (z(1, 1) - z(-1, 1) - z(1, -1) + z(-1, -1)) / (4 * ps2);
      const t = (z(0, 1) - 2 * z(0, 0) + z(0, -1)) / ps2;
      const p2q2 = p * p + q * q;
      if (p2q2 > 0.0001) {
        if (profile) {
          out[idx] = -(p * p * r + 2 * p * q * s + q * q * t) / (p2q2 * Math.pow(1 + p2q2, 1.5));
        } else {
          out[idx] = -(q * q * r - 2 * p * q * s + p * p * t) / (p2q2 * Math.sqrt(1 + p2q2));
        }
      }
    }
  }
  return out;
}

export const computePlanCurvature = (hm: Float32Array, w: number, h: number, ps: number) =>
  evansYoung(hm, w, h, ps, false);
export const computeProfileCurvature = (hm: Float32Array, w: number, h: number, ps: number) =>
  evansYoung(hm, w, h, ps, true);

export function computeTri(hm: Float32Array, w: number, h: number): Float32Array {
  const total = w * h;
  const tri = new Float32Array(total);
  for (let y = 1; y < h - 1; y++) {
    for (let x = 1; x < w - 1; x++) {
      const idx = y * w + x;
      const hc = hm[idx];
      let sumSq = 0;
      for (let dy = -1; dy <= 1; dy++) {
        for (let dx = -1; dx <= 1; dx++) {
          if (dx === 0 && dy === 0) continue;
          const d = hm[(y + dy) * w + (x + dx)] - hc;
          sumSq += d * d;
        }
      }
      tri[idx] = Math.sqrt(sumSq / 8);
    }
  }
  for (let x = 0; x < w; x++) {
    tri[x] = tri[w + x];
    tri[(h - 1) * w + x] = tri[(h - 2) * w + x];
  }
  for (let y = 0; y < h; y++) {
    tri[y * w] = tri[y * w + 1];
    tri[y * w + w - 1] = tri[y * w + w - 2];
  }
  return tri;
}

function shelterIndexSingle(hm: Float32Array, w: number, h: number, ps: number, windDirDeg: number): Float32Array {
  const total = w * h;
  const sx = new Float32Array(total);
  const upRad = (windDirDeg + 180) * RAD;
  const dx = Math.sin(upRad);
  const dy = -Math.cos(upRad);
  const maxSearchM = 300;
  const maxSearchPx = Math.min(100, Math.floor(maxSearchM / ps));
  const stepCount = Math.max(5, maxSearchPx);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const idx = y * w + x;
      const hc = hm[idx];
      let maxAngle = -90;
      for (let step = 1; step <= stepCount; step++) {
        const sxF = x + dx * step;
        const syF = y + dy * step;
        const ix = Math.round(sxF), iy = Math.round(syF);
        if (ix < 0 || ix >= w || iy < 0 || iy >= h) break;
        const hn = hm[iy * w + ix];
        const distM = step * ps;
        const ang = Math.atan((hn - hc) / distM) * DEG;
        if (ang > maxAngle) maxAngle = ang;
      }
      sx[idx] = -maxAngle;
    }
  }
  return sx;
}

export function computeShelterIndexMulti(hm: Float32Array, w: number, h: number, ps: number, windDirDeg: number): Float32Array {
  const dirs = [windDirDeg - 30, windDirDeg - 15, windDirDeg, windDirDeg + 15, windDirDeg + 30];
  const total = w * h;
  const out = new Float32Array(total);
  for (const d of dirs) {
    const sx = shelterIndexSingle(hm, w, h, ps, d);
    for (let i = 0; i < total; i++) out[i] += sx[i];
  }
  const inv = 1 / dirs.length;
  for (let i = 0; i < total; i++) out[i] *= inv;
  return out;
}

export function computeRobustScale(data: Float32Array, percentile: number): number {
  const abs: number[] = [];
  for (let i = 0; i < data.length; i++) {
    const v = data[i];
    if (Number.isFinite(v) && Math.abs(v) > 0.001) abs.push(Math.abs(v));
  }
  if (abs.length === 0) return 1;
  abs.sort((a, b) => a - b);
  const idx = Math.round((abs.length - 1) * (1 - percentile));
  return Math.max(0.01, abs[Math.min(abs.length - 1, idx)]);
}

// ============================================================================
//  D - I N F I N I T Y   F L O W   ( T a r b o t o n   1 9 9 7 )
// ============================================================================

interface DinfFlow {
  target1: number;
  target2: number;
  prop1: number;
}

const FACETS: Array<[number, number, number, number]> = [
  [1, 0, 1, -1], [0, -1, 1, -1], [0, -1, -1, -1], [-1, 0, -1, -1],
  [-1, 0, -1, 1], [0, 1, -1, 1], [0, 1, 1, 1], [1, 0, 1, 1],
];

export function computeDinfFlow(hm: Float32Array, w: number, h: number, ps: number): Array<DinfFlow | null> {
  const total = w * h;
  const out: Array<DinfFlow | null> = new Array(total).fill(null);
  const diag = ps * Math.SQRT2;
  const PI4 = Math.PI / 4;

  for (let y = 1; y < h - 1; y++) {
    for (let x = 1; x < w - 1; x++) {
      const idx = y * w + x;
      const h0 = hm[idx];
      let bestSlope = 0;
      let best: DinfFlow | null = null;

      for (const [dx1, dy1, dx2, dy2] of FACETS) {
        const nx1 = x + dx1, ny1 = y + dy1;
        const nx2 = x + dx2, ny2 = y + dy2;
        if (nx1 < 0 || nx1 >= w || ny1 < 0 || ny1 >= h) continue;
        if (nx2 < 0 || nx2 >= w || ny2 < 0 || ny2 >= h) continue;
        const idx1 = ny1 * w + nx1;
        const idx2 = ny2 * w + nx2;
        const h1 = hm[idx1], h2 = hm[idx2];
        const e1Card = dx1 === 0 || dy1 === 0;
        const d1 = e1Card ? ps : diag;
        const s1 = (h0 - h1) / d1;
        const s2 = (h1 - h2) / ps;
        const r = Math.atan2(s2, s1);
        let sEff: number, t1: number, t2: number, p1: number;
        if (r < 0) {
          if (s1 <= 0) continue;
          sEff = s1; t1 = idx1; t2 = idx1; p1 = 1;
        } else if (r > PI4) {
          const d2c = e1Card ? diag : ps;
          const sToE2 = (h0 - h2) / d2c;
          if (sToE2 <= 0) continue;
          sEff = sToE2; t1 = idx2; t2 = idx2; p1 = 1;
        } else {
          sEff = Math.sqrt(s1 * s1 + s2 * s2);
          if (sEff <= 0) continue;
          t1 = idx1; t2 = idx2; p1 = (PI4 - r) / PI4;
        }
        if (sEff > bestSlope) {
          bestSlope = sEff;
          best = { target1: t1, target2: t2, prop1: p1 };
        }
      }
      out[idx] = best;
    }
  }
  return out;
}

export function computeFlowAccumulationDinf(flow: Array<DinfFlow | null>, hm: Float32Array): Float32Array {
  const total = flow.length;
  const accum = new Float32Array(total).fill(1);
  const sorted = new Int32Array(total);
  for (let i = 0; i < total; i++) sorted[i] = i;
  // Sort descending by elevation
  const sortedArr = Array.from(sorted).sort((a, b) => hm[b] - hm[a]);
  for (const idx of sortedArr) {
    const f = flow[idx];
    if (f) {
      const area = accum[idx];
      accum[f.target1] += area * f.prop1;
      if (f.target1 !== f.target2) accum[f.target2] += area * (1 - f.prop1);
    }
  }
  return accum;
}

// ============================================================================
//  E L E V A T I O N   F A C T O R
// ============================================================================

export function computeElevationFactor(
  hm: Float32Array, w: number, h: number,
  arome: Float32Array, aw: number, ah: number,
  aromeBounds: [number, number, number, number],
  terrainOrigin: [number, number],
  terrainSize: [number, number],
  gradient: number,
): Float32Array {
  const total = w * h;
  const factor = new Float32Array(total).fill(1);
  const arx = aromeBounds[2] - aromeBounds[0];
  const ary = aromeBounds[3] - aromeBounds[1];
  if (arx <= 0 || ary <= 0) return factor;
  const nCells = aw * ah;
  if (nCells === 0 || arome.length < nCells) return factor;
  const clampLo = Math.max(0.5, 1 - 2 * gradient);
  const clampHi = 1 + 2 * gradient;

  // Step 1: cellId par pixel
  const cellId = new Int32Array(total).fill(-1);
  for (let ty = 0; ty < h; ty++) {
    for (let tx = 0; tx < w; tx++) {
      const wx = terrainOrigin[0] + (tx + 0.5) / w * terrainSize[0];
      const wy = terrainOrigin[1] + (ty + 0.5) / h * terrainSize[1];
      const au = Math.floor((wx - aromeBounds[0]) / arx * aw);
      const av = Math.floor((wy - aromeBounds[1]) / ary * ah);
      if (au >= 0 && au < aw && av >= 0 && av < ah) cellId[ty * w + tx] = av * aw + au;
    }
  }

  // Step 2: stats par cellule
  const cellSum = new Float64Array(nCells);
  const cellCount = new Uint32Array(nCells);
  for (let i = 0; i < total; i++) {
    const c = cellId[i];
    if (c >= 0) { cellSum[c] += hm[i]; cellCount[c]++; }
  }
  const cellMean = new Float32Array(nCells);
  for (let c = 0; c < nCells; c++) {
    if (cellCount[c] > 0) cellMean[c] = cellSum[c] / cellCount[c];
  }
  const cellVar = new Float64Array(nCells);
  for (let i = 0; i < total; i++) {
    const c = cellId[i];
    if (c >= 0) {
      const d = hm[i] - cellMean[c];
      cellVar[c] += d * d;
    }
  }
  const cellStd = new Float32Array(nCells);
  for (let c = 0; c < nCells; c++) {
    if (cellCount[c] > 1) cellStd[c] = Math.sqrt(cellVar[c] / cellCount[c]);
  }

  // Step 3: facteur avec interp bilinéaire des stats
  for (let ty = 0; ty < h; ty++) {
    for (let tx = 0; tx < w; tx++) {
      const i = ty * w + tx;
      const wx = terrainOrigin[0] + (tx + 0.5) / w * terrainSize[0];
      const wy = terrainOrigin[1] + (ty + 0.5) / h * terrainSize[1];
      const auf = (wx - aromeBounds[0]) / arx * aw - 0.5;
      const avf = (wy - aromeBounds[1]) / ary * ah - 0.5;
      const au0 = Math.max(0, Math.floor(auf));
      const av0 = Math.max(0, Math.floor(avf));
      const au1 = Math.min(aw - 1, au0 + 1);
      const av1 = Math.min(ah - 1, av0 + 1);
      const fu = Math.max(0, Math.min(1, auf - au0));
      const fv = Math.max(0, Math.min(1, avf - av0));
      const getMs = (cu: number, cv: number): [number, number] => {
        const cid = cv * aw + cu;
        if (cid >= 0 && cid < nCells && cellCount[cid] > 10 && cellStd[cid] > 5) {
          return [cellMean[cid], cellStd[cid]];
        }
        return [hm[i], 1000];
      };
      const [m00, s00] = getMs(au0, av0);
      const [m10, s10] = getMs(au1, av0);
      const [m01, s01] = getMs(au0, av1);
      const [m11, s11] = getMs(au1, av1);
      const im = m00 * (1 - fu) * (1 - fv) + m10 * fu * (1 - fv) + m01 * (1 - fu) * fv + m11 * fu * fv;
      const is = s00 * (1 - fu) * (1 - fv) + s10 * fu * (1 - fv) + s01 * (1 - fu) * fv + s11 * fu * fv;
      if (is < 5) continue;
      const z = Math.max(-2, Math.min(2, (hm[i] - im) / is));
      factor[i] = Math.max(clampLo, Math.min(clampHi, 1 + z * gradient));
    }
  }
  return factor;
}

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
