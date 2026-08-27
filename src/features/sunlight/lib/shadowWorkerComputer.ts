import { computeShadowSweep } from './shadowSweep';
import { DEM_NODATA_THRESHOLD } from './shadowWorkerTileSampler';

export const MIN_RELIEF_RANGE_FOR_FALLBACK_M = 40;
export const MIN_CAST_SHADOW_COVERAGE = 0.025;
export const PREVIEW_MAX_W = 320;
export const PREVIEW_MAX_H = 224;

export type ComputeQuality = 'preview' | 'full';

export interface GridScratch {
  shadow: Uint8Array;
  shadowElev: Float32Array;
  blurTemp: Uint16Array;
  blurOut: Uint8Array;
}

export interface ComputeGrid {
  elev: Float32Array;
  gridW: number;
  gridH: number;
  cellSizeX: number;
  cellSizeY: number;
  scratch: GridScratch;
}

export interface GridState extends ComputeGrid {
  bounds: [number, number, number, number];
  previewGrid: ComputeGrid | null;
}

export function createScratchBuffers(gridW: number, gridH: number): GridScratch {
  const size = gridW * gridH;
  return {
    shadow: new Uint8Array(size),
    shadowElev: new Float32Array(size),
    blurTemp: new Uint16Array(size),
    blurOut: new Uint8Array(size),
  };
}

export function buildPreviewGrid(state: GridState): ComputeGrid | null {
  const stepX = Math.max(1, Math.ceil(state.gridW / PREVIEW_MAX_W));
  const stepY = Math.max(1, Math.ceil(state.gridH / PREVIEW_MAX_H));
  if (stepX === 1 && stepY === 1) {
    return null;
  }

  const gridW = Math.max(1, Math.ceil(state.gridW / stepX));
  const gridH = Math.max(1, Math.ceil(state.gridH / stepY));
  const elev = new Float32Array(gridW * gridH);

  for (let r = 0; r < gridH; r++) {
    const srcR = Math.min(state.gridH - 1, r * stepY + ((stepY - 1) >> 1));
    for (let c = 0; c < gridW; c++) {
      const srcC = Math.min(state.gridW - 1, c * stepX + ((stepX - 1) >> 1));
      elev[r * gridW + c] = state.elev[srcR * state.gridW + srcC]!;
    }
  }

  return {
    elev,
    gridW,
    gridH,
    cellSizeX: state.cellSizeX * stepX,
    cellSizeY: state.cellSizeY * stepY,
    scratch: createScratchBuffers(gridW, gridH),
  };
}

export function selectComputeGrid(state: GridState, quality: ComputeQuality): ComputeGrid {
  if (quality !== 'preview') {
    return state;
  }
  return state.previewGrid ?? state;
}

export function computeSweepShadow(
  elev: Float32Array,
  W: number,
  H: number,
  sunAzDeg: number,
  sunAltDeg: number,
  cellSizeX: number,
  cellSizeY: number,
  out: Uint8Array,
  shadowElev: Float32Array,
): Uint8Array {
  return computeShadowSweep(
    elev,
    W,
    H,
    sunAzDeg,
    sunAltDeg,
    cellSizeX,
    cellSizeY,
    { shadow: out, shadowElev },
  );
}

export function boxBlur3(
  src: Uint8Array,
  W: number,
  H: number,
  temp: Uint16Array,
  out: Uint8Array,
): Uint8Array {
  if (W === 0 || H === 0) return out;
  for (let r = 0; r < H; r++) {
    const rowOffset = r * W;
    if (W === 1) {
      temp[rowOffset] = src[rowOffset]!;
      continue;
    }
    temp[rowOffset] = src[rowOffset]! + src[rowOffset + 1]!;
    for (let c = 1; c < W - 1; c++) {
      const idx = rowOffset + c;
      temp[idx] = src[idx - 1]! + src[idx]! + src[idx + 1]!;
    }
    temp[rowOffset + W - 1] = src[rowOffset + W - 2]! + src[rowOffset + W - 1]!;
  }

  for (let r = 0; r < H; r++) {
    for (let c = 0; c < W; c++) {
      let sum = temp[r * W + c]!;
      let vertCount = 1;
      if (r > 0) {
        sum += temp[(r - 1) * W + c]!;
        vertCount++;
      }
      if (r < H - 1) {
        sum += temp[(r + 1) * W + c]!;
        vertCount++;
      }
      const horizCount = W === 1 ? 1 : (c === 0 || c === W - 1 ? 2 : 3);
      out[r * W + c] = ((sum / (horizCount * vertCount)) + 0.5) | 0;
    }
  }
  return out;
}

export function softenShadow(
  src: Uint8Array,
  W: number,
  H: number,
  sunAltDeg: number,
  temp: Uint16Array,
  out: Uint8Array,
): Uint8Array {
  const softness = Math.max(0, Math.min(1, (30 - sunAltDeg) / 30));
  if (softness <= 0.02) {
    out.set(src);
    return out;
  }
  const blurred = boxBlur3(src, W, H, temp, out);
  const keep = 1 - 0.55 * softness;
  const blend = 1 - keep;
  for (let i = 0; i < blurred.length; i++) {
    const mixed = src[i]! * keep + blurred[i]! * blend;
    out[i] = mixed >= 255 ? 255 : (mixed + 0.5) | 0;
  }
  return out;
}

export function needsReliefFallback(raster: Uint8Array, elev: Float32Array, sunAltDeg: number): boolean {
  if (sunAltDeg >= 72) return false;

  let shadowPixels = 0;
  for (let index = 0; index < raster.length; index++) {
    if (raster[index]! > 6) shadowPixels++;
  }
  if (shadowPixels / Math.max(1, raster.length) >= MIN_CAST_SHADOW_COVERAGE) return false;

  let minElev = Infinity;
  let maxElev = -Infinity;
  for (let index = 0; index < elev.length; index++) {
    const value = elev[index]!;
    if (!Number.isFinite(value) || value <= DEM_NODATA_THRESHOLD) continue;
    if (value < minElev) minElev = value;
    if (value > maxElev) maxElev = value;
  }

  return Number.isFinite(minElev)
    && Number.isFinite(maxElev)
    && maxElev - minElev >= MIN_RELIEF_RANGE_FOR_FALLBACK_M;
}

export function computeReliefFallbackShadow(
  elev: Float32Array,
  gridW: number,
  gridH: number,
  sunAzDeg: number,
  sunAltDeg: number,
  cellSizeX: number,
  cellSizeY: number,
  out: Uint8Array,
): Uint8Array {
  out.fill(0);
  if (gridW < 3 || gridH < 3) return out;

  const azRad = (sunAzDeg * Math.PI) / 180;
  const altRad = (sunAltDeg * Math.PI) / 180;
  const sunX = Math.sin(azRad) * Math.cos(altRad);
  const sunY = -Math.cos(azRad) * Math.cos(altRad);
  const sunZ = Math.sin(altRad);
  const altitudeBoost = Math.max(0.35, Math.min(1, (28 - sunAltDeg) / 24));

  for (let row = 1; row < gridH - 1; row++) {
    const rowOffset = row * gridW;
    for (let col = 1; col < gridW - 1; col++) {
      const index = rowOffset + col;
      const left = elev[index - 1]!;
      const right = elev[index + 1]!;
      const up = elev[index - gridW]!;
      const down = elev[index + gridW]!;
      if (
        !Number.isFinite(left) || !Number.isFinite(right) ||
        !Number.isFinite(up) || !Number.isFinite(down) ||
        left <= DEM_NODATA_THRESHOLD || right <= DEM_NODATA_THRESHOLD ||
        up <= DEM_NODATA_THRESHOLD || down <= DEM_NODATA_THRESHOLD
      ) {
        continue;
      }

      const dzDx = (right - left) / Math.max(1, 2 * cellSizeX);
      const dzDy = (down - up) / Math.max(1, 2 * cellSizeY);
      const normalScale = 1 / Math.sqrt(dzDx * dzDx + dzDy * dzDy + 1);
      const illumination = ((-dzDx * sunX) + (-dzDy * sunY) + sunZ) * normalScale;
      if (illumination >= 0.34) continue;

      const shade = Math.min(1, (0.34 - illumination) / 0.52);
      out[index] = Math.max(0, Math.min(180, shade * 180 * altitudeBoost)) | 0;
    }
  }

  return boxBlur3(out, gridW, gridH, new Uint16Array(gridW * gridH), out.slice());
}

export function collectShadowStats(raster: Uint8Array, rgba: Uint8Array): {
  alphaPixels: number;
  shadowPixels: number;
  totalPixels: number;
} {
  let alphaPixels = 0;
  let shadowPixels = 0;
  for (let index = 0; index < raster.length; index++) {
    if (raster[index]! > 6) shadowPixels++;
    if (rgba[index * 4 + 3]! > 0) alphaPixels++;
  }
  return { alphaPixels, shadowPixels, totalPixels: raster.length };
}

export function collectShadowStatsMasked(
  raster: Uint8Array,
  rgba: Uint8Array,
  zoneMask: Uint8Array,
): {
  alphaPixels: number;
  shadowPixels: number;
  totalPixels: number;
} {
  let alphaPixels = 0;
  let shadowPixels = 0;
  let total = 0;
  for (let index = 0; index < zoneMask.length; index++) {
    if (zoneMask[index] === 0) continue;
    total++;
    if (raster[index]! > 6) shadowPixels++;
    if (rgba[index * 4 + 3]! > 0) alphaPixels++;
  }
  return { alphaPixels, shadowPixels, totalPixels: Math.max(1, total) };
}
