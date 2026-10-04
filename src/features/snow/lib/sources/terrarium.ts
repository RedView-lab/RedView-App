// ============================================================================
// Snow sources — coarse DEM from the AWS Terrarium tiles (browser only)
// ----------------------------------------------------------------------------
// Two uses: the model orography of every AROME cell (mean ground height over
// the cell, slightly widened like the model's smoothed orography) and the
// far-field DEM around the LiDAR scene (horizons, outlying wind shelter,
// drift inflow). Terrarium: height = R·256 + G + B/256 − 32768 (m).
// ============================================================================

import type { SceneFrame } from '../engine/grid';
import type { CoarseSnowGrid, FarDem } from '../engine/types';

const TERRARIUM_BASE = 'https://s3.amazonaws.com/elevation-tiles-prod/terrarium';
const TILE = 256;

interface TileMosaic {
  zoom: number;
  x0: number;
  y0: number;
  cols: number;
  rows: number;
  /** Heights, (rows·256) × (cols·256), NaN where a tile failed. */
  data: Float32Array;
}

function lonToX(lon: number, zoom: number): number {
  return ((lon + 180) / 360) * 2 ** zoom;
}

function latToY(lat: number, zoom: number): number {
  const s = Math.sin((lat * Math.PI) / 180);
  return (0.5 - Math.log((1 + s) / (1 - s)) / (4 * Math.PI)) * 2 ** zoom;
}

async function decodeTile(blob: Blob): Promise<Float32Array> {
  const bitmap = await createImageBitmap(blob, { premultiplyAlpha: 'none', colorSpaceConversion: 'none' });
  const canvas = new OffscreenCanvas(TILE, TILE);
  const ctx = canvas.getContext('2d', { willReadFrequently: true });
  if (!ctx) throw new Error('2D context unavailable');
  ctx.drawImage(bitmap, 0, 0);
  bitmap.close();
  const px = ctx.getImageData(0, 0, TILE, TILE).data;
  const out = new Float32Array(TILE * TILE);
  for (let i = 0; i < out.length; i++) out[i] = px[i * 4] * 256 + px[i * 4 + 1] + px[i * 4 + 2] / 256 - 32768;
  return out;
}

async function loadMosaic(lonMin: number, latMin: number, lonMax: number, latMax: number, zoom: number, signal?: AbortSignal): Promise<TileMosaic> {
  const x0 = Math.floor(lonToX(lonMin, zoom));
  const x1 = Math.floor(lonToX(lonMax, zoom));
  const y0 = Math.floor(latToY(latMax, zoom));
  const y1 = Math.floor(latToY(latMin, zoom));
  const cols = x1 - x0 + 1;
  const rows = y1 - y0 + 1;
  if (cols * rows > 36) throw new Error(`too many DEM tiles (${cols}×${rows})`);
  const data = new Float32Array(cols * rows * TILE * TILE).fill(Number.NaN);
  const width = cols * TILE;
  await Promise.all(Array.from({ length: cols * rows }, async (_, k) => {
    const tx = x0 + (k % cols);
    const ty = y0 + Math.floor(k / cols);
    try {
      const res = await fetch(`${TERRARIUM_BASE}/${zoom}/${tx}/${ty}.png`, { signal });
      if (!res.ok) return;
      const tile = await decodeTile(await res.blob());
      const ox = (tx - x0) * TILE;
      const oy = (ty - y0) * TILE;
      for (let r = 0; r < TILE; r++) data.set(tile.subarray(r * TILE, (r + 1) * TILE), (oy + r) * width + ox);
    } catch (err) {
      if (signal?.aborted) throw err;
    }
  }));
  return { zoom, x0, y0, cols, rows, data };
}

/** Bilinear height at a WGS84 point, NaN outside the mosaic or on a missing tile. */
function heightAt(m: TileMosaic, lon: number, lat: number): number {
  const px = (lonToX(lon, m.zoom) - m.x0) * TILE - 0.5;
  const py = (latToY(lat, m.zoom) - m.y0) * TILE - 0.5;
  const w = m.cols * TILE;
  const h = m.rows * TILE;
  if (px < 0 || py < 0 || px > w - 1 || py > h - 1) return Number.NaN;
  const x = Math.min(w - 2, Math.floor(px));
  const y = Math.min(h - 2, Math.floor(py));
  const tx = px - x;
  const ty = py - y;
  const i = y * w + x;
  const a = m.data[i] + (m.data[i + 1] - m.data[i]) * tx;
  const b = m.data[i + w] + (m.data[i + w + 1] - m.data[i + w]) * tx;
  return a + (b - a) * ty;
}

export function terrariumSupported(): boolean {
  return typeof OffscreenCanvas !== 'undefined' && typeof createImageBitmap === 'function';
}

/** Mean ground height of every coarse cell (5 × 5 samples over 1.5 cell), NaN where unknown. */
export async function coarseOrography(coarse: CoarseSnowGrid, signal?: AbortSignal): Promise<Float32Array> {
  const halfLon = coarse.dLon * 0.75;
  const halfLat = coarse.dLat * 0.75;
  const lonMax = coarse.lonMin + (coarse.width - 1) * coarse.dLon;
  const latMax = coarse.latMin + (coarse.height - 1) * coarse.dLat;
  // ~200 m pixels for 0.01° cells, coarser for coarser grids.
  const zoom = coarse.dLon >= 0.05 ? 8 : 9;
  const mosaic = await loadMosaic(coarse.lonMin - halfLon, coarse.latMin - halfLat, lonMax + halfLon, latMax + halfLat, zoom, signal);
  const out = new Float32Array(coarse.width * coarse.height);
  for (let j = 0; j < coarse.height; j++) {
    for (let i = 0; i < coarse.width; i++) {
      const lon = coarse.lonMin + i * coarse.dLon;
      const lat = coarse.latMin + j * coarse.dLat;
      let sum = 0;
      let n = 0;
      for (let b = -2; b <= 2; b++) {
        for (let a = -2; a <= 2; a++) {
          const v = heightAt(mosaic, lon + (a / 2) * halfLon, lat + (b / 2) * halfLat);
          if (Number.isFinite(v)) { sum += v; n++; }
        }
      }
      out[j * coarse.width + i] = n >= 13 ? sum / n : Number.NaN;
    }
  }
  return out;
}

/** Far-field DEM: `marginM` around the scene, `cellM` spacing, scene-local metres. */
export async function farFieldDem(frame: SceneFrame, sizeX: number, sizeY: number, marginM: number, cellM: number, signal?: AbortSignal): Promise<FarDem | null> {
  const width = Math.round((sizeX + 2 * marginM) / cellM) + 1;
  const height = Math.round((sizeY + 2 * marginM) / cellM) + 1;
  const corners = [
    frame.lonLatAt(-marginM / sizeX, -marginM / sizeY),
    frame.lonLatAt(1 + marginM / sizeX, -marginM / sizeY),
    frame.lonLatAt(1 + marginM / sizeX, 1 + marginM / sizeY),
    frame.lonLatAt(-marginM / sizeX, 1 + marginM / sizeY),
  ];
  const lons = corners.map((c) => c.lon);
  const lats = corners.map((c) => c.lat);
  const mosaic = await loadMosaic(Math.min(...lons), Math.min(...lats), Math.max(...lons), Math.max(...lats), 11, signal);
  const data = new Float32Array(width * height);
  let missing = 0;
  for (let j = 0; j < height; j++) {
    for (let i = 0; i < width; i++) {
      const p = frame.lonLatAt((i * cellM - marginM) / sizeX, (j * cellM - marginM) / sizeY);
      const v = heightAt(mosaic, p.lon, p.lat);
      if (!Number.isFinite(v)) missing++;
      data[j * width + i] = v;
    }
  }
  if (missing > 0.2 * data.length) return null;
  if (missing > 0) {
    let s = 0, n = 0;
    for (const v of data) if (Number.isFinite(v)) { s += v; n++; }
    const mean = n > 0 ? s / n : 0;
    for (let i = 0; i < data.length; i++) if (!Number.isFinite(data[i])) data[i] = mean;
  }
  return { data, width, height, originX: -marginM, originY: -marginM, cell: cellM };
}
