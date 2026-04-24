// ============================================
// LiDAR HD — WebGL fallback orthophoto stitcher
// ============================================
// Downloads IGN ORTHOIMAGERY tiles at WMTS zoom 19 (PM grid) covering the
// LiDAR tile bounds and stitches them into a single ImageBitmap that the
// WebGL renderer uploads as one texture. Returns the bitmap together with
// the four corner UVs (in stitched-texture space [0..1]) so the worker can
// pre-compute per-vertex UVs.

import { toWgs84 } from '../coordConvert';
import type { PointCloudBounds, DetectedCrs } from '../types';
import type { CornerUV } from './terrainWorker';

const WMTS_ZOOM = 19;
const TILE_SIZE = 256;

export interface StitchedOrtho {
  bitmap: ImageBitmap;
  width: number;
  height: number;
  cornerUV: CornerUV;
}

interface AbsPx { px: number; py: number }

function wgs84ToAbsPixel(lon: number, lat: number, zoom: number): AbsPx {
  const n = Math.pow(2, zoom);
  const px = ((lon + 180) / 360) * n * TILE_SIZE;
  const latRad = (lat * Math.PI) / 180;
  const py = (1 - Math.log(Math.tan(latRad) + 1 / Math.cos(latRad)) / Math.PI) / 2 * n * TILE_SIZE;
  return { px, py };
}

async function fetchTile(col: number, row: number): Promise<ImageBitmap | null> {
  const url =
    `https://data.geopf.fr/wmts?SERVICE=WMTS&REQUEST=GetTile&VERSION=1.0.0` +
    `&LAYER=ORTHOIMAGERY.ORTHOPHOTOS&STYLE=normal&FORMAT=image/jpeg` +
    `&TILEMATRIXSET=PM&TILEMATRIX=${WMTS_ZOOM}&TILEROW=${row}&TILECOL=${col}`;
  try {
    const r = await fetch(url);
    if (!r.ok) return null;
    const blob = await r.blob();
    return await createImageBitmap(blob);
  } catch {
    return null;
  }
}

export async function stitchOrtho(
  bounds: PointCloudBounds,
  crs: DetectedCrs,
  maxTextureDim: number,
  onProgress?: (pct: number, label: string) => void,
): Promise<StitchedOrtho> {
  // Project the four bounds corners to Web Mercator absolute pixels at z19
  const c00 = wgs84ToAbsPixel(...toWgs84(bounds.minX, bounds.minY, crs), WMTS_ZOOM);
  const c10 = wgs84ToAbsPixel(...toWgs84(bounds.maxX, bounds.minY, crs), WMTS_ZOOM);
  const c01 = wgs84ToAbsPixel(...toWgs84(bounds.minX, bounds.maxY, crs), WMTS_ZOOM);
  const c11 = wgs84ToAbsPixel(...toWgs84(bounds.maxX, bounds.maxY, crs), WMTS_ZOOM);

  const allX = [c00.px, c10.px, c01.px, c11.px];
  const allY = [c00.py, c10.py, c01.py, c11.py];
  const minTileCol = Math.floor(Math.min(...allX) / TILE_SIZE);
  const maxTileCol = Math.floor(Math.max(...allX) / TILE_SIZE);
  // Mercator Y grows southward → upper-left corner uses min(absPy)
  const minTileRow = Math.floor(Math.min(...allY) / TILE_SIZE);
  const maxTileRow = Math.floor(Math.max(...allY) / TILE_SIZE);

  const colsCount = maxTileCol - minTileCol + 1;
  const rowsCount = maxTileRow - minTileRow + 1;
  const fullW = colsCount * TILE_SIZE;
  const fullH = rowsCount * TILE_SIZE;

  // Some software/older GL drivers cap textures at 4096. Render to a
  // clamped canvas if the stitched extent exceeds that. We still draw
  // every tile so detail is preserved (just downsampled in the resize).
  const cap = Math.max(1024, Math.min(maxTextureDim || 4096, 8192));
  const scale = Math.min(1, cap / Math.max(fullW, fullH));
  const W = Math.max(1, Math.round(fullW * scale));
  const H = Math.max(1, Math.round(fullH * scale));

  const canvas = new OffscreenCanvas(W, H);
  const ctx = canvas.getContext('2d', { alpha: false });
  if (!ctx) throw new Error('OffscreenCanvas 2D context unavailable');
  ctx.imageSmoothingEnabled = false;
  ctx.fillStyle = '#1a1a1a';
  ctx.fillRect(0, 0, W, H);

  type Job = { col: number; row: number };
  const jobs: Job[] = [];
  for (let c = minTileCol; c <= maxTileCol; c++) {
    for (let r = minTileRow; r <= maxTileRow; r++) jobs.push({ col: c, row: r });
  }

  const BATCH = 32;
  let done = 0;
  for (let i = 0; i < jobs.length; i += BATCH) {
    const batch = jobs.slice(i, i + BATCH);
    const bitmaps = await Promise.all(batch.map((j) => fetchTile(j.col, j.row)));
    for (let k = 0; k < batch.length; k++) {
      const bm = bitmaps[k];
      if (!bm) continue;
      const dx = (batch[k].col - minTileCol) * TILE_SIZE * scale;
      const dy = (batch[k].row - minTileRow) * TILE_SIZE * scale;
      const dw = TILE_SIZE * scale;
      const dh = TILE_SIZE * scale;
      ctx.drawImage(bm, dx, dy, dw, dh);
      bm.close();
    }
    done += batch.length;
    onProgress?.(done / jobs.length, `Orthophotos ${done}/${jobs.length}`);
  }

  // Corner UVs in stitched-texture space [0..1]
  const stitchOriginPx = minTileCol * TILE_SIZE;
  const stitchOriginPy = minTileRow * TILE_SIZE;
  const toUV = (c: AbsPx) => ({
    u: ((c.px - stitchOriginPx) * scale) / W,
    v: ((c.py - stitchOriginPy) * scale) / H,
  });
  const uv00 = toUV(c00), uv10 = toUV(c10), uv01 = toUV(c01), uv11 = toUV(c11);

  const bitmap = await createImageBitmap(canvas);
  return {
    bitmap,
    width: W,
    height: H,
    cornerUV: {
      u00: uv00.u, v00: uv00.v,
      u10: uv10.u, v10: uv10.v,
      u01: uv01.u, v01: uv01.v,
      u11: uv11.u, v11: uv11.v,
    },
  };
}
