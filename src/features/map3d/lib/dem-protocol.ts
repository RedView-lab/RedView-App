import { addProtocol, removeProtocol } from 'mapbox-gl';
import type { ProtocolRequestParams } from 'mapbox-gl';
import {
  DEM_TILE_SIZE,
  DEM_NODATA_THRESHOLD,
  IGN_DEM_MAXZOOM,
  IGN_DEM_MINZOOM,
  FRANCE_BOUNDS,
} from './ign.config';
import {
  buildDEMTileURL,
  mercatorTileBounds,
  lngLatToWGS84GTile,
  mercatorYToLat,
} from './ign.utils';
import { getCachedTile, setCachedTile, clearExpiredSessions } from './tile-cache';

// ---------------------------------------------------------------------------
// LRU cache for raw IGN BIL tiles
// ---------------------------------------------------------------------------

const ignTileCache = new Map<string, Float32Array | null>();
const IGN_CACHE_MAX = 1200;

function evictCache() {
  if (ignTileCache.size <= IGN_CACHE_MAX) return;
  const iter = ignTileCache.keys();
  const toDelete = ignTileCache.size - Math.floor(IGN_CACHE_MAX * 0.75);
  for (let i = 0; i < toDelete; i++) {
    const k = iter.next().value;
    if (k !== undefined) ignTileCache.delete(k);
  }
}

// ---------------------------------------------------------------------------
// BIL decoder & elevation sanitizer
// ---------------------------------------------------------------------------

function decodeBIL32(buffer: ArrayBuffer): Float32Array {
  const expectedBytes = DEM_TILE_SIZE * DEM_TILE_SIZE * 4;
  if (buffer.byteLength !== expectedBytes) {
    throw new Error(`Invalid BIL size: expected ${expectedBytes}, got ${buffer.byteLength}`);
  }
  return new Float32Array(buffer);
}

function sanitizeElevation(value: number): number {
  if (Number.isNaN(value) || value < DEM_NODATA_THRESHOLD) return 0;
  return value;
}

// ---------------------------------------------------------------------------
// Terrain-RGB encoder (browser-native, no pngjs)
// ---------------------------------------------------------------------------

function encodeTerrainRGBToImageData(elevations: Float32Array): ImageData {
  const size = DEM_TILE_SIZE;
  const imageData = new ImageData(size, size);
  const data = imageData.data;

  for (let i = 0; i < elevations.length; i++) {
    const height = sanitizeElevation(elevations[i]);
    const val = Math.round((height + 10000) / 0.1);

    const idx = i * 4;
    data[idx] = (val >> 16) & 0xff;
    data[idx + 1] = (val >> 8) & 0xff;
    data[idx + 2] = val & 0xff;
    data[idx + 3] = 255;
  }

  return imageData;
}

// ---------------------------------------------------------------------------
// Bilinear interpolation
// ---------------------------------------------------------------------------

function bilinearSample(data: Float32Array, fx: number, fy: number): number {
  const x0 = Math.max(0, Math.min(Math.floor(fx), DEM_TILE_SIZE - 1));
  const y0 = Math.max(0, Math.min(Math.floor(fy), DEM_TILE_SIZE - 1));
  const x1 = Math.min(x0 + 1, DEM_TILE_SIZE - 1);
  const y1 = Math.min(y0 + 1, DEM_TILE_SIZE - 1);
  const dx = Math.max(0, fx - x0);
  const dy = Math.max(0, fy - y0);

  const v00 = sanitizeElevation(data[y0 * DEM_TILE_SIZE + x0]);
  const v10 = sanitizeElevation(data[y0 * DEM_TILE_SIZE + x1]);
  const v01 = sanitizeElevation(data[y1 * DEM_TILE_SIZE + x0]);
  const v11 = sanitizeElevation(data[y1 * DEM_TILE_SIZE + x1]);

  return v00 * (1 - dx) * (1 - dy) + v10 * dx * (1 - dy) + v01 * (1 - dx) * dy + v11 * dx * dy;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function tileOverlapsFrance(z: number, x: number, y: number): boolean {
  const b = mercatorTileBounds(z, x, y);
  const [w, s, e, n] = FRANCE_BOUNDS;
  return !(b.east < w || b.west > e || b.south > n || b.north < s);
}

async function fetchIGNTile(
  z: number,
  col: number,
  row: number,
  signal?: AbortSignal,
): Promise<Float32Array | null> {
  const key = `${z}/${col}/${row}`;

  // 1. Memory cache (fastest)
  if (ignTileCache.has(key)) return ignTileCache.get(key) ?? null;

  // 2. IndexedDB persistent cache (survives refresh within 12h session)
  const persisted = await getCachedTile(key);
  if (persisted) {
    evictCache();
    ignTileCache.set(key, persisted);
    return persisted;
  }

  // 3. Network fetch from IGN WMTS
  const url = buildDEMTileURL(z, col, row);
  try {
    const res = await fetch(url, { signal });
    if (!res.ok) {
      ignTileCache.set(key, null);
      return null;
    }
    const buf = await res.arrayBuffer();
    if (buf.byteLength !== DEM_TILE_SIZE * DEM_TILE_SIZE * 4) {
      ignTileCache.set(key, null);
      return null;
    }
    const data = decodeBIL32(buf);
    evictCache();
    ignTileCache.set(key, data);
    // Persist to IndexedDB (fire-and-forget)
    setCachedTile(key, data);
    return data;
  } catch {
    ignTileCache.set(key, null);
    return null;
  }
}

// ---------------------------------------------------------------------------
// Build IGN Terrain-RGB tile (Mercator ← WGS84G resampling)
// ---------------------------------------------------------------------------

async function buildIGNTile(
  mercZ: number,
  mercX: number,
  mercY: number,
  signal?: AbortSignal,
): Promise<ImageData> {
  const demZ = Math.max(IGN_DEM_MINZOOM, Math.min(mercZ, IGN_DEM_MAXZOOM));
  const bounds = mercatorTileBounds(mercZ, mercX, mercY);
  const tl = lngLatToWGS84GTile(bounds.west, bounds.north, demZ);
  const br = lngLatToWGS84GTile(bounds.east, bounds.south, demZ);

  // Fetch all WGS84G tiles covering this Mercator tile
  const tileMap = new Map<string, Float32Array | null>();
  const promises: Promise<void>[] = [];
  for (let row = tl.row; row <= br.row; row++) {
    for (let col = tl.col; col <= br.col; col++) {
      promises.push(
        fetchIGNTile(demZ, col, row, signal).then((d) => {
          tileMap.set(`${col}/${row}`, d);
        }),
      );
    }
  }
  await Promise.all(promises);

  // Resample WGS84G → Mercator with bilinear interpolation
  const elevations = new Float32Array(DEM_TILE_SIZE * DEM_TILE_SIZE);
  const n = 1 << mercZ;
  const matrixWidth = 1 << (demZ + 1);
  const matrixHeight = 1 << demZ;

  for (let py = 0; py < DEM_TILE_SIZE; py++) {
    const yFrac = (mercY + (py + 0.5) / DEM_TILE_SIZE) / n;
    const lat = mercatorYToLat(yFrac);

    for (let px = 0; px < DEM_TILE_SIZE; px++) {
      const xFrac = (mercX + (px + 0.5) / DEM_TILE_SIZE) / n;
      const lng = xFrac * 360 - 180;

      const col = Math.max(0, Math.min(Math.floor(((lng + 180) / 360) * matrixWidth), matrixWidth - 1));
      const row = Math.max(0, Math.min(Math.floor(((90 - lat) / 180) * matrixHeight), matrixHeight - 1));

      const tileData = tileMap.get(`${col}/${row}`);
      if (tileData) {
        const fx = (((lng + 180) / 360) * matrixWidth - col) * DEM_TILE_SIZE;
        const fy = (((90 - lat) / 180) * matrixHeight - row) * DEM_TILE_SIZE;
        elevations[py * DEM_TILE_SIZE + px] = bilinearSample(tileData, fx, fy);
      }
    }
  }

  return encodeTerrainRGBToImageData(elevations);
}

// ---------------------------------------------------------------------------
// Mapbox DEM passthrough (non-France)
// ---------------------------------------------------------------------------

async function fetchMapboxTile(
  z: number,
  x: number,
  y: number,
  token: string,
  signal?: AbortSignal,
): Promise<ArrayBuffer | null> {
  const url = `https://api.mapbox.com/v4/mapbox.mapbox-terrain-dem-v1/${z}/${x}/${y}.pngraw?access_token=${token}`;
  try {
    const res = await fetch(url, { signal });
    if (!res.ok) return null;
    return res.arrayBuffer();
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// Protocol registration
// ---------------------------------------------------------------------------

let registered = false;

export function registerDEMProtocol(token: string): void {
  if (registered) return;
  registered = true;

  // Clean up tiles from expired sessions (fire-and-forget)
  clearExpiredSessions();

  addProtocol('igndem', async (params: ProtocolRequestParams, abortController: AbortController) => {
    const parts = params.url.replace('igndem://', '').split('/');
    const mercZ = parseInt(parts[0], 10);
    const mercX = parseInt(parts[1], 10);
    const mercY = parseInt(parts[2], 10);

    if ([mercZ, mercX, mercY].some((v) => Number.isNaN(v) || v < 0)) {
      return { data: null };
    }

    const signal = abortController.signal;

    // France tiles → IGN MNS (0.42m/px)
    if (tileOverlapsFrance(mercZ, mercX, mercY) && mercZ >= IGN_DEM_MINZOOM) {
      try {
        const imageData = await buildIGNTile(mercZ, mercX, mercY, signal);
        const bitmap = await createImageBitmap(imageData);
        return { data: bitmap };
      } catch (err) {
        if (signal.aborted) return { data: null };
        console.error('[dem-protocol] IGN build error:', err);
      }
    }

    // Non-France or IGN failed → proxy Mapbox DEM
    const mapboxData = await fetchMapboxTile(mercZ, mercX, mercY, token, signal);
    if (!mapboxData) return { data: null };

    const blob = new Blob([mapboxData], { type: 'image/png' });
    const bitmap = await createImageBitmap(blob);
    return { data: bitmap };
  });
}

export function unregisterDEMProtocol(): void {
  if (!registered) return;
  removeProtocol('igndem');
  registered = false;
}
