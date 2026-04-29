// ============================================================================
//  S A M P L I N G   +   T E R R A I N   M A T H
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

export interface DinfFlow {
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