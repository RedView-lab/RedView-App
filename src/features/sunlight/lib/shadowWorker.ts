import {
  encodeShadowRgba,
  latToMercY,
  rawPng,
} from './shadowWorkerEncoding';
import { applyPolygonMaskToRgba, rasterizePolygonMask } from './polygonMask';
import { MAP_CACHE_EPOCH } from '../../map3d/lib/mapCacheEpoch';
import {
  bilinearSample,
  DEM_NODATA_THRESHOLD,
  DEM_TILE_SIZE,
  getTileCoverage,
  loadTileWithParents,
} from './shadowWorkerTileSampler';
import {
  boxBlur3,
  buildPreviewGrid,
  collectShadowStats,
  collectShadowStatsMasked,
  computeReliefFallbackShadow,
  computeSweepShadow,
  createScratchBuffers,
  needsReliefFallback,
  selectComputeGrid,
  softenShadow,
  type ComputeQuality,
  type GridState,
} from './shadowWorkerComputer';

const DEM_CACHE_NAME = `dem-tiles-${MAP_CACHE_EPOCH}`;
const MAX_SAMPLE_TILE_COUNT = 256;
const MIN_SAMPLE_DEM_ZOOM = 4;

interface SampleRequest {
  type: 'sample';
  id: number;
  bounds: [number, number, number, number];
  gridW: number;
  gridH: number;
  demZoom: number;
}

interface ComputeRequest {
  type: 'compute';
  id: number;
  sunAzDeg: number;
  sunAltDeg: number;
  shadowStrength: number;
  nightFloor: number;
  quality?: ComputeQuality;
  zoneRing?: number[] | null;
}

interface ResetRequest {
  type: 'reset';
  id: number;
}

type Request = SampleRequest | ComputeRequest | ResetRequest;

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

  const nMercY = latToMercY(n);
  const sMercY = latToMercY(s);
  const dMercY = (sMercY - nMercY) / gridH;
  const dLng = (e - w) / gridW;
  const nTiles = 1 << effectiveZoom;

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
  let zoneMask: Uint8Array | null = null;
  if (msg.zoneRing) {
    zoneMask = rasterizePolygonMask(msg.zoneRing, state.bounds, gridW, gridH);
    if (zoneMask) applyPolygonMaskToRgba(rgba, zoneMask);
  }
  const stats = zoneMask
    ? collectShadowStatsMasked(raster, rgba, zoneMask)
    : collectShadowStats(raster, rgba);
  const blob = new Blob([rawPng(gridW, gridH, rgba).buffer as ArrayBuffer], { type: 'image/png' });

  (self as unknown as Worker).postMessage({
    id: msg.id,
    type: 'compute-ok',
    blob,
    bounds: state.bounds,
    alphaPixels: stats.alphaPixels,
    shadowPixels: stats.shadowPixels,
    totalPixels: stats.totalPixels,
  });
}
