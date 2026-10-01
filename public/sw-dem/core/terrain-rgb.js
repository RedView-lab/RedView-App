// ---------------------------------------------------------------------------
// Terrain-RGB PNG encoding & decoding
// Uses a raw PNG encoder to avoid OffscreenCanvas color-management (sRGB
// gamma / ICC profiles) which corrupts the exact pixel values needed by
// Mapbox's raster-color-mix decode.
// ---------------------------------------------------------------------------

// ── Raw PNG encoder ───────────────────────────────────────────────────
// Builds a minimal valid PNG from an RGBA Uint8Array without any canvas
// involvement. Guarantees bit-exact pixel values and no embedded ICC profile.

function _pngCrc32Table() {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c;
  }
  return t;
}
const _CRC_TABLE = _pngCrc32Table();

function _pngCrc(buf, start, len) {
  let c = 0xffffffff;
  for (let i = start; i < start + len; i++) c = _CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function _pngChunk(type, data) {
  // chunk = length(4) + type(4) + data(N) + crc(4)
  const len = data.length;
  const buf = new Uint8Array(12 + len);
  const view = new DataView(buf.buffer);
  view.setUint32(0, len);
  buf[4] = type.charCodeAt(0);
  buf[5] = type.charCodeAt(1);
  buf[6] = type.charCodeAt(2);
  buf[7] = type.charCodeAt(3);
  buf.set(data, 8);
  view.setUint32(8 + len, _pngCrc(buf, 4, 4 + len));
  return buf;
}

async function buildRawPng(width, height, rgba) {
  // Build raw scanlines: filter-byte(0) + row RGBA data per row.
  // `set(subarray)` is a native memcpy — ~10x faster than a JS byte loop.
  const rowLen = width * 4;
  const rowBytes = 1 + rowLen;
  const raw = new Uint8Array(height * rowBytes);
  for (let y = 0; y < height; y++) {
    const off = y * rowBytes;
    const srcOff = y * rowLen;
    raw[off] = 0; // filter: None
    raw.set(rgba.subarray(srcOff, srcOff + rowLen), off + 1);
  }
  return buildPngFromScanlines(width, height, raw);
}

// Assemble a PNG from pre-built scanlines (filter byte + row data).
// `colorType`: 6 = RGBA (default), 4 = gray + alpha.
async function buildPngFromScanlines(width, height, raw, colorType = 6) {
  // Compress with deflate via CompressionStream
  const cs = new CompressionStream('deflate');
  const writer = cs.writable.getWriter();
  writer.write(raw);
  writer.close();
  const compressed = await new Response(cs.readable).arrayBuffer();
  const compData = new Uint8Array(compressed);

  // PNG signature
  const sig = new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10]);

  // IHDR: width, height, bit-depth 8, color-type 6 (RGBA)
  const ihdrData = new Uint8Array(13);
  const ihdrView = new DataView(ihdrData.buffer);
  ihdrView.setUint32(0, width);
  ihdrView.setUint32(4, height);
  ihdrData[8] = 8;  // bit depth
  ihdrData[9] = colorType;
  ihdrData[10] = 0; // compression
  ihdrData[11] = 0; // filter
  ihdrData[12] = 0; // interlace
  const ihdr = _pngChunk('IHDR', ihdrData);

  // IDAT
  const idat = _pngChunk('IDAT', compData);

  // IEND
  const iend = _pngChunk('IEND', new Uint8Array(0));

  // Assemble
  const png = new Uint8Array(sig.length + ihdr.length + idat.length + iend.length);
  let pos = 0;
  png.set(sig, pos); pos += sig.length;
  png.set(ihdr, pos); pos += ihdr.length;
  png.set(idat, pos); pos += idat.length;
  png.set(iend, pos);

  return new Blob([png], { type: 'image/png' });
}

// ── Gray + alpha PNG (colour type 4, Sub filter) ──────────────────────
// Slope tiles carry ONE meaningful byte per pixel (the sqrt-gamma angle) plus
// the NoData / zone alpha: half the scanline bytes of RGBA, so deflate runs on
// half the data. Image decoders expand it to RGBA with R = G = B = gray, which
// is exactly what Mapbox's raster-color-mix [90, 0, 0, 0] reads.
async function buildGrayAlphaPng(width, height, gray, alpha) {
  const rowBytes = 1 + width * 2;
  const raw = new Uint8Array(height * rowBytes);
  for (let y = 0; y < height; y++) {
    const off = y * rowBytes;
    const src = y * width;
    raw[off] = 1; // filter type: Sub (residual vs the previous pixel)
    let prevGray = 0;
    let prevAlpha = 0;
    for (let x = 0; x < width; x++) {
      const g = gray[src + x];
      const a = alpha[src + x];
      const o = off + 1 + x * 2;
      raw[o] = (g - prevGray) & 0xff;
      raw[o + 1] = (a - prevAlpha) & 0xff;
      prevGray = g;
      prevAlpha = a;
    }
  }
  return buildPngFromScanlines(width, height, raw, 4);
}

// ── Gray PNG (colour type 0, Paeth filter) ────────────────────────────
// Fully opaque single-channel tile (the usual slope tile): one byte per
// pixel. Paeth predicts from the left, upper and upper-left pixels, which
// suits the smooth 2D field of an upsampled slope raster: measured on a
// 512² LiDAR-like tile, 15 ms / 121 KB vs 27 ms / 147 KB for gray+alpha Sub.
async function buildGrayPng(width, height, gray) {
  const rowBytes = 1 + width;
  const raw = new Uint8Array(height * rowBytes);
  for (let y = 0; y < height; y++) {
    const off = y * rowBytes;
    const row = y * width;
    const up = row - width;
    raw[off] = 4; // filter type: Paeth
    for (let x = 0; x < width; x++) {
      const a = x > 0 ? gray[row + x - 1] : 0;
      const b = y > 0 ? gray[up + x] : 0;
      const c = x > 0 && y > 0 ? gray[up + x - 1] : 0;
      const p = a + b - c;
      const pa = p > a ? p - a : a - p;
      const pb = p > b ? p - b : b - p;
      const pc = p > c ? p - c : c - p;
      const pred = (pa <= pb && pa <= pc) ? a : (pb <= pc ? b : c);
      raw[off + 1 + x] = (gray[row + x] - pred) & 0xff;
    }
  }
  return buildPngFromScanlines(width, height, raw, 0);
}

// ── Slope-optimised PNG encoder (RGBA, Sub filter) ────────────────────
// Dedicated fast path for slope tiles. The DEM/altitude encoders still use
// buildRawPng (filter 0 = None) because they encode THREE meaningful bytes
// per pixel that don't benefit much from prediction. Slope tiles are
// essentially single-channel smooth gradients — every pixel is highly
// correlated with its left neighbour — so applying the PNG Sub filter
// (filter type 1) converts the scanline into near-zero residuals that
// deflate compresses in a fraction of the time and to a fraction of the
// size. On a typical 256×256 slope tile:
//   filter 0 (None)  → ~6-12 KB after deflate, ~3-6 ms CPU
//   filter 1 (Sub)   → ~2-4 KB after deflate, ~1-2 ms CPU
// The decoder (Mapbox raster source, browser PNG decoder) handles every
// standard PNG filter transparently, so no client-side change is needed.
async function buildRawPngSlope(width, height, rgba) {
  const rowBytes = 1 + width * 4;
  const raw = new Uint8Array(height * rowBytes);
  // Sub filter (type 1): residual = byte - byte_four_bytes_back (same channel
  // of the previous pixel). 4 channels → stride 4. Bound check on the first
  // pixel of each row (no left neighbour → residual = raw value).
  for (let y = 0; y < height; y++) {
    const off = y * rowBytes;
    const srcRow = y * width * 4;
    raw[off] = 1; // filter type: Sub
    // First pixel of the row: no left neighbour → store as-is.
    raw[off + 1] = rgba[srcRow];
    raw[off + 2] = rgba[srcRow + 1];
    raw[off + 3] = rgba[srcRow + 2];
    raw[off + 4] = rgba[srcRow + 3];
    // Remaining pixels: subtract the byte 4 positions back.
    for (let x = 4; x < width * 4; x++) {
      raw[off + 1 + x] = (rgba[srcRow + x] - rgba[srcRow + x - 4]) & 0xff;
    }
  }

  const cs = new CompressionStream('deflate');
  const writer = cs.writable.getWriter();
  writer.write(raw);
  writer.close();
  const compressed = await new Response(cs.readable).arrayBuffer();
  const compData = new Uint8Array(compressed);

  const sig = new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10]);
  const ihdrData = new Uint8Array(13);
  const ihdrView = new DataView(ihdrData.buffer);
  ihdrView.setUint32(0, width);
  ihdrView.setUint32(4, height);
  ihdrData[8] = 8;  // bit depth
  ihdrData[9] = 6;  // color type: RGBA (same as buildRawPng so Mapbox decode
                    // path is identical; only the in-PNG filter differs).
  ihdrData[10] = 0;
  ihdrData[11] = 0;
  ihdrData[12] = 0;
  const ihdr = _pngChunk('IHDR', ihdrData);
  const idat = _pngChunk('IDAT', compData);
  const iend = _pngChunk('IEND', new Uint8Array(0));

  const png = new Uint8Array(sig.length + ihdr.length + idat.length + iend.length);
  let pos = 0;
  png.set(sig, pos); pos += sig.length;
  png.set(ihdr, pos); pos += ihdr.length;
  png.set(idat, pos); pos += idat.length;
  png.set(iend, pos);
  return new Blob([png], { type: 'image/png' });
}

// ── Encode elevations → Terrain-RGB PNG ───────────────────────────────

// Pre-computed flat sea-level DEM tile (all pixels at elevation=0).
// Lazily generated once — returned for any failed DEM request so that Mapbox GL
// always has a valid terrain mesh to drape satellite imagery onto.
// Without this, Mapbox renders white for areas with no DEM → broken globe.
let _flatDemTilePromise = null;

function getFlatDemTile() {
  if (!_flatDemTilePromise) {
    _flatDemTilePromise = (async () => {
      const size = DEM_TILE_SIZE;
      const elevations = new Float32Array(size * size); // All zeros = sea level
      const blob = await encodeTerrainRGBPng(elevations);
      if (typeof swLog !== 'undefined' && swLog.isDebug()) {
        swLog.debug('build', `Flat DEM tile generated: ${blob.size} bytes (${size}x${size})`);
      }
      return blob;
    })();
  }
  return _flatDemTilePromise;
}

// Writes the Terrain-RGB scanlines directly (filter byte 0 + RGBA) — same
// deflate input as buildRawPng(rgba), so the PNG bytes are identical, minus
// one 256 KB intermediate buffer and its copy loop.
//
// The same loop also produces the exact Float32 grid a later decode of this
// blob would return (`-10000 + val * 0.1`, computed with the same integer
// `val`), and seeds DECODED_TERRAIN_RGB_CACHE with it: the health guard,
// the overzoom flat check and slope/altitude decodes of a freshly built tile
// then cost nothing.
async function encodeTerrainRGBPng(elevations) {
  const size = DEM_TILE_SIZE;
  const rowBytes = 1 + size * 4;
  const raw = new Uint8Array(size * rowBytes); // filter bytes stay 0 (None)
  const decoded = new Float32Array(size * size);

  for (let y = 0; y < size; y++) {
    let o = y * rowBytes + 1;
    const rowStart = y * size;
    for (let x = 0; x < size; x++) {
      const i = rowStart + x;
      const height = sanitizeElevation(elevations[i]);
      const val = Math.max(0, Math.min(16777215, Math.round((height + 10000) * 10)));
      raw[o]     = (val >> 16) & 0xff;
      raw[o + 1] = (val >>  8) & 0xff;
      raw[o + 2] =  val        & 0xff;
      raw[o + 3] = 255;
      o += 4;
      decoded[i] = -10000 + val * 0.1;
    }
  }

  const blob = await buildPngFromScanlines(size, size, raw);
  decodedTerrainRgbPut(blob, decoded);
  return blob;
}

// ── Decode Terrain-RGB PNG → Float32 elevations ───────────────────────
//
// Memoized by Blob identity via a WeakMap. The same Blob is regularly
// decoded multiple times in a single tick:
//   * slope handler decodes its DEM blob, then altitude handler decodes
//     the SAME blob a few ms later when both overlays are on
//   * composite paths decode their Mapbox base blob, then build-tile
//     decodes the same Mapbox blob again as the AWS prefill source
//   * tryParentOverzoom decodes a parent blob to check flat-line stats
//     and then overzoomDemTile decodes the same parent blob again
// Each decode is ~8-20 ms (createImageBitmap + getImageData + Float32
// loop for a 256² tile, more for 512² Mapbox). On a 100-tile zoom-in
// with slope+altitude both on, that's ~2-4 s of SW-thread CPU saved.
//
// Bounded LRU (Map in insertion order), NOT a WeakMap: DEM_HOT_CACHE keeps
// up to 2048 tile blobs alive, and a WeakMap pinned one 256 KB Float32 grid
// per blob (up to ~512 MB of SW heap) that was never read again — hot-tier
// reads go through Response.blob(), which yields a new Blob identity.
// 128 entries (~32 MB) still covers every burst reuse (guard, overzoom,
// slope neighbours, sibling parents). Returns a SHARED Float32Array, so
// callers must NOT mutate it in place (composite.js copies before despike).
const DECODED_TERRAIN_RGB_CACHE_MAX = 128;
const DECODED_TERRAIN_RGB_CACHE = new Map();

function decodedTerrainRgbGet(blob) {
  const entry = DECODED_TERRAIN_RGB_CACHE.get(blob);
  if (!entry) return null;
  DECODED_TERRAIN_RGB_CACHE.delete(blob);
  DECODED_TERRAIN_RGB_CACHE.set(blob, entry);
  return entry;
}

function decodedTerrainRgbPut(blob, elevations) {
  if (!blob || !elevations) return;
  DECODED_TERRAIN_RGB_CACHE.delete(blob);
  DECODED_TERRAIN_RGB_CACHE.set(blob, elevations);
  while (DECODED_TERRAIN_RGB_CACHE.size > DECODED_TERRAIN_RGB_CACHE_MAX) {
    const oldest = DECODED_TERRAIN_RGB_CACHE.keys().next().value;
    DECODED_TERRAIN_RGB_CACHE.delete(oldest);
  }
}

let _sharedOffscreenCanvas = null;
let _sharedOffscreenCtx = null;

function getSharedOffscreenCtx(width, height) {
  if (!_sharedOffscreenCanvas) {
    _sharedOffscreenCanvas = new OffscreenCanvas(width, height);
    _sharedOffscreenCtx = _sharedOffscreenCanvas.getContext('2d', {
      colorSpace: 'srgb',
      willReadFrequently: true,
    });
  } else if (_sharedOffscreenCanvas.width !== width || _sharedOffscreenCanvas.height !== height) {
    _sharedOffscreenCanvas.width = width;
    _sharedOffscreenCanvas.height = height;
    _sharedOffscreenCtx = _sharedOffscreenCanvas.getContext('2d', {
      colorSpace: 'srgb',
      willReadFrequently: true,
    });
  }
  return _sharedOffscreenCtx;
}

async function decodeTerrainRGBBlob(blob) {
  const cached = decodedTerrainRgbGet(blob);
  if (cached) return cached;
  const elevations = await decodeTerrainRGBBlobUncached(blob);
  decodedTerrainRgbPut(blob, elevations);
  return elevations;
}

async function decodeTerrainRGBBlobUncached(blob) {
  const img = await createImageBitmap(blob, {
    colorSpaceConversion: 'none',
    premultiplyAlpha: 'none',
  });
  const width = img.width;
  const height = img.height;
  let imageData;
  try {
    const ctx = getSharedOffscreenCtx(width, height);
    ctx.clearRect(0, 0, width, height);
    ctx.drawImage(img, 0, 0);
    imageData = ctx.getImageData(0, 0, width, height);
  } finally {
    img.close(); // Release GPU texture memory immediately
  }
  const pixels = imageData.data;
  const len = width * height;
  const elevations = new Float32Array(len);
  const u32 = new Uint32Array(pixels.buffer, pixels.byteOffset, len);

  for (let i = 0; i < len; i++) {
    const val = u32[i];
    // In little-endian: val = (A << 24) | (B << 16) | (G << 8) | R
    // Terrain-RGB formula: -10000 + ((R << 16) | (G << 8) | B) * 0.1
    const rgb = ((val & 0xff) << 16) | (val & 0x0000ff00) | ((val >> 16) & 0xff);
    elevations[i] = -10000 + rgb * 0.1;
  }

  // ── DEBUG: log decode diagnostics ──
  if (DEBUG) {
    let minE = Infinity, maxE = -Infinity, sumE = 0;
    for (let i = 0; i < elevations.length; i++) {
      const e = elevations[i];
      if (e < minE) minE = e;
      if (e > maxE) maxE = e;
      sumE += e;
    }
    const meanE = sumE / elevations.length;
    console.log(
      `[slope][decode] ${width}x${height} blob=${blob.size}B | elev min=${minE.toFixed(1)} max=${maxE.toFixed(1)} mean=${meanE.toFixed(1)} range=${(maxE - minE).toFixed(1)}m`,
    );
    if (maxE - minE < 1) {
      console.warn('[slope][decode] FLAT DEM — elevation range < 1 m');
    }
  }

  return elevations;
}

/**
 * Direct Float32Array to Float32Array Catmull-Rom upsampler.
 * Avoids temporary array allocations in the inner loop and eliminates
 * intermediate PNG encode/decode steps.
 */
function overzoomDemElevations(parentElevations, parentZ, parentX, parentY, targetZ, targetX, targetY) {
  if (!parentElevations) return null;
  const size = DEM_TILE_SIZE; // 256
  const dz = targetZ - parentZ;
  const nChildren = 1 << dz; // e.g. dz=2 → 4 sub-tiles per axis

  // Which child within the parent grid
  const childX = targetX - (parentX << dz);
  const childY = targetY - (parentY << dz);

  // Guard: target tile must actually lie inside the parent.
  if (childX < 0 || childY < 0 || childX >= nChildren || childY >= nChildren) {
    if (DEBUG) console.warn(
      `[sw-dem][overzoom] child OOB: target ${targetZ}/${targetX}/${targetY} not inside parent ${parentZ}/${parentX}/${parentY} (child=${childX},${childY} max=${nChildren - 1})`,
    );
    return null;
  }

  // Source pixel region in the parent tile
  const srcSize = size / nChildren; // pixels covered by one child
  const srcX0 = childX * srcSize;
  const srcY0 = childY * srcSize;

  // Helper: clamp-sample parent elevations
  const pSample = (px, py) => {
    const cx = Math.max(0, Math.min(px, size - 1));
    const cy = Math.max(0, Math.min(py, size - 1));
    return parentElevations[cy * size + cx];
  };

  const out = new Float32Array(size * size);

  for (let py = 0; py < size; py++) {
    const sy = srcY0 + (py + 0.5) * srcSize / size - 0.5;
    const iy = Math.floor(sy);
    const fy = sy - iy;

    for (let px = 0; px < size; px++) {
      const sx = srcX0 + (px + 0.5) * srcSize / size - 0.5;
      const ix = Math.floor(sx);
      const fx = sx - ix;

      // Catmull-Rom 4×4 kernel without inner-loop array allocations
      const r0 = cubicHermite(pSample(ix - 1, iy - 1), pSample(ix, iy - 1), pSample(ix + 1, iy - 1), pSample(ix + 2, iy - 1), fx);
      const r1 = cubicHermite(pSample(ix - 1, iy),     pSample(ix, iy),     pSample(ix + 1, iy),     pSample(ix + 2, iy),     fx);
      const r2 = cubicHermite(pSample(ix - 1, iy + 1), pSample(ix, iy + 1), pSample(ix + 1, iy + 1), pSample(ix + 2, iy + 1), fx);
      const r3 = cubicHermite(pSample(ix - 1, iy + 2), pSample(ix, iy + 2), pSample(ix + 1, iy + 2), pSample(ix + 2, iy + 2), fx);

      let val = cubicHermite(r0, r1, r2, r3, fy);
      if (val < MIN_VALID_ELEVATION_M) val = MIN_VALID_ELEVATION_M;
      else if (val > MAX_VALID_ELEVATION_M) val = MAX_VALID_ELEVATION_M;
      out[py * size + px] = val;
    }
  }

  return out;
}

/**
 * Given a parent DEM tile blob at (parentZ, parentX, parentY), extract the
 * sub-region corresponding to (targetZ, targetX, targetY) and bicubic
 * (Catmull-Rom) upsample it to DEM_TILE_SIZE × DEM_TILE_SIZE.
 *
 * Returns a Terrain-RGB PNG Blob, or null on failure.
 */
async function overzoomDemTile(parentBlob, parentZ, parentX, parentY, targetZ, targetX, targetY) {
  const parentElevations = await decodeTerrainRGBBlob(parentBlob);
  const out = overzoomDemElevations(parentElevations, parentZ, parentX, parentY, targetZ, targetX, targetY);
  if (!out) return null;
  return encodeTerrainRGBPng(out);
}
