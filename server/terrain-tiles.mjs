/**
 * Server-Side Elevation, Slope & Altitude Tile Processor
 *
 * Provides raster tiles for:
 *   - /slope-tiles/:z/:x/:y   (Horn 3x3 derivative -> 1-channel sqrt-gamma PNG)
 *   - /altitude-tiles/:z/:x/:y (Terrarium -> Terrain-RGB conversion -> PNG)
 *   - /dem-tiles/:z/:x/:y      (Terrain-RGB fallback for 3D terrain)
 *
 * Operates standalone with node:zlib without external dependencies.
 * Ensures 100% functionality on plain HTTP production environments (where Service Workers are disabled by browsers)
 * as well as during cold-start hydration before Service Worker claims.
 */
import { inflateSync, deflateSync, crc32 } from 'node:zlib';

const AWS_TERRAIN_BASE = 'https://s3.amazonaws.com/elevation-tiles-prod/terrarium';
const AWS_TERRAIN_MAXZOOM = 14;

// In-memory LRU caches
const RAW_TERRARIUM_CACHE = new Map();
const SLOPE_CACHE = new Map();
const ALTITUDE_CACHE = new Map();
const MAX_CACHE_ITEMS = 1024;
const MAX_RAW_CACHE_ITEMS = 512;

const INFLIGHT_RAW = new Map();
const INFLIGHT_SLOPE = new Map();
const INFLIGHT_ALTITUDE = new Map();

function setLru(cache, key, value, maxItems = MAX_CACHE_ITEMS) {
  if (cache.has(key)) cache.delete(key);
  cache.set(key, value);
  while (cache.size > maxItems) {
    const firstKey = cache.keys().next().value;
    if (firstKey !== undefined) cache.delete(firstKey);
    else break;
  }
}

function makeChunk(typeStr, dataBuf) {
  const typeBuf = Buffer.from(typeStr, 'ascii');
  const lenBuf = Buffer.alloc(4);
  lenBuf.writeUInt32BE(dataBuf.length, 0);
  const toCrc = Buffer.concat([typeBuf, dataBuf]);
  const crc = crc32(toCrc);
  const crcBuf = Buffer.alloc(4);
  crcBuf.writeUInt32BE(crc, 0);
  return Buffer.concat([lenBuf, toCrc, crcBuf]);
}

function buildPngFromScanlines(width, height, rawScanlines) {
  const deflated = deflateSync(rawScanlines, { level: 1 });
  const ihdrData = Buffer.alloc(13);
  ihdrData.writeUInt32BE(width, 0);
  ihdrData.writeUInt32BE(height, 4);
  ihdrData[8] = 8; // depth 8
  ihdrData[9] = 6; // RGBA
  ihdrData[10] = 0;
  ihdrData[11] = 0;
  ihdrData[12] = 0;

  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    makeChunk('IHDR', ihdrData),
    makeChunk('IDAT', deflated),
    makeChunk('IEND', Buffer.alloc(0)),
  ]);
}

const TRANSPARENT_1X1_PNG = Buffer.from([
  0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a,
  0x00, 0x00, 0x00, 0x0d, 0x49, 0x48, 0x44, 0x52,
  0x00, 0x00, 0x00, 0x01, 0x00, 0x00, 0x00, 0x01,
  0x08, 0x06, 0x00, 0x00, 0x00, 0x1f, 0x15, 0xc4,
  0x89, 0x00, 0x00, 0x00, 0x0a, 0x49, 0x44, 0x41,
  0x74, 0x78, 0x9c, 0x63, 0x00, 0x01, 0x00, 0x00,
  0x05, 0x00, 0x01, 0x0d, 0x0a, 0x2d, 0xb4, 0x00,
  0x00, 0x00, 0x00, 0x49, 0x45, 0x4e, 0x44, 0xae,
  0x42, 0x60, 0x82,
]);

function upsampleElevations(parentElev, pZ, pX, pY, tZ, tX, tY, size = 256) {
  const dz = tZ - pZ;
  const nChildren = 1 << dz;
  const childX = tX - (pX << dz);
  const childY = tY - (pY << dz);

  const srcSize = size / nChildren;
  const srcX0 = childX * srcSize;
  const srcY0 = childY * srcSize;

  const out = new Float32Array(size * size);
  for (let py = 0; py < size; py++) {
    const sy = srcY0 + (py + 0.5) * (srcSize / size) - 0.5;
    const y0 = Math.max(0, Math.min(size - 1, Math.floor(sy)));
    const y1 = Math.max(0, Math.min(size - 1, y0 + 1));
    const ty = Math.max(0, Math.min(1, sy - y0));

    for (let px = 0; px < size; px++) {
      const sx = srcX0 + (px + 0.5) * (srcSize / size) - 0.5;
      const x0 = Math.max(0, Math.min(size - 1, Math.floor(sx)));
      const x1 = Math.max(0, Math.min(size - 1, x0 + 1));
      const tx = Math.max(0, Math.min(1, sx - x0));

      const v00 = parentElev[y0 * size + x0];
      const v10 = parentElev[y0 * size + x1];
      const v01 = parentElev[y1 * size + x0];
      const v11 = parentElev[y1 * size + x1];

      out[py * size + px] = (v00 * (1 - tx) + v10 * tx) * (1 - ty) + (v01 * (1 - tx) + v11 * tx) * ty;
    }
  }
  return out;
}

async function fetchRawTerrariumRgb(fetchZ, fetchX, fetchY) {
  const rawKey = `${fetchZ}/${fetchX}/${fetchY}`;
  if (RAW_TERRARIUM_CACHE.has(rawKey)) return RAW_TERRARIUM_CACHE.get(rawKey);
  if (INFLIGHT_RAW.has(rawKey)) return INFLIGHT_RAW.get(rawKey);

  const work = (async () => {
    try {
      const url = `${AWS_TERRAIN_BASE}/${fetchZ}/${fetchX}/${fetchY}.png`;
      const res = await fetch(url, { signal: AbortSignal.timeout(6000) });
      if (!res.ok) return null;

      const arrayBuf = await res.arrayBuffer();
      const buf = Buffer.from(arrayBuf);

      let offset = 8;
      const idatParts = [];
      while (offset < buf.length) {
        const len = buf.readUInt32BE(offset);
        const type = buf.slice(offset + 4, offset + 8).toString('ascii');
        if (type === 'IDAT') idatParts.push(buf.slice(offset + 8, offset + 8 + len));
        offset += 12 + len;
      }
      if (idatParts.length === 0) return null;

      const inflated = inflateSync(Buffer.concat(idatParts));
      const width = 256;
      const height = 256;
      const bpp = 3;
      const rowBytes = 1 + width * bpp;

      if (inflated.length !== height * rowBytes) return null;

      const rgb = new Uint8Array(width * height * 3);
      for (let row = 0; row < height; row++) {
        const filter = inflated[row * rowBytes];
        const srcRow = row * rowBytes + 1;
        const dstRow = row * width * 3;
        const prevDstRow = (row - 1) * width * 3;

        for (let col = 0; col < width * 3; col++) {
          const byte = inflated[srcRow + col];
          const a = col >= bpp ? rgb[dstRow + col - bpp] : 0;
          const b = row > 0 ? rgb[prevDstRow + col] : 0;
          const c = (col >= bpp && row > 0) ? rgb[prevDstRow + col - bpp] : 0;

          let val = 0;
          if (filter === 0) val = byte;
          else if (filter === 1) val = (byte + a) & 0xff;
          else if (filter === 2) val = (byte + b) & 0xff;
          else if (filter === 3) val = (byte + Math.floor((a + b) / 2)) & 0xff;
          else if (filter === 4) {
            const p = a + b - c;
            const pa = Math.abs(p - a);
            const pb = Math.abs(p - b);
            const pc = Math.abs(p - c);
            val = (byte + ((pa <= pb && pa <= pc) ? a : (pb <= pc ? b : c))) & 0xff;
          }
          rgb[dstRow + col] = val;
        }
      }

      setLru(RAW_TERRARIUM_CACHE, rawKey, rgb, MAX_RAW_CACHE_ITEMS);
      return rgb;
    } catch {
      return null;
    } finally {
      INFLIGHT_RAW.delete(rawKey);
    }
  })();

  INFLIGHT_RAW.set(rawKey, work);
  return work;
}

async function getElevationGrid(z, x, y) {
  const fetchZ = Math.min(z, AWS_TERRAIN_MAXZOOM);
  const fetchX = fetchZ < z ? x >> (z - fetchZ) : x;
  const fetchY = fetchZ < z ? y >> (z - fetchZ) : y;

  const rgb = await fetchRawTerrariumRgb(fetchZ, fetchX, fetchY);
  if (!rgb) return null;

  const width = 256;
  const height = 256;
  let elev = new Float32Array(width * height);
  for (let i = 0; i < width * height; i++) {
    elev[i] = (rgb[i * 3] * 256 + rgb[i * 3 + 1] + rgb[i * 3 + 2] / 256) - 32768;
  }

  if (fetchZ < z) {
    elev = upsampleElevations(elev, fetchZ, fetchX, fetchY, z, x, y, width);
  }

  return elev;
}

/**
 * Generate Slope PNG tile (/slope-tiles/:z/:x/:y)
 * Horn 3x3 algorithm encoded as 1-channel sqrt-gamma PNG.
 */
export async function generateSlopeTile(z, x, y) {
  const cacheKey = `${z}/${x}/${y}`;
  if (SLOPE_CACHE.has(cacheKey)) return SLOPE_CACHE.get(cacheKey);
  if (INFLIGHT_SLOPE.has(cacheKey)) return INFLIGHT_SLOPE.get(cacheKey);

  const work = (async () => {
    try {
      const elev = await getElevationGrid(z, x, y);
      if (!elev) return TRANSPARENT_1X1_PNG;

      const width = 256;
      const height = 256;

      // Compute Mercator ground pixel size at tile latitude
      const n = Math.PI - 2 * Math.PI * (y + 0.5) / (1 << z);
      const latRad = Math.atan(0.5 * (Math.exp(n) - Math.exp(-n)));
      const cellSize = (40075016.686 * Math.abs(Math.cos(latRad))) / (256 * (1 << z));
      const inv8 = 1.0 / (8.0 * cellSize);

      // Raw scanline buffer: filter byte (0) + 256 * 4 RGBA bytes per row
      const outRgba = new Uint8Array(height * (1 + width * 4));
      for (let r = 0; r < height; r++) {
        const rowOff = r * (1 + width * 4);
        outRgba[rowOff] = 0; // Filter 0 (None)
        const rPrev = Math.max(0, r - 1);
        const rNext = Math.min(height - 1, r + 1);

        for (let c = 0; c < width; c++) {
          const cPrev = Math.max(0, c - 1);
          const cNext = Math.min(width - 1, c + 1);

          const z_nw = elev[rPrev * width + cPrev];
          const z_n  = elev[rPrev * width + c];
          const z_ne = elev[rPrev * width + cNext];
          const z_w  = elev[r * width + cPrev];
          const z_e  = elev[r * width + cNext];
          const z_sw = elev[rNext * width + cPrev];
          const z_s  = elev[rNext * width + c];
          const z_se = elev[rNext * width + cNext];

          const dzdx = ((z_ne + 2 * z_e + z_se) - (z_nw + 2 * z_w + z_sw)) * inv8;
          const dzdy = ((z_sw + 2 * z_s + z_se) - (z_nw + 2 * z_n + z_ne)) * inv8;
          const deg = Math.atan(Math.sqrt(dzdx * dzdx + dzdy * dzdy)) * (180 / Math.PI);

          // Sqrt-gamma perceptual encoding: R = round(sqrt(deg / 90) * 255)
          const code = Math.round(Math.sqrt(Math.max(0, Math.min(90, deg)) / 90.0) * 255.0);

          const pxOff = rowOff + 1 + c * 4;
          outRgba[pxOff]     = code;
          outRgba[pxOff + 1] = 0;
          outRgba[pxOff + 2] = 0;
          outRgba[pxOff + 3] = 255;
        }
      }

      const png = buildPngFromScanlines(width, height, outRgba);
      setLru(SLOPE_CACHE, cacheKey, png);
      return png;
    } catch (err) {
      console.error(`[terrain-tiles] Slope tile failed ${z}/${x}/${y}:`, err);
      return TRANSPARENT_1X1_PNG;
    } finally {
      INFLIGHT_SLOPE.delete(cacheKey);
    }
  })();

  INFLIGHT_SLOPE.set(cacheKey, work);
  return work;
}

/**
 * Generate Altitude / DEM Terrain-RGB PNG tile (/altitude-tiles/:z/:x/:y or /dem-tiles/:z/:x/:y)
 * Converts Terrarium H to Terrain-RGB encoded PNG.
 */
export async function generateAltitudeTile(z, x, y) {
  const cacheKey = `${z}/${x}/${y}`;
  if (ALTITUDE_CACHE.has(cacheKey)) return ALTITUDE_CACHE.get(cacheKey);
  if (INFLIGHT_ALTITUDE.has(cacheKey)) return INFLIGHT_ALTITUDE.get(cacheKey);

  const work = (async () => {
    try {
      const elev = await getElevationGrid(z, x, y);
      if (!elev) return TRANSPARENT_1X1_PNG;

      const width = 256;
      const height = 256;
      const outRgba = new Uint8Array(height * (1 + width * 4));

      for (let r = 0; r < height; r++) {
        const rowOff = r * (1 + width * 4);
        outRgba[rowOff] = 0; // Filter 0 (None)

        for (let c = 0; c < width; c++) {
          const H = elev[r * width + c];
          // Terrain-RGB formula: (H + 10000) * 10
          const val = Math.max(0, Math.min(16777215, Math.round((H + 10000) * 10)));

          const pxOff = rowOff + 1 + c * 4;
          outRgba[pxOff]     = (val >> 16) & 0xff;
          outRgba[pxOff + 1] = (val >> 8) & 0xff;
          outRgba[pxOff + 2] = val & 0xff;
          outRgba[pxOff + 3] = 255;
        }
      }

      const png = buildPngFromScanlines(width, height, outRgba);
      setLru(ALTITUDE_CACHE, cacheKey, png);
      return png;
    } catch (err) {
      console.error(`[terrain-tiles] Altitude tile failed ${z}/${x}/${y}:`, err);
      return TRANSPARENT_1X1_PNG;
    } finally {
      INFLIGHT_ALTITUDE.delete(cacheKey);
    }
  })();

  INFLIGHT_ALTITUDE.set(cacheKey, work);
  return work;
}
