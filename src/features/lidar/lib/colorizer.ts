import type { PointCloudData, DetectedCrs } from '../types';
import { toWgs84 } from './coordConvert';

const WMTS_ZOOM = 19;
const TILE_SIZE = 256;
const DEFAULT_R = 128, DEFAULT_G = 128, DEFAULT_B = 128;

// IGN — Géoplateforme orthophotos (France).
const IGN_ORTHO_URL = (z: number, x: number, y: number) =>
  `https://data.geopf.fr/wmts?SERVICE=WMTS&REQUEST=GetTile&VERSION=1.0.0&LAYER=ORTHOIMAGERY.ORTHOPHOTOS&STYLE=normal&FORMAT=image/jpeg&TILEMATRIXSET=PM&TILEMATRIX=${z}&TILEROW=${y}&TILECOL=${x}`;

// swisstopo — SWISSIMAGE (Switzerland). Public WMTS, CORS-enabled, no key.
// The 3857 matrix set uses the same Web-Mercator tile grid as IGN PM, so the
// existing wgs84→pixel math (`wgs84ToAbsPixel`) works unchanged.
// Sub-domains wmts0..9 are load-balanced; we pick one per tile to spread load.
const SWISS_ORTHO_URL = (z: number, x: number, y: number) => {
  const sub = (x + y) % 10;
  return `https://wmts${sub}.geo.admin.ch/1.0.0/ch.swisstopo.swissimage/default/current/3857/${z}/${x}/${y}.jpeg`;
};

function orthoUrlForCrs(crs: DetectedCrs, z: number, x: number, y: number): string {
  return crs === 'CH1903_LV95' ? SWISS_ORTHO_URL(z, x, y) : IGN_ORTHO_URL(z, x, y);
}

async function fetchOrthoTile(
  zoom: number,
  tileX: number,
  tileY: number,
  crs: DetectedCrs,
): Promise<Uint8Array | null> {
  try {
    const response = await fetch(orthoUrlForCrs(crs, zoom, tileX, tileY));
    if (!response.ok) return null;

    const blob = await response.blob();
    const bitmap = await createImageBitmap(blob);
    const canvas = new OffscreenCanvas(TILE_SIZE, TILE_SIZE);
    const ctx = canvas.getContext('2d')!;
    ctx.drawImage(bitmap, 0, 0, TILE_SIZE, TILE_SIZE);
    const imgData = ctx.getImageData(0, 0, TILE_SIZE, TILE_SIZE);
    bitmap.close();
    return new Uint8Array(imgData.data.buffer);
  } catch {
    return null;
  }
}

function wgs84ToAbsPixel(lon: number, lat: number, zoom: number): [number, number] {
  const n = Math.pow(2, zoom);
  const absPx = ((lon + 180) / 360) * n * TILE_SIZE;
  const latRad = (lat * Math.PI) / 180;
  const absPy = (1 - Math.log(Math.tan(latRad) + 1 / Math.cos(latRad)) / Math.PI) / 2 * n * TILE_SIZE;
  return [absPx, absPy];
}

export async function colorizePointCloud(
  pointCloud: PointCloudData,
  onProgress?: (phase: string, percent: number) => void
): Promise<void> {
  const { positions, colors, count, crs, bounds } = pointCloud;

  const [lon00, lat00] = toWgs84(bounds.minX, bounds.minY, crs);
  const [lon10, lat10] = toWgs84(bounds.maxX, bounds.minY, crs);
  const [lon01, lat01] = toWgs84(bounds.minX, bounds.maxY, crs);
  const [lon11, lat11] = toWgs84(bounds.maxX, bounds.maxY, crs);

  const [px00, py00] = wgs84ToAbsPixel(lon00, lat00, WMTS_ZOOM);
  const [px10, py10] = wgs84ToAbsPixel(lon10, lat10, WMTS_ZOOM);
  const [px01, py01] = wgs84ToAbsPixel(lon01, lat01, WMTS_ZOOM);
  const [px11, py11] = wgs84ToAbsPixel(lon11, lat11, WMTS_ZOOM);

  const invDx = 1 / (bounds.maxX - bounds.minX);
  const invDy = 1 / (bounds.maxY - bounds.minY);
  const xMin = bounds.minX;
  const yMin = bounds.minY;

  onProgress?.('Téléchargement des orthophotos...', 0);

  const allPxX = [px00, px10, px01, px11];
  const allPxY = [py00, py10, py01, py11];
  const minTileCol = Math.floor(Math.min(...allPxX) / TILE_SIZE);
  const maxTileCol = Math.floor(Math.max(...allPxX) / TILE_SIZE);
  const minTileRow = Math.floor(Math.min(...allPxY) / TILE_SIZE);
  const maxTileRow = Math.floor(Math.max(...allPxY) / TILE_SIZE);

  const tileCols = maxTileCol - minTileCol + 1;
  const tileRows = maxTileRow - minTileRow + 1;
  const tileData: (Uint8Array | null)[] = new Array(tileCols * tileRows).fill(null);

  const BATCH_SIZE = 48;
  const tileJobs: { col: number; row: number; idx: number }[] = [];
  for (let col = minTileCol; col <= maxTileCol; col++) {
    for (let row = minTileRow; row <= maxTileRow; row++) {
      const idx = (col - minTileCol) * tileRows + (row - minTileRow);
      tileJobs.push({ col, row, idx });
    }
  }

  for (let i = 0; i < tileJobs.length; i += BATCH_SIZE) {
    const batch = tileJobs.slice(i, i + BATCH_SIZE);
    const results = await Promise.all(batch.map(t => fetchOrthoTile(WMTS_ZOOM, t.col, t.row, crs)));
    for (let j = 0; j < batch.length; j++) {
      tileData[batch[j].idx] = results[j];
    }
    onProgress?.('Téléchargement des orthophotos...', Math.round(((i + batch.length) / tileJobs.length) * 50));
  }

  onProgress?.('Colorisation des points...', 50);

  const CHUNK = 1_000_000;
  const totalChunks = Math.ceil(count / CHUNK);

  for (let chunk = 0; chunk < totalChunks; chunk++) {
    const start = chunk * CHUNK;
    const end = Math.min(start + CHUNK, count);

    for (let i = start; i < end; i++) {
      const x = positions[i * 3];
      const y = positions[i * 3 + 1];

      const fx = (x - xMin) * invDx;
      const fy = (y - yMin) * invDy;
      const fx1 = 1 - fx;
      const fy1 = 1 - fy;

      const absPx = fx1 * fy1 * px00 + fx * fy1 * px10 + fx1 * fy * px01 + fx * fy * px11;
      const absPy = fx1 * fy1 * py00 + fx * fy1 * py10 + fx1 * fy * py01 + fx * fy * py11;

      const floorPx = Math.floor(absPx);
      const floorPy = Math.floor(absPy);
      const fracX = absPx - floorPx;
      const fracY = absPy - floorPy;

      const w00 = (1 - fracX) * (1 - fracY);
      const w10 = fracX * (1 - fracY);
      const w01 = (1 - fracX) * fracY;
      const w11 = fracX * fracY;

      let r = 0, g = 0, b = 0, hits = 0;
      for (let dy = 0; dy <= 1; dy++) {
        for (let dx = 0; dx <= 1; dx++) {
          const spx = floorPx + dx;
          const spy = floorPy + dy;
          const sCol = spx >> 8;
          const sRow = spy >> 8;
          const sLocalPx = spx & 255;
          const sLocalPy = spy & 255;
          const sIdx = (sCol - minTileCol) * tileRows + (sRow - minTileRow);
          if (sIdx >= 0 && sIdx < tileData.length) {
            const sPixels = tileData[sIdx];
            if (sPixels) {
              const w = dy === 0 ? (dx === 0 ? w00 : w10) : (dx === 0 ? w01 : w11);
              const pIdx = (sLocalPy * TILE_SIZE + sLocalPx) * 4;
              r += sPixels[pIdx] * w;
              g += sPixels[pIdx + 1] * w;
              b += sPixels[pIdx + 2] * w;
              hits += w;
            }
          }
        }
      }

      const ci = i * 3;
      if (hits > 0) {
        const inv = 1 / hits;
        colors[ci] = Math.round(r * inv);
        colors[ci + 1] = Math.round(g * inv);
        colors[ci + 2] = Math.round(b * inv);
      } else {
        colors[ci] = DEFAULT_R;
        colors[ci + 1] = DEFAULT_G;
        colors[ci + 2] = DEFAULT_B;
      }
    }

    const progress = 50 + Math.round(((chunk + 1) / totalChunks) * 50);
    onProgress?.('Colorisation des points...', progress);

    if (chunk < totalChunks - 1) {
      await new Promise(resolve => setTimeout(resolve, 0));
    }
  }

  onProgress?.('Colorisation terminée', 100);
}
