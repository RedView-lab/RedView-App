import type { VercelRequest, VercelResponse } from '@vercel/node';

// ---------------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------------

const IGN_WMTS_BASE = 'https://data.geopf.fr/wmts';
const IGN_DEM_LAYER = 'ELEVATION.ELEVATIONGRIDCOVERAGE.HIGHRES.MNS';
const IGN_DEM_TILEMATRIXSET = 'WGS84G_4_17';
const IGN_DEM_FORMAT = 'image/x-bil;bits=32';

const FRANCE_BOUNDS: [number, number, number, number] = [-5.5, 41.0, 10.0, 51.5];
const DEM_TILE_SIZE = 256;
const DEM_NODATA_THRESHOLD = -10000;
const IGN_DEM_MINZOOM = 4;
const IGN_DEM_MAXZOOM = 17;

// ---------------------------------------------------------------------------
// In-memory caches
// ---------------------------------------------------------------------------

const pngCache = new Map<string, Buffer>();
const ignTileCache = new Map<string, Float32Array | null>();
const PNG_CACHE_MAX = 2500;
const IGN_CACHE_MAX = 1200;

function evict<T>(cache: Map<string, T>, max: number) {
  if (cache.size <= max) return;
  const iter = cache.keys();
  const toDelete = cache.size - Math.floor(max * 0.75);
  for (let i = 0; i < toDelete; i++) {
    const k = iter.next().value;
    if (k !== undefined) cache.delete(k);
  }
}

// ---------------------------------------------------------------------------
// WMTS URL builder
// ---------------------------------------------------------------------------

function buildDEMTileURL(z: number, col: number, row: number): string {
  return (
    `${IGN_WMTS_BASE}?SERVICE=WMTS&REQUEST=GetTile&VERSION=1.0.0` +
    `&LAYER=${IGN_DEM_LAYER}&STYLE=normal` +
    `&FORMAT=${encodeURIComponent(IGN_DEM_FORMAT)}` +
    `&TILEMATRIXSET=${IGN_DEM_TILEMATRIXSET}` +
    `&TILEMATRIX=${z}&TILEROW=${row}&TILECOL=${col}`
  );
}

// ---------------------------------------------------------------------------
// Coordinate conversions
// ---------------------------------------------------------------------------

function mercatorTileBounds(z: number, x: number, y: number) {
  const n = Math.PI - (2 * Math.PI * y) / (1 << z);
  const s = Math.PI - (2 * Math.PI * (y + 1)) / (1 << z);
  return {
    west: (x / (1 << z)) * 360 - 180,
    east: ((x + 1) / (1 << z)) * 360 - 180,
    north: (Math.atan(Math.sinh(n)) * 180) / Math.PI,
    south: (Math.atan(Math.sinh(s)) * 180) / Math.PI,
  };
}

function lngLatToWGS84GTile(lng: number, lat: number, z: number) {
  const matrixWidth = 1 << (z + 1);
  const matrixHeight = 1 << z;
  return {
    col: Math.max(0, Math.min(Math.floor(((lng + 180) / 360) * matrixWidth), matrixWidth - 1)),
    row: Math.max(0, Math.min(Math.floor(((90 - lat) / 180) * matrixHeight), matrixHeight - 1)),
  };
}

function mercatorYToLat(yFrac: number): number {
  const mercY = Math.PI * (1 - 2 * yFrac);
  return (Math.atan(Math.sinh(mercY)) * 180) / Math.PI;
}

function tileOverlapsFrance(z: number, x: number, y: number): boolean {
  const b = mercatorTileBounds(z, x, y);
  const [w, s, e, n] = FRANCE_BOUNDS;
  return !(b.east < w || b.west > e || b.south > n || b.north < s);
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
// Terrain-RGB PNG encoder (pure Node, no pngjs dependency)
// ---------------------------------------------------------------------------

function encodeToPNG(width: number, height: number, rgbaData: Uint8Array): Buffer {
  // Minimal PNG encoder — IHDR + uncompressed IDAT + IEND
  const { deflateSync } = require('zlib') as typeof import('zlib');

  // Build raw scanlines (filter byte 0 = None, then RGBA pixels)
  const rawLen = height * (1 + width * 4);
  const raw = Buffer.alloc(rawLen);
  let offset = 0;
  for (let y = 0; y < height; y++) {
    raw[offset++] = 0; // filter: None
    const rowStart = y * width * 4;
    for (let i = 0; i < width * 4; i++) {
      raw[offset++] = rgbaData[rowStart + i];
    }
  }

  const compressed = deflateSync(raw, { level: 1 });

  // PNG signature
  const signature = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);

  // CRC-32 table
  const crcTable: number[] = [];
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) {
      c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    }
    crcTable[n] = c;
  }
  function crc32(buf: Buffer): number {
    let crc = 0xffffffff;
    for (let i = 0; i < buf.length; i++) {
      crc = crcTable[(crc ^ buf[i]) & 0xff] ^ (crc >>> 8);
    }
    return (crc ^ 0xffffffff) >>> 0;
  }

  function makeChunk(type: string, data: Buffer): Buffer {
    const len = Buffer.alloc(4);
    len.writeUInt32BE(data.length);
    const typeB = Buffer.from(type, 'ascii');
    const combined = Buffer.concat([typeB, data]);
    const crcB = Buffer.alloc(4);
    crcB.writeUInt32BE(crc32(combined));
    return Buffer.concat([len, combined, crcB]);
  }

  // IHDR
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8;  // bit depth
  ihdr[9] = 6;  // color type: RGBA
  ihdr[10] = 0; // compression
  ihdr[11] = 0; // filter
  ihdr[12] = 0; // interlace

  // IEND
  const iend = Buffer.alloc(0);

  return Buffer.concat([
    signature,
    makeChunk('IHDR', ihdr),
    makeChunk('IDAT', compressed),
    makeChunk('IEND', iend),
  ]);
}

function encodeTerrainRGB(elevations: Float32Array): Buffer {
  const size = DEM_TILE_SIZE;
  const rgba = new Uint8Array(size * size * 4);

  for (let i = 0; i < elevations.length; i++) {
    const height = sanitizeElevation(elevations[i]);
    const val = Math.round((height + 10000) / 0.1);
    const idx = i * 4;
    rgba[idx] = (val >> 16) & 0xff;
    rgba[idx + 1] = (val >> 8) & 0xff;
    rgba[idx + 2] = val & 0xff;
    rgba[idx + 3] = 255;
  }

  return encodeToPNG(size, size, rgba);
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
// IGN tile fetching (with cache)
// ---------------------------------------------------------------------------

async function getIGNTile(z: number, col: number, row: number): Promise<Float32Array | null> {
  const key = `${z}/${col}/${row}`;
  if (ignTileCache.has(key)) return ignTileCache.get(key) ?? null;

  const url = buildDEMTileURL(z, col, row);
  try {
    const res = await fetch(url, { signal: AbortSignal.timeout(8000) });
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
    evict(ignTileCache, IGN_CACHE_MAX);
    ignTileCache.set(key, data);
    return data;
  } catch {
    ignTileCache.set(key, null);
    return null;
  }
}

// ---------------------------------------------------------------------------
// Build IGN Terrain-RGB tile (Mercator ← WGS84G resampling)
// ---------------------------------------------------------------------------

async function buildIGNTile(mercZ: number, mercX: number, mercY: number): Promise<Buffer> {
  const demZ = Math.max(IGN_DEM_MINZOOM, Math.min(mercZ, IGN_DEM_MAXZOOM));
  const bounds = mercatorTileBounds(mercZ, mercX, mercY);
  const tl = lngLatToWGS84GTile(bounds.west, bounds.north, demZ);
  const br = lngLatToWGS84GTile(bounds.east, bounds.south, demZ);

  // Fetch all WGS84G tiles covering this Mercator tile in parallel
  const tileMap = new Map<string, Float32Array | null>();
  const promises: Promise<void>[] = [];
  for (let row = tl.row; row <= br.row; row++) {
    for (let col = tl.col; col <= br.col; col++) {
      promises.push(
        getIGNTile(demZ, col, row).then((d) => {
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

  return encodeTerrainRGB(elevations);
}

// ---------------------------------------------------------------------------
// Mapbox DEM passthrough (non-France)
// ---------------------------------------------------------------------------

async function fetchMapboxTile(z: number, x: number, y: number): Promise<Buffer | null> {
  const token = process.env.VITE_MAPBOX_TOKEN || process.env.MAPBOX_TOKEN;
  if (!token) return null;
  const url = `https://api.mapbox.com/v4/mapbox.mapbox-terrain-dem-v1/${z}/${x}/${y}.pngraw?access_token=${token}`;
  try {
    const res = await fetch(url, { signal: AbortSignal.timeout(6000) });
    if (!res.ok) return null;
    const buf = await res.arrayBuffer();
    return Buffer.from(buf);
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// Vercel Serverless Function handler
// ---------------------------------------------------------------------------

const HEADERS = {
  'Content-Type': 'image/png',
  'Cache-Control': 'public, max-age=86400, s-maxage=604800',
  'Access-Control-Allow-Origin': '*',
};

export default async function handler(req: VercelRequest, res: VercelResponse) {
  if (req.method !== 'GET') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  const { z, x, y } = req.query;
  const mercZ = parseInt(z as string, 10);
  const mercX = parseInt(x as string, 10);
  const mercY = parseInt(y as string, 10);

  if ([mercZ, mercX, mercY].some((v) => Number.isNaN(v) || v < 0)) {
    return res.status(400).json({ error: 'Invalid tile coordinates' });
  }

  // Check cache
  const cacheKey = `${mercZ}/${mercX}/${mercY}`;
  const cached = pngCache.get(cacheKey);
  if (cached) {
    for (const [k, v] of Object.entries(HEADERS)) res.setHeader(k, v);
    return res.status(200).send(cached);
  }

  let tileData: Buffer | null = null;

  if (tileOverlapsFrance(mercZ, mercX, mercY) && mercZ >= IGN_DEM_MINZOOM) {
    try {
      tileData = await buildIGNTile(mercZ, mercX, mercY);
    } catch (err) {
      console.error(`[dem] IGN build error ${cacheKey}:`, err instanceof Error ? err.message : err);
    }
  }

  if (!tileData) {
    tileData = await fetchMapboxTile(mercZ, mercX, mercY);
  }

  if (!tileData) {
    return res.status(204).end();
  }

  // Cache the result
  evict(pngCache, PNG_CACHE_MAX);
  pngCache.set(cacheKey, tileData);

  for (const [k, v] of Object.entries(HEADERS)) res.setHeader(k, v);
  return res.status(200).send(tileData);
}
