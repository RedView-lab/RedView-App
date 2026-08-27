/**
 * dem-grid-worker.ts — Pure DEM sampling utilities, safe to import from any
 * Web Worker module.
 *
 * Extracted so the cast-shadow worker (`shadowWorker.ts`) and the cumulative
 * sunlight-map worker (`sunlightMapWorker.ts`) share one battle-tested DEM
 * pipeline instead of diverging copies.
 *
 * Responsibility: given a viewport bbox, build a `Float32Array` elevation
 * grid by reading Terrain-RGB tiles out of the SW's CacheStorage. No
 * worker-global state lives here — each call is self-contained.
 */
import { latToMercY, lngLatToMercTile } from './shadowWorkerEncoding';
import { computeShadowSweep } from './shadowSweep';
import { MAP_CACHE_EPOCH } from '../../map3d/lib/mapCacheEpoch';

export const DEM_TILE_SIZE = 256;
export const DEM_NODATA_THRESHOLD = -10000;
export const DEM_CACHE_NAME = `dem-tiles-${MAP_CACHE_EPOCH}`;
export const MAX_SAMPLE_TILE_COUNT = 256;
export const MIN_SAMPLE_DEM_ZOOM = 4;
const MAX_PARENT_WALK = 4;

export type BoundsTuple = [number, number, number, number];

export interface ElevationGridSampleResult {
  /** Row-major Float32 grid, `NaN` for missing cells. */
  elev: Float32Array;
  /** Filled / total counts to let callers compute coverage ratio. */
  filled: number;
  total: number;
  /** True if the viewport spans too many tiles even at MIN_SAMPLE_DEM_ZOOM. */
  tooMany: boolean;
  /** Actual DEM zoom used after auto-downgrade (≤ requested `demZoom`). */
  effectiveZoom: number;
  downgraded: boolean;
  /** Metric cell size at the grid's mid-latitude (metres). */
  cellSizeX: number;
  cellSizeY: number;
}

/**
 * Builds a `gridW × gridH` elevation grid for `bounds`. Auto-downgrades
 * `demZoom` until the viewport covers at most `MAX_SAMPLE_TILE_COUNT` tiles.
 *
 * Cells with no cached coverage (even after a 4-step parent walk + one live
 * fetch attempt) are left as `NaN`. Callers should check `filled / total`
 * before consuming the grid.
 */
export async function sampleViewportElevationGrid(
  bounds: BoundsTuple,
  gridW: number,
  gridH: number,
  demZoom: number,
): Promise<ElevationGridSampleResult> {
  const [w, s, e, n] = bounds;

  let effectiveZoom = demZoom;
  let coverage = getTileCoverage(bounds, effectiveZoom);
  while (coverage.tileCount > MAX_SAMPLE_TILE_COUNT && effectiveZoom > MIN_SAMPLE_DEM_ZOOM) {
    effectiveZoom--;
    coverage = getTileCoverage(bounds, effectiveZoom);
  }

  if (coverage.tileCount > MAX_SAMPLE_TILE_COUNT) {
    return {
      elev: new Float32Array(0),
      filled: 0,
      total: gridW * gridH,
      tooMany: true,
      effectiveZoom,
      downgraded: effectiveZoom !== demZoom,
      cellSizeX: 0,
      cellSizeY: 0,
    };
  }

  const elev = new Float32Array(gridW * gridH);
  elev.fill(NaN);

  const cache = await openCurrentDemCache();
  const tiles: Promise<DecodedTile>[] = [];
  for (let ty = coverage.yMin; ty <= coverage.yMax; ty++) {
    for (let tx = coverage.xMin; tx <= coverage.xMax; tx++) {
      tiles.push(loadTileWithParents(cache, effectiveZoom, tx, ty));
    }
  }
  const decoded = await Promise.all(tiles);

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

  const nMercY = latToMercY(n);
  const sMercY = latToMercY(s);
  const dMercY = (sMercY - nMercY) / gridH;
  const dLng = (e - w) / gridW;
  const nTiles = 1 << effectiveZoom;

  let filled = 0;
  for (let r = 0; r < gridH; r++) {
    const my = nMercY + (r + 0.5) * dMercY;
    const tileYf = my * nTiles;
    for (let c = 0; c < gridW; c++) {
      const lng = w + (c + 0.5) * dLng;
      const tileXf = ((lng + 180) / 360) * nTiles;
      const tx = Math.floor(tileXf);
      const ty = Math.floor(tileYf);
      const leaf = tileByLeaf.get(`${tx}/${ty}`);
      if (!leaf) continue;
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

  const midLat = (n + s) / 2;
  const cosLat = Math.cos((midLat * Math.PI) / 180);
  const lonExtentM = ((e - w) * Math.PI * 6378137 * cosLat) / 180;
  const latExtentM = ((n - s) * Math.PI * 6378137) / 180;

  return {
    elev,
    filled,
    total: gridW * gridH,
    tooMany: false,
    effectiveZoom,
    downgraded: effectiveZoom !== demZoom,
    cellSizeX: lonExtentM / gridW,
    cellSizeY: latExtentM / gridH,
  };
}

interface DecodedTile {
  leafX: number;
  leafY: number;
  dataX: number;
  dataY: number;
  dataZ: number;
  elev: Float32Array | null;
}

interface CachedTile {
  z: number;
  x: number;
  y: number;
  elev: Float32Array;
}

export function getTileCoverage(
  bounds: BoundsTuple,
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

async function openCurrentDemCache(): Promise<Cache> {
  return caches.open(DEM_CACHE_NAME);
}

async function loadTileWithParents(
  cache: Cache,
  z: number,
  x: number,
  y: number,
): Promise<DecodedTile> {
  if (x < 0 || y < 0 || x >= 1 << z || y >= 1 << z) {
    return { leafX: x, leafY: y, dataX: x, dataY: y, dataZ: z, elev: null };
  }

  const url = new URL(`/dem-tiles/${z}/${x}/${y}`, self.location.origin).toString();
  const direct = await cacheMatchAny(cache, url);
  if (direct) {
    const elev = await safeDecode(direct);
    if (elev) return { leafX: x, leafY: y, dataX: x, dataY: y, dataZ: z, elev };
  }

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

  try {
    const resp = await fetch(url);
    if (resp && resp.status === 200) {
      const elev = await safeDecode(resp);
      if (elev) return { leafX: x, leafY: y, dataX: x, dataY: y, dataZ: z, elev };
    }
  } catch {
    /* network/abort */
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

export function bilinearSample(
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

/**
 * Single-pass O(N) horizon sweep. `out` must be (gridW*gridH) bytes; written
 * with 0 = lit, 255 = fully cast-shadow, intermediate = soft penumbra.
 * `shadowElev` is a scratch Float32 buffer used internally to propagate ray
 * altitudes — no need to clear it.
 *
 * Thin wrapper over `computeShadowSweep` (shadowSweep.ts), which is now the
 * single source of truth for the sweep algorithm shared by the cast-shadow and
 * sunlight-map workers. The wrapper exists to preserve this module's existing
 * `(out, shadowElev)` signature used by `sunlightMapWorker.ts`.
 */
export function computeHorizonSweepShadow(
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
