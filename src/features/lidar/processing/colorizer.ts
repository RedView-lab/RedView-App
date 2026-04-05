import type { PointCloudData } from '../types/tile';
import { toWgs84, wgs84ToTile, pixelInTile } from '../processing/coord-transform';
import { fetchWmtsTileBatch } from '../api/ign-wmts';

const WMTS_ZOOM = 19;
const TILE_SIZE = 256;

interface TilePixelData {
  data: Uint8ClampedArray;
  width: number;
  height: number;
}

function bitmapToPixels(bmp: ImageBitmap): TilePixelData {
  const canvas = new OffscreenCanvas(bmp.width, bmp.height);
  const ctx = canvas.getContext('2d')!;
  ctx.drawImage(bmp, 0, 0);
  const imageData = ctx.getImageData(0, 0, bmp.width, bmp.height);
  return { data: imageData.data, width: bmp.width, height: bmp.height };
}

function bilinearSample(
  pixels: TilePixelData,
  px: number,
  py: number,
): [number, number, number] {
  const x0 = Math.floor(px);
  const y0 = Math.floor(py);
  const x1 = Math.min(x0 + 1, pixels.width - 1);
  const y1 = Math.min(y0 + 1, pixels.height - 1);
  const fx = px - x0;
  const fy = py - y0;

  const i00 = (y0 * pixels.width + x0) * 4;
  const i10 = (y0 * pixels.width + x1) * 4;
  const i01 = (y1 * pixels.width + x0) * 4;
  const i11 = (y1 * pixels.width + x1) * 4;

  const d = pixels.data;
  const r = (1 - fx) * (1 - fy) * d[i00] + fx * (1 - fy) * d[i10] + (1 - fx) * fy * d[i01] + fx * fy * d[i11];
  const g = (1 - fx) * (1 - fy) * d[i00 + 1] + fx * (1 - fy) * d[i10 + 1] + (1 - fx) * fy * d[i01 + 1] + fx * fy * d[i11 + 1];
  const b = (1 - fx) * (1 - fy) * d[i00 + 2] + fx * (1 - fy) * d[i10 + 2] + (1 - fx) * fy * d[i01 + 2] + fx * fy * d[i11 + 2];

  return [Math.round(r), Math.round(g), Math.round(b)];
}

export async function colorizePointCloud(
  pc: PointCloudData,
  onProgress?: (percent: number) => void,
): Promise<PointCloudData> {
  const bounds = pc.bounds;

  const corners = [
    [bounds.minX, bounds.minY],
    [bounds.maxX, bounds.minY],
    [bounds.minX, bounds.maxY],
    [bounds.maxX, bounds.maxY],
  ] as const;

  const cornersWgs84 = corners.map(([x, y]) => toWgs84(x, y, pc.crs));

  const cornerTiles = cornersWgs84.map(([lon, lat]) => wgs84ToTile(lon, lat, WMTS_ZOOM));
  const minCol = Math.min(...cornerTiles.map(t => t.col));
  const maxCol = Math.max(...cornerTiles.map(t => t.col));
  const minRow = Math.min(...cornerTiles.map(t => t.row));
  const maxRow = Math.max(...cornerTiles.map(t => t.row));

  const tilesToFetch: Array<{ zoom: number; row: number; col: number }> = [];
  for (let row = minRow; row <= maxRow; row++) {
    for (let col = minCol; col <= maxCol; col++) {
      tilesToFetch.push({ zoom: WMTS_ZOOM, row, col });
    }
  }

  onProgress?.(5);
  const bitmaps = await fetchWmtsTileBatch(tilesToFetch);
  onProgress?.(50);

  const pixelCache = new Map<string, TilePixelData>();
  for (const [key, bmp] of bitmaps) {
    pixelCache.set(key, bitmapToPixels(bmp));
    bmp.close();
  }

  const rangeX = bounds.maxX - bounds.minX;
  const rangeY = bounds.maxY - bounds.minY;

  const c0Lon = cornersWgs84[0][0];
  const c0Lat = cornersWgs84[0][1];
  const c1Lon = cornersWgs84[1][0];
  const c1Lat = cornersWgs84[1][1];
  const c2Lon = cornersWgs84[2][0];
  const c2Lat = cornersWgs84[2][1];
  const c3Lon = cornersWgs84[3][0];
  const c3Lat = cornersWgs84[3][1];

  const newColors = new Uint8Array(pc.count * 3);
  const progressStep = Math.max(1, Math.floor(pc.count / 50));

  for (let i = 0; i < pc.count; i++) {
    const x = pc.positions[i * 3];
    const y = pc.positions[i * 3 + 1];

    const u = rangeX > 0 ? (x - bounds.minX) / rangeX : 0;
    const v = rangeY > 0 ? (y - bounds.minY) / rangeY : 0;

    const lon = (1 - u) * (1 - v) * c0Lon + u * (1 - v) * c1Lon + (1 - u) * v * c2Lon + u * v * c3Lon;
    const lat = (1 - u) * (1 - v) * c0Lat + u * (1 - v) * c1Lat + (1 - u) * v * c2Lat + u * v * c3Lat;

    const { tileCol, tileRow, px, py } = pixelInTile(lon, lat, WMTS_ZOOM, TILE_SIZE);
    const key = `${WMTS_ZOOM}_${tileRow}_${tileCol}`;
    const pixels = pixelCache.get(key);

    if (pixels) {
      const [r, g, b] = bilinearSample(pixels, px, py);
      newColors[i * 3] = r;
      newColors[i * 3 + 1] = g;
      newColors[i * 3 + 2] = b;
    } else {
      newColors[i * 3] = 128;
      newColors[i * 3 + 1] = 128;
      newColors[i * 3 + 2] = 128;
    }

    if (i % progressStep === 0) {
      onProgress?.(50 + (i / pc.count) * 50);
    }
  }

  onProgress?.(100);

  return {
    positions: pc.positions,
    colors: newColors,
    classifications: pc.classifications,
    count: pc.count,
    bounds: pc.bounds,
    crs: pc.crs,
  };
}
