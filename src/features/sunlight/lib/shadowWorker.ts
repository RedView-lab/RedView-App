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

const DEM_TILE_SIZE = 256;
const DEM_NODATA_THRESHOLD = -10000;
const DEM_CACHE_NAME = 'dem-tiles-v27'; // must match sw-dem/config.js CACHE_NAME

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
}

interface ResetRequest {
  type: 'reset';
  id: number;
}

type Request = SampleRequest | ComputeRequest | ResetRequest;

interface GridState {
  bounds: [number, number, number, number];
  gridW: number;
  gridH: number;
  /** Float32 elevation samples, row-major, NaN for missing data. */
  elev: Float32Array;
  /** Pre-computed cell metric size (m) at the grid's mid-latitude. */
  cellSizeX: number;
  cellSizeY: number;
}

let state: GridState | null = null;

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

  // Determine which DEM tiles cover the bounds at demZoom.
  const tlTile = lngLatToMercTile(w, n, demZoom);
  const brTile = lngLatToMercTile(e, s, demZoom);
  const xMin = Math.floor(tlTile.x);
  const xMax = Math.floor(brTile.x);
  const yMin = Math.floor(tlTile.y);
  const yMax = Math.floor(brTile.y);

  // Fetch + decode all needed DEM tiles in parallel from the SW cache.
  const tileCount = (xMax - xMin + 1) * (yMax - yMin + 1);
  // Sanity bound: refuse silly requests.
  if (tileCount > 256) {
    (self as unknown as Worker).postMessage({
      id: msg.id,
      type: 'sample-ok',
      filled: 0,
      total: tileCount,
      tooMany: true,
    });
    state = null;
    return;
  }

  const cache = await caches.open(DEM_CACHE_NAME);
  type DecodedTile = { x: number; y: number; elev: Float32Array | null };
  const tiles: Promise<DecodedTile>[] = [];
  for (let ty = yMin; ty <= yMax; ty++) {
    for (let tx = xMin; tx <= xMax; tx++) {
      tiles.push(loadTile(cache, demZoom, tx, ty));
    }
  }
  const decoded = await Promise.all(tiles);

  let filled = 0;
  // For each grid cell, project to lon/lat → tile pixel → bilinear lookup.
  // Cache decoded tiles by (x,y).
  const tileMap = new Map<string, Float32Array>();
  for (const t of decoded) {
    if (t.elev && t.elev.length > 0) {
      tileMap.set(`${t.x}/${t.y}`, t.elev);
    }
  }

  // Inverse mercator: row r → lat from north→south linearly in mercator-Y.
  // We sample uniformly in mercator (matches DEM tile pixel grid → 1-1 map).
  const nMercY = latToMercY(n);
  const sMercY = latToMercY(s);
  const dMercY = (sMercY - nMercY) / gridH;
  const dLng = (e - w) / gridW;

  const nTiles = 1 << demZoom;
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
      const tileXf = ((lng + 180) / 360) * (1 << demZoom);
      const tx = Math.floor(tileXf);
      const ty = Math.floor(tileYf);
      const tile = tileMap.get(`${tx}/${ty}`);
      if (!tile) continue;
      // Pixel within the tile.
      const px = (tileXf - tx) * DEM_TILE_SIZE;
      const py = (tileYf - ty) * DEM_TILE_SIZE;
      const v = bilinearSample(tile, DEM_TILE_SIZE, DEM_TILE_SIZE, px, py);
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
  };

  (self as unknown as Worker).postMessage({
    id: msg.id,
    type: 'sample-ok',
    filled,
    total: gridW * gridH,
  });
}

async function loadTile(
  cache: Cache,
  z: number,
  x: number,
  y: number,
): Promise<{ x: number; y: number; elev: Float32Array | null }> {
  if (x < 0 || y < 0 || x >= 1 << z || y >= 1 << z) {
    return { x, y, elev: null };
  }
  const url = new URL(`/dem-tiles/${z}/${x}/${y}`, self.location.origin).toString();
  // Try the cache first; if missing, request via the SW (will trigger a build).
  let resp = await cache.match(url);
  if (!resp || resp.status !== 200) {
    try {
      resp = await fetch(url);
    } catch {
      return { x, y, elev: null };
    }
  }
  if (!resp || resp.status !== 200) {
    return { x, y, elev: null };
  }
  try {
    const blob = await resp.clone().blob();
    const elev = await decodeTerrainRGB(blob);
    return { x, y, elev };
  } catch {
    return { x, y, elev: null };
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
  const { sunAzDeg, sunAltDeg, shadowStrength, nightFloor } = msg;
  const { gridW, gridH, elev, cellSizeX, cellSizeY } = state;

  // Sun above horizon → cast shadows. Below horizon → skip the sweep, the
  // night veil alone darkens the map uniformly.
  let blurred: Uint8Array;
  if (sunAltDeg > 0) {
    const shadow = computeSweepShadow(elev, gridW, gridH, sunAzDeg, sunAltDeg, cellSizeX, cellSizeY);
    blurred = boxBlur3(shadow, gridW, gridH);
  } else {
    blurred = new Uint8Array(gridW * gridH);
  }

  const rgba = encodeShadowRgba(blurred, gridW, gridH, shadowStrength, nightFloor);
  const blob = new Blob([rawPng(gridW, gridH, rgba).buffer as ArrayBuffer], { type: 'image/png' });

  (self as unknown as Worker).postMessage(
    {
      id: msg.id,
      type: 'compute-ok',
      blob,
      bounds: state.bounds,
    },
  );
}

/**
 * O(N) horizon sweep — same algorithm as the legacy SW per-tile shadow but
 * applied once over the whole viewport grid. No padding required: shadows
 * cast from beyond the viewport edge are simply absent (acceptable: those
 * pixels are off-screen anyway and the eye doesn't track 1-pixel rim cases).
 */
function computeSweepShadow(
  elev: Float32Array,
  W: number,
  H: number,
  sunAzDeg: number,
  sunAltDeg: number,
  cellSizeX: number,
  cellSizeY: number,
): Uint8Array {
  const out = new Uint8Array(W * H);
  if (sunAltDeg <= 0) {
    out.fill(255);
    return out;
  }
  if (sunAltDeg >= 85) {
    return out; // sun overhead → no terrain shadows
  }

  const azRad = (sunAzDeg * Math.PI) / 180;
  const tanAlt = Math.tan((sunAltDeg * Math.PI) / 180);
  // Shadow propagation = away from the sun.
  const shadowDC = -Math.sin(azRad);
  const shadowDR = Math.cos(azRad);
  const absDC = Math.abs(shadowDC);
  const absDR = Math.abs(shadowDR);

  const shadowElev = new Float32Array(W * H);
  shadowElev.fill(-Infinity);

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
      for (let r = 0; r < H; r++) {
        const idx = r * W + c;
        const el = elev[idx];
        if (Number.isNaN(el)) {
          shadowElev[idx] = -Infinity;
          continue;
        }
        const predC = c - colStep;
        const predR = Math.round(r - rowShift);
        if (predC < 0 || predC >= W || predR < 0 || predR >= H) {
          shadowElev[idx] = el;
          continue;
        }
        const propagated = shadowElev[predR * W + predC] - dropPerStep;
        if (el < propagated) {
          shadowElev[idx] = propagated;
          out[idx] = 255;
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
      for (let c = 0; c < W; c++) {
        const idx = r * W + c;
        const el = elev[idx];
        if (Number.isNaN(el)) {
          shadowElev[idx] = -Infinity;
          continue;
        }
        const predR = r - rowStep;
        const predC = Math.round(c - colShift);
        if (predR < 0 || predR >= H || predC < 0 || predC >= W) {
          shadowElev[idx] = el;
          continue;
        }
        const propagated = shadowElev[predR * W + predC] - dropPerStep;
        if (el < propagated) {
          shadowElev[idx] = propagated;
          out[idx] = 255;
        } else {
          shadowElev[idx] = el;
        }
      }
    }
  }
  return out;
}

function boxBlur3(src: Uint8Array, W: number, H: number): Uint8Array {
  const out = new Uint8Array(W * H);
  for (let r = 0; r < H; r++) {
    const rMin = r > 0 ? r - 1 : 0;
    const rMax = r < H - 1 ? r + 1 : H - 1;
    for (let c = 0; c < W; c++) {
      const cMin = c > 0 ? c - 1 : 0;
      const cMax = c < W - 1 ? c + 1 : W - 1;
      let sum = 0;
      let cnt = 0;
      for (let rr = rMin; rr <= rMax; rr++) {
        for (let cc = cMin; cc <= cMax; cc++) {
          sum += src[rr * W + cc];
          cnt++;
        }
      }
      out[r * W + c] = ((sum / cnt) + 0.5) | 0;
    }
  }
  return out;
}

/**
 * Encode the shadow byte-buffer as straight black-with-alpha RGBA so the
 * resulting image can be drawn directly by Mapbox's raster layer with no
 * `raster-color` plumbing.
 */
function encodeShadowRgba(
  shadow: Uint8Array,
  W: number,
  H: number,
  shadowStrength: number,
  nightFloor: number,
): Uint8Array {
  const strength = Math.max(0, Math.min(1, shadowStrength));
  const floor = (Math.max(0, Math.min(1, nightFloor)) * 255) | 0;
  const rgba = new Uint8Array(W * H * 4);
  for (let i = 0; i < shadow.length; i++) {
    const cast = (shadow[i] * strength) | 0;
    const a = cast > floor ? cast : floor;
    if (a === 0) continue;
    const o = i * 4;
    // R,G,B already 0 → black overlay with variable alpha.
    rgba[o + 3] = a;
  }
  return rgba;
}

// ── Geo helpers (Web Mercator) ──────────────────────────────────────────

function lngLatToMercTile(lng: number, lat: number, z: number): { x: number; y: number } {
  const n = 1 << z;
  const x = ((lng + 180) / 360) * n;
  const sinLat = Math.sin((lat * Math.PI) / 180);
  const y = (0.5 - Math.log((1 + sinLat) / (1 - sinLat)) / (4 * Math.PI)) * n;
  return { x, y };
}

function latToMercY(lat: number): number {
  const sinLat = Math.sin((lat * Math.PI) / 180);
  return 0.5 - Math.log((1 + sinLat) / (1 - sinLat)) / (4 * Math.PI);
}

// ── Minimal PNG encoder (no filtering, single deflate-stored stream) ────
// Produces a valid 8-bit RGBA PNG without external deps. Suitable for our
// small viewport image. Adapted from the SW's buildRawPng to TypeScript.

function rawPng(width: number, height: number, rgba: Uint8Array): Uint8Array {
  // Build the IDAT data: scanlines prefixed with a filter-type byte (0).
  const stride = width * 4;
  const raw = new Uint8Array((stride + 1) * height);
  for (let y = 0; y < height; y++) {
    raw[y * (stride + 1)] = 0; // filter: None
    raw.set(rgba.subarray(y * stride, (y + 1) * stride), y * (stride + 1) + 1);
  }
  const compressed = deflateStored(raw);
  const adler = adler32(raw);
  // zlib wrapper
  const zlib = new Uint8Array(2 + compressed.length + 4);
  zlib[0] = 0x78;
  zlib[1] = 0x01;
  zlib.set(compressed, 2);
  zlib[zlib.length - 4] = (adler >>> 24) & 0xff;
  zlib[zlib.length - 3] = (adler >>> 16) & 0xff;
  zlib[zlib.length - 2] = (adler >>> 8) & 0xff;
  zlib[zlib.length - 1] = adler & 0xff;

  // Build PNG chunks
  const sig = new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10]);
  const ihdr = new Uint8Array(13);
  writeU32(ihdr, 0, width);
  writeU32(ihdr, 4, height);
  ihdr[8] = 8;   // bit depth
  ihdr[9] = 6;   // color type: RGBA
  ihdr[10] = 0;  // compression
  ihdr[11] = 0;  // filter
  ihdr[12] = 0;  // interlace
  const ihdrChunk = makeChunk('IHDR', ihdr);
  const idatChunk = makeChunk('IDAT', zlib);
  const iendChunk = makeChunk('IEND', new Uint8Array(0));

  const out = new Uint8Array(
    sig.length + ihdrChunk.length + idatChunk.length + iendChunk.length,
  );
  let off = 0;
  out.set(sig, off); off += sig.length;
  out.set(ihdrChunk, off); off += ihdrChunk.length;
  out.set(idatChunk, off); off += idatChunk.length;
  out.set(iendChunk, off);
  return out;
}

function writeU32(buf: Uint8Array, off: number, v: number) {
  buf[off]     = (v >>> 24) & 0xff;
  buf[off + 1] = (v >>> 16) & 0xff;
  buf[off + 2] = (v >>> 8) & 0xff;
  buf[off + 3] = v & 0xff;
}

function makeChunk(type: string, data: Uint8Array): Uint8Array {
  const out = new Uint8Array(8 + data.length + 4);
  writeU32(out, 0, data.length);
  out[4] = type.charCodeAt(0);
  out[5] = type.charCodeAt(1);
  out[6] = type.charCodeAt(2);
  out[7] = type.charCodeAt(3);
  out.set(data, 8);
  const crc = crc32(out.subarray(4, 8 + data.length));
  writeU32(out, 8 + data.length, crc);
  return out;
}

// Stored (non-compressed) DEFLATE — fastest possible encode, ~max 64 KB
// blocks. Each block: 3-bit header (last? + BTYPE=00) byte-aligned, then
// LEN, NLEN, raw bytes.
function deflateStored(data: Uint8Array): Uint8Array {
  const MAX = 0xffff;
  const blocks = Math.ceil(data.length / MAX) || 1;
  const out = new Uint8Array(blocks * 5 + data.length);
  let off = 0;
  for (let i = 0; i < blocks; i++) {
    const start = i * MAX;
    const end = Math.min(start + MAX, data.length);
    const len = end - start;
    out[off++] = i === blocks - 1 ? 0x01 : 0x00;
    out[off++] = len & 0xff;
    out[off++] = (len >>> 8) & 0xff;
    out[off++] = (~len) & 0xff;
    out[off++] = ((~len) >>> 8) & 0xff;
    out.set(data.subarray(start, end), off);
    off += len;
  }
  return out.subarray(0, off);
}

let CRC_TABLE: Uint32Array | null = null;
function crc32(buf: Uint8Array): number {
  if (!CRC_TABLE) {
    CRC_TABLE = new Uint32Array(256);
    for (let n = 0; n < 256; n++) {
      let c = n;
      for (let k = 0; k < 8; k++) c = (c & 1) ? (0xedb88320 ^ (c >>> 1)) : (c >>> 1);
      CRC_TABLE[n] = c >>> 0;
    }
  }
  let crc = 0xffffffff;
  for (let i = 0; i < buf.length; i++) crc = CRC_TABLE[(crc ^ buf[i]) & 0xff] ^ (crc >>> 8);
  return (crc ^ 0xffffffff) >>> 0;
}

function adler32(buf: Uint8Array): number {
  let a = 1;
  let b = 0;
  const MOD = 65521;
  for (let i = 0; i < buf.length; i++) {
    a = (a + buf[i]) % MOD;
    b = (b + a) % MOD;
  }
  return ((b << 16) | a) >>> 0;
}
