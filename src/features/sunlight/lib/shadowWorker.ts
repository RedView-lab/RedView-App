/**
 * Shadow worker — owns the live viewport elevation grid and computes a single
 * cast-shadow image for the whole viewport.
 *
 * Architecture (per the rewrite that retired the per-tile raster source):
 *   • SAMPLE message:   resample DEM tiles from the SW CacheStorage into one
 *                       Float32 elevation grid covering the viewport bounds.
 *                       Cached internally; only re-runs on viewport change.
 *   • COMPUTE message:  run the O(N) horizon sweep on the cached grid for the
 *                       current sun (az, alt), encode a tiny PNG, return its
 *                       blob to the main thread.
 *
 * Time changes therefore skip the entire DEM resample step and only pay the
 * sweep + encode cost (~30 ms for a 1024×768 grid). User opacity now stays
 * on the Mapbox raster layer, so slider drags avoid this worker entirely.
 */

import {
  encodeShadowRgba,
  latToMercY,
  lngLatToMercTile,
  rawPng,
} from './shadowWorkerEncoding';
import { MAP_CACHE_EPOCH } from '../../map3d/lib/mapCacheEpoch';

const DEM_TILE_SIZE = 256;
const DEM_NODATA_THRESHOLD = -10000;
const DEM_CACHE_NAME = `dem-tiles-${MAP_CACHE_EPOCH}`;
const MAX_SAMPLE_TILE_COUNT = 256;
const MIN_SAMPLE_DEM_ZOOM = 4;
// Preview grid kept small so the O(N) sweep + PNG encode finishes within a
// frame budget on a slider scrub. The full grid is reused on commit.
const PREVIEW_MAX_W = 320;
const PREVIEW_MAX_H = 224;
const MIN_RELIEF_RANGE_FOR_FALLBACK_M = 18;
const MIN_CAST_SHADOW_COVERAGE = 0.012;
type ComputeQuality = 'preview' | 'full';

interface SampleRequest {
  type: 'sample';
  id: number;
  /** West, South, East, North in degrees. */
  bounds: [number, number, number, number];
  /** Viewport pixel grid for the elevation map. */
  gridW: number;
  gridH: number;
  /** Mercator zoom to sample DEM tiles at. */
  demZoom: number;
}

interface ComputeRequest {
  type: 'compute';
  id: number;
  sunAzDeg: number;
  sunAltDeg: number;
  /** 0..1 altitude-driven strength for cast shadows only. */
  shadowStrength: number;
  /** 0..1 uniform alpha floor applied to every pixel (twilight/night veil). */
  nightFloor: number;
  quality?: ComputeQuality;
}

interface ResetRequest {
  type: 'reset';
  id: number;
}

type Request = SampleRequest | ComputeRequest | ResetRequest;

interface GridScratch {
  shadow: Uint8Array;
  shadowElev: Float32Array;
  blurTemp: Uint16Array;
  blurOut: Uint8Array;
}

interface GridState {
  bounds: [number, number, number, number];
  gridW: number;
  gridH: number;
  /** Float32 elevation samples, row-major, NaN for missing data. */
  elev: Float32Array;
  /** Pre-computed cell metric size (m) at the grid's mid-latitude. */
  cellSizeX: number;
  cellSizeY: number;
  scratch: GridScratch;
  previewGrid: ComputeGrid | null;
}

interface ComputeGrid {
  elev: Float32Array;
  gridW: number;
  gridH: number;
  cellSizeX: number;
  cellSizeY: number;
  scratch: GridScratch;
}

let state: GridState | null = null;

async function openCurrentDemCache(): Promise<Cache> {
  return caches.open(DEM_CACHE_NAME);
}

self.onmessage = async (e: MessageEvent<Request>) => {
  const msg = e.data;
  try {
    if (msg.type === 'sample') {
      await handleSample(msg);
    } else if (msg.type === 'compute') {
      handleCompute(msg);
    } else if (msg.type === 'reset') {
      state = null;
      (self as unknown as Worker).postMessage({ id: msg.id, type: 'reset-ok' });
    }
  } catch (err) {
    (self as unknown as Worker).postMessage({
      id: msg.id,
      type: 'error',
      message: err instanceof Error ? err.message : String(err),
    });
  }
};

async function handleSample(msg: SampleRequest) {
  const { bounds, gridW, gridH, demZoom } = msg;
  const [w, s, e, n] = bounds;

  const elev = new Float32Array(gridW * gridH);
  elev.fill(NaN);

  let effectiveZoom = demZoom;
  let coverage = getTileCoverage(bounds, effectiveZoom);
  while (coverage.tileCount > MAX_SAMPLE_TILE_COUNT && effectiveZoom > MIN_SAMPLE_DEM_ZOOM) {
    effectiveZoom--;
    coverage = getTileCoverage(bounds, effectiveZoom);
  }

  // Sanity bound: refuse requests that are still too wide even at the minimum
  // production DEM zoom.
  if (coverage.tileCount > MAX_SAMPLE_TILE_COUNT) {
    (self as unknown as Worker).postMessage({
      id: msg.id,
      type: 'sample-ok',
      filled: 0,
      total: coverage.tileCount,
      tooMany: true,
    });
    state = null;
    return;
  }

  const cache = await openCurrentDemCache();
  type DecodedTile = {
    leafX: number;
    leafY: number;
    dataX: number;
    dataY: number;
    dataZ: number;
    elev: Float32Array | null;
  };
  const tiles: Promise<DecodedTile>[] = [];
  for (let ty = coverage.yMin; ty <= coverage.yMax; ty++) {
    for (let tx = coverage.xMin; tx <= coverage.xMax; tx++) {
      tiles.push(loadTileWithParents(cache, effectiveZoom, tx, ty));
    }
  }
  const decoded = await Promise.all(tiles);

  let filled = 0;
  // Each requested (effectiveZoom, x, y) maps to either the leaf tile
  // (when present in cache) or an ancestor tile that covers it. Storing
  // the ancestor's (z, x, y) lets the cell-lookup loop below project
  // grid-cell coords into the ancestor's pixel space.
  type CachedTile = { z: number; x: number; y: number; elev: Float32Array };
  const tileByLeaf = new Map<string, CachedTile>();
  for (const t of decoded) {
    if (t.elev && t.elev.length > 0) {
      tileByLeaf.set(`${t.leafX}/${t.leafY}`, {
        z: t.dataZ,
        x: t.dataX,
        y: t.dataY,
        elev: t.elev,
      });
    }
  }

  // Inverse mercator: row r → lat from north→south linearly in mercator-Y.
  // We sample uniformly in mercator (matches DEM tile pixel grid → 1-1 map).
  const nMercY = latToMercY(n);
  const sMercY = latToMercY(s);
  const dMercY = (sMercY - nMercY) / gridH;
  const dLng = (e - w) / gridW;

  const nTiles = 1 << effectiveZoom;
  for (let r = 0; r < gridH; r++) {
    const my = nMercY + (r + 0.5) * dMercY;
    // (lat derivation skipped — we work in mercator-Y for tile indexing)
    // Compute corresponding tile Y at demZoom (continuous).
    // latToMercY returns normalized mercator-Y in [0..1] (0=north pole,
    // 1=south pole), matching lngLatToMercTile's `mercY * 2^z` mapping.
    const tileYf = my * nTiles;
    for (let c = 0; c < gridW; c++) {
      const lng = w + (c + 0.5) * dLng;
      // Continuous tile X.
      const tileXf = ((lng + 180) / 360) * nTiles;
      const tx = Math.floor(tileXf);
      const ty = Math.floor(tileYf);
      const leaf = tileByLeaf.get(`${tx}/${ty}`);
      if (!leaf) continue;
      // Project the leaf-zoom continuous tile coords into the ancestor
      // tile's pixel space. dz=0 → identity; dz>0 → divide-and-shift so a
      // 256-px ancestor tile is sampled at the equivalent sub-region of
      // the requested leaf tile.
      const dz = effectiveZoom - leaf.z;
      const ancestorTileXf = tileXf / (1 << dz);
      const ancestorTileYf = tileYf / (1 << dz);
      const px = (ancestorTileXf - leaf.x) * DEM_TILE_SIZE;
      const py = (ancestorTileYf - leaf.y) * DEM_TILE_SIZE;
      const v = bilinearSample(leaf.elev, DEM_TILE_SIZE, DEM_TILE_SIZE, px, py);
      if (Number.isFinite(v) && v > DEM_NODATA_THRESHOLD) {
        elev[r * gridW + c] = v;
        filled++;
      }
    }
  }

  // Cell sizes (metres) at mid-latitude.
  const midLat = (n + s) / 2;
  const cosLat = Math.cos((midLat * Math.PI) / 180);
  const lonExtentM = ((e - w) * Math.PI * 6378137 * cosLat) / 180;
  const latExtentM = ((n - s) * Math.PI * 6378137) / 180;

  state = {
    bounds,
    gridW,
    gridH,
    elev,
    cellSizeX: lonExtentM / gridW,
    cellSizeY: latExtentM / gridH,
    scratch: createScratchBuffers(gridW, gridH),
    previewGrid: null,
  };
  state.previewGrid = buildPreviewGrid(state);

  (self as unknown as Worker).postMessage({
    id: msg.id,
    type: 'sample-ok',
    filled,
    total: gridW * gridH,
    effectiveZoom,
    downgraded: effectiveZoom !== demZoom,
  });
}

function getTileCoverage(
  bounds: [number, number, number, number],
  zoom: number,
): { xMin: number; xMax: number; yMin: number; yMax: number; tileCount: number } {
  const [w, s, e, n] = bounds;
  const tlTile = lngLatToMercTile(w, n, zoom);
  const brTile = lngLatToMercTile(e, s, zoom);
  const xMin = Math.floor(tlTile.x);
  const xMax = Math.floor(brTile.x);
  const yMin = Math.floor(tlTile.y);
  const yMax = Math.floor(brTile.y);
  return {
    xMin,
    xMax,
    yMin,
    yMax,
    tileCount: (xMax - xMin + 1) * (yMax - yMin + 1),
  };
}

function createScratchBuffers(gridW: number, gridH: number): GridScratch {
  const size = gridW * gridH;
  return {
    shadow: new Uint8Array(size),
    shadowElev: new Float32Array(size),
    blurTemp: new Uint16Array(size),
    blurOut: new Uint8Array(size),
  };
}

function buildPreviewGrid(state: GridState): ComputeGrid | null {
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
      elev[r * gridW + c] = state.elev[srcR * state.gridW + srcC];
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

async function loadTileWithParents(
  cache: Cache,
  z: number,
  x: number,
  y: number,
): Promise<{
  leafX: number;
  leafY: number;
  dataX: number;
  dataY: number;
  dataZ: number;
  elev: Float32Array | null;
}> {
  if (x < 0 || y < 0 || x >= 1 << z || y >= 1 << z) {
    return { leafX: x, leafY: y, dataX: x, dataY: y, dataZ: z, elev: null };
  }

  // Step 1 — try the requested leaf tile from cache. `ignoreSearch: true`
  // makes the lookup tolerate any query string Mapbox/the SW may have
  // appended (cache-epoch, profile, dem-bust). The SW writes under the
  // bare key for default profile, but defensive ignoreSearch protects
  // against future variations and lets us pick up the basemap's cached
  // tile even if its key differs from ours.
  const url = new URL(`/dem-tiles/${z}/${x}/${y}`, self.location.origin).toString();
  const direct = await cacheMatchAny(cache, url);
  if (direct) {
    const elev = await safeDecode(direct);
    if (elev) return { leafX: x, leafY: y, dataX: x, dataY: y, dataZ: z, elev };
  }

  // Step 2 — walk up to MAX_PARENT_WALK ancestors. A coarser tile
  // already in cache lets us bilinear-sample at the leaf cell positions,
  // which is far better than a NaN hole. The shadow sweep is robust to
  // mixed-resolution input because we still translate cells through
  // mercator math.
  const MAX_PARENT_WALK = 4;
  for (let dz = 1; dz <= MAX_PARENT_WALK && z - dz >= 0; dz++) {
    const pz = z - dz;
    const px = x >> dz;
    const py = y >> dz;
    const parentUrl = new URL(`/dem-tiles/${pz}/${px}/${py}`, self.location.origin).toString();
    const parent = await cacheMatchAny(cache, parentUrl);
    if (parent) {
      const elev = await safeDecode(parent);
      if (elev) return { leafX: x, leafY: y, dataX: px, dataY: py, dataZ: pz, elev };
    }
  }

  // Step 3 — last resort: trigger an SW build for the leaf. This is
  // expensive under load (saturated IGN queue) but unavoidable on a cold
  // viewport. We still return null on 204 so the caller falls back to
  // partial coverage rather than blocking forever.
  try {
    const resp = await fetch(url);
    if (resp && resp.status === 200) {
      const elev = await safeDecode(resp);
      if (elev) return { leafX: x, leafY: y, dataX: x, dataY: y, dataZ: z, elev };
    }
  } catch {
    /* network/abort — yield null below */
  }
  return { leafX: x, leafY: y, dataX: x, dataY: y, dataZ: z, elev: null };
}

async function cacheMatchAny(cache: Cache, url: string): Promise<Response | null> {
  try {
    const resp = await cache.match(url, { ignoreSearch: true });
    if (resp && resp.status === 200) return resp;
  } catch {
    /* ignore */
  }
  return null;
}

async function safeDecode(resp: Response): Promise<Float32Array | null> {
  try {
    const blob = await resp.clone().blob();
    const elev = await decodeTerrainRGB(blob);
    return elev.length === DEM_TILE_SIZE * DEM_TILE_SIZE ? elev : null;
  } catch {
    return null;
  }
}

async function decodeTerrainRGB(blob: Blob): Promise<Float32Array> {
  const img = await createImageBitmap(blob, {
    colorSpaceConversion: 'none',
    premultiplyAlpha: 'none',
  });
  // Capture dimensions BEFORE close() — Chrome resets ImageBitmap.width/height
  // to 0 after close, which would silently zero-out the output array.
  const w = img.width;
  const h = img.height;
  if (w === 0 || h === 0) {
    img.close();
    return new Float32Array(0);
  }
  let imageData: ImageData;
  try {
    const canvas = new OffscreenCanvas(w, h);
    const ctx = canvas.getContext('2d', { colorSpace: 'srgb' }) as OffscreenCanvasRenderingContext2D;
    ctx.drawImage(img, 0, 0);
    imageData = ctx.getImageData(0, 0, w, h);
  } finally {
    img.close();
  }
  const px = imageData.data;
  const out = new Float32Array(w * h);
  for (let i = 0; i < out.length; i++) {
    const o = i * 4;
    out[i] = -10000 + (px[o] * 65536 + px[o + 1] * 256 + px[o + 2]) * 0.1;
  }
  return out;
}

function bilinearSample(
  src: Float32Array,
  W: number,
  H: number,
  x: number,
  y: number,
): number {
  const x0 = Math.max(0, Math.min(W - 1, Math.floor(x)));
  const y0 = Math.max(0, Math.min(H - 1, Math.floor(y)));
  const x1 = Math.min(W - 1, x0 + 1);
  const y1 = Math.min(H - 1, y0 + 1);
  const fx = x - x0;
  const fy = y - y0;
  const a = src[y0 * W + x0];
  const b = src[y0 * W + x1];
  const c = src[y1 * W + x0];
  const d = src[y1 * W + x1];
  if (
    a <= DEM_NODATA_THRESHOLD || b <= DEM_NODATA_THRESHOLD ||
    c <= DEM_NODATA_THRESHOLD || d <= DEM_NODATA_THRESHOLD
  ) {
    return NaN;
  }
  return (
    a * (1 - fx) * (1 - fy) +
    b * fx * (1 - fy) +
    c * (1 - fx) * fy +
    d * fx * fy
  );
}

// ── Sun-driven shadow compute ───────────────────────────────────────────

function handleCompute(msg: ComputeRequest) {
  if (!state) {
    (self as unknown as Worker).postMessage({ id: msg.id, type: 'compute-empty' });
    return;
  }
  const { sunAzDeg, sunAltDeg, shadowStrength, nightFloor, quality = 'full' } = msg;
  const computeGrid = selectComputeGrid(state, quality);
  const { gridW, gridH, elev, cellSizeX, cellSizeY, scratch } = computeGrid;

  let raster: Uint8Array;
  if (sunAltDeg > 0 && shadowStrength > 0) {
    const shadow = computeSweepShadow(
      elev,
      gridW,
      gridH,
      sunAzDeg,
      sunAltDeg,
      cellSizeX,
      cellSizeY,
      scratch.shadow,
      scratch.shadowElev,
    );
    if (quality === 'preview') {
      raster = boxBlur3(shadow, gridW, gridH, scratch.blurTemp, scratch.blurOut);
    } else {
      const firstPass = boxBlur3(shadow, gridW, gridH, scratch.blurTemp, scratch.blurOut);
      raster = softenShadow(firstPass, gridW, gridH, sunAltDeg, scratch.blurTemp, scratch.shadow);
    }
    if (needsReliefFallback(raster, elev, sunAltDeg)) {
      raster = computeReliefFallbackShadow(
        elev,
        gridW,
        gridH,
        sunAzDeg,
        sunAltDeg,
        cellSizeX,
        cellSizeY,
        scratch.shadow,
      );
    }
  } else if (shadowStrength > 0) {
    scratch.shadow.fill(255);
    raster = scratch.shadow;
  } else {
    scratch.shadow.fill(0);
    raster = scratch.shadow;
  }

  const rgba = encodeShadowRgba(raster, gridW, gridH, shadowStrength, nightFloor);
  const stats = collectShadowStats(raster, rgba);
  const blob = new Blob([rawPng(gridW, gridH, rgba).buffer as ArrayBuffer], { type: 'image/png' });

  (self as unknown as Worker).postMessage(
    {
      id: msg.id,
      type: 'compute-ok',
      blob,
      bounds: state.bounds,
      alphaPixels: stats.alphaPixels,
      shadowPixels: stats.shadowPixels,
      totalPixels: stats.totalPixels,
    },
  );
}

function collectShadowStats(raster: Uint8Array, rgba: Uint8Array): {
  alphaPixels: number;
  shadowPixels: number;
  totalPixels: number;
} {
  let alphaPixels = 0;
  let shadowPixels = 0;
  for (let index = 0; index < raster.length; index++) {
    if (raster[index] > 6) shadowPixels++;
    if (rgba[index * 4 + 3] > 0) alphaPixels++;
  }
  return { alphaPixels, shadowPixels, totalPixels: raster.length };
}

function selectComputeGrid(state: GridState, quality: ComputeQuality): ComputeGrid {
  if (quality !== 'preview') {
    return state;
  }

  return state.previewGrid ?? state;
}

function needsReliefFallback(raster: Uint8Array, elev: Float32Array, sunAltDeg: number): boolean {
  if (sunAltDeg >= 72) return false;

  let shadowPixels = 0;
  for (let index = 0; index < raster.length; index++) {
    if (raster[index] > 6) shadowPixels++;
  }
  if (shadowPixels / Math.max(1, raster.length) >= MIN_CAST_SHADOW_COVERAGE) return false;

  let minElev = Infinity;
  let maxElev = -Infinity;
  for (let index = 0; index < elev.length; index++) {
    const value = elev[index];
    if (!Number.isFinite(value) || value <= DEM_NODATA_THRESHOLD) continue;
    if (value < minElev) minElev = value;
    if (value > maxElev) maxElev = value;
  }

  return Number.isFinite(minElev)
    && Number.isFinite(maxElev)
    && maxElev - minElev >= MIN_RELIEF_RANGE_FOR_FALLBACK_M;
}

function computeReliefFallbackShadow(
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
      const left = elev[index - 1];
      const right = elev[index + 1];
      const up = elev[index - gridW];
      const down = elev[index + gridW];
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

/**
 * O(N) horizon sweep — same algorithm as the legacy SW per-tile shadow but
 * applied once over the whole viewport grid. No padding required: shadows
 * cast from beyond the viewport edge are simply absent (acceptable: those
 * pixels are off-screen anyway and the eye doesn't track 1-pixel rim cases).
 *
 * Realism improvements:
 *  - **Bilinear predecessor** (instead of `Math.round`): eliminates the
 *    1-pixel row/column "staircase" aliasing that made long shadows look
 *    jagged, especially when the sun azimuth is near 30°/60°/etc.
 *  - **Soft penumbra**: the byte written to `out` ramps with the height
 *    difference `(propagated - el)` over `SOFTNESS_HEIGHT_M`, instead of
 *    being a hard 0/255. Gives anti-aliased shadow edges and a real
 *    intensity gradient that scales with sun altitude (low sun → wider
 *    penumbra, matching physical sunset shadows).
 *  - **NaN-tolerant chain**: when a cell's elevation is NaN we no longer
 *    write `-Infinity` (which used to kill the propagated shadow ray for
 *    every downstream cell). Instead the predecessor lookup uses whichever
 *    of its two interpolation neighbours is finite, so shadows survive
 *    crossing small DEM holes.
 */
function computeSweepShadow(
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
  out.fill(0);
  if (sunAltDeg <= 0) {
    return out;
  }
  if (sunAltDeg >= 89) {
    return out; // sun virtually overhead → shadow length ≈ 0
  }

  const azRad = (sunAzDeg * Math.PI) / 180;
  const tanAlt = Math.tan((sunAltDeg * Math.PI) / 180);
  // Shadow propagation = away from the sun.
  const shadowDC = -Math.sin(azRad);
  const shadowDR = Math.cos(azRad);
  const absDC = Math.abs(shadowDC);
  const absDR = Math.abs(shadowDR);

  // Penumbra height (metres). Sun disc + atmospheric softening + per-cell
  // anti-aliasing all roll into this single parameter. Low sun → wider
  // penumbra: matches the way real evening shadows fade out.
  const SOFTNESS_HEIGHT_M =
    2.5 + 6 * Math.max(0, Math.min(1, (35 - sunAltDeg) / 35));
  const invSoftness = 255 / SOFTNESS_HEIGHT_M;

  if (absDC >= absDR) {
    const colStep = shadowDC > 0 ? 1 : -1;
    const rowShift = shadowDR / absDC;
    const stepDistM = Math.sqrt(
      cellSizeX * cellSizeX + (rowShift * cellSizeY) * (rowShift * cellSizeY),
    );
    const dropPerStep = stepDistM * tanAlt;
    const colStart = colStep > 0 ? 0 : W - 1;
    const colEnd = colStep > 0 ? W : -1;
    for (let c = colStart; c !== colEnd; c += colStep) {
      const predC = c - colStep;
      const predEdge = predC < 0 || predC >= W;
      for (let r = 0; r < H; r++) {
        const idx = r * W + c;
        const el = elev[idx];
        if (Number.isNaN(el)) {
          shadowElev[idx] = -Infinity;
          continue;
        }
        if (predEdge) {
          shadowElev[idx] = el;
          continue;
        }
        const predRf = r - rowShift;
        const predR0 = Math.floor(predRf);
        const predR1 = predR0 + 1;
        if (predR0 < 0 || predR1 >= H) {
          shadowElev[idx] = el;
          continue;
        }
        const v0 = shadowElev[predR0 * W + predC];
        const v1 = shadowElev[predR1 * W + predC];
        let predElev: number;
        if (v0 === -Infinity) {
          if (v1 === -Infinity) {
            shadowElev[idx] = el;
            continue;
          }
          predElev = v1;
        } else if (v1 === -Infinity) {
          predElev = v0;
        } else {
          const fr = predRf - predR0;
          predElev = v0 * (1 - fr) + v1 * fr;
        }
        const propagated = predElev - dropPerStep;
        const diff = propagated - el;
        if (diff > 0) {
          shadowElev[idx] = propagated;
          const cast = diff * invSoftness;
          out[idx] = cast >= 255 ? 255 : cast | 0;
        } else {
          shadowElev[idx] = el;
        }
      }
    }
  } else {
    const rowStep = shadowDR > 0 ? 1 : -1;
    const colShift = shadowDC / absDR;
    const stepDistM = Math.sqrt(
      (colShift * cellSizeX) * (colShift * cellSizeX) + cellSizeY * cellSizeY,
    );
    const dropPerStep = stepDistM * tanAlt;
    const rowStart = rowStep > 0 ? 0 : H - 1;
    const rowEnd = rowStep > 0 ? H : -1;
    for (let r = rowStart; r !== rowEnd; r += rowStep) {
      const predR = r - rowStep;
      const predEdge = predR < 0 || predR >= H;
      const predRowOffset = predEdge ? 0 : predR * W;
      for (let c = 0; c < W; c++) {
        const idx = r * W + c;
        const el = elev[idx];
        if (Number.isNaN(el)) {
          shadowElev[idx] = -Infinity;
          continue;
        }
        if (predEdge) {
          shadowElev[idx] = el;
          continue;
        }
        const predCf = c - colShift;
        const predC0 = Math.floor(predCf);
        const predC1 = predC0 + 1;
        if (predC0 < 0 || predC1 >= W) {
          shadowElev[idx] = el;
          continue;
        }
        const v0 = shadowElev[predRowOffset + predC0];
        const v1 = shadowElev[predRowOffset + predC1];
        let predElev: number;
        if (v0 === -Infinity) {
          if (v1 === -Infinity) {
            shadowElev[idx] = el;
            continue;
          }
          predElev = v1;
        } else if (v1 === -Infinity) {
          predElev = v0;
        } else {
          const fc = predCf - predC0;
          predElev = v0 * (1 - fc) + v1 * fc;
        }
        const propagated = predElev - dropPerStep;
        const diff = propagated - el;
        if (diff > 0) {
          shadowElev[idx] = propagated;
          const cast = diff * invSoftness;
          out[idx] = cast >= 255 ? 255 : cast | 0;
        } else {
          shadowElev[idx] = el;
        }
      }
    }
  }
  return out;
}

function boxBlur3(
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
      temp[rowOffset] = src[rowOffset];
      continue;
    }
    temp[rowOffset] = src[rowOffset] + src[rowOffset + 1];
    for (let c = 1; c < W - 1; c++) {
      const idx = rowOffset + c;
      temp[idx] = src[idx - 1] + src[idx] + src[idx + 1];
    }
    temp[rowOffset + W - 1] = src[rowOffset + W - 2] + src[rowOffset + W - 1];
  }

  for (let r = 0; r < H; r++) {
    for (let c = 0; c < W; c++) {
      let sum = temp[r * W + c];
      let vertCount = 1;
      if (r > 0) {
        sum += temp[(r - 1) * W + c];
        vertCount++;
      }
      if (r < H - 1) {
        sum += temp[(r + 1) * W + c];
        vertCount++;
      }
      const horizCount = W === 1 ? 1 : (c === 0 || c === W - 1 ? 2 : 3);
      out[r * W + c] = ((sum / (horizCount * vertCount)) + 0.5) | 0;
    }
  }
  return out;
}

function softenShadow(
  src: Uint8Array,
  W: number,
  H: number,
  sunAltDeg: number,
  temp: Uint16Array,
  out: Uint8Array,
): Uint8Array {
  // Penumbra widens noticeably below ~30° sun altitude. The sweep already
  // produces a soft edge via SOFTNESS_HEIGHT_M, so this is just a wider
  // Gaussian-ish feather for the very low-sun case (golden hour onward).
  const softness = Math.max(0, Math.min(1, (30 - sunAltDeg) / 30));
  if (softness <= 0.02) {
    out.set(src);
    return out;
  }
  const blurred = boxBlur3(src, W, H, temp, out);
  // Mild widening — preserve detail at mid-sun, feather strongly only at
  // dusk. No global "liftedFloor" any more: the cast-shadow buffer must
  // stay zero in genuinely lit regions, otherwise the whole scene fogs up.
  const keep = 1 - 0.55 * softness;
  const blend = 1 - keep;
  for (let i = 0; i < blurred.length; i++) {
    const mixed = src[i] * keep + blurred[i] * blend;
    out[i] = mixed >= 255 ? 255 : (mixed + 0.5) | 0;
  }
  return out;
}

/**
 * Encode the shadow byte-buffer as straight black-with-alpha RGBA so the
 * resulting image can be drawn directly by Mapbox's raster layer with no
 * `raster-color` plumbing.
 */
