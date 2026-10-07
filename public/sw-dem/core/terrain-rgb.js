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

// ── zlib stream: run-length matches + dynamic Huffman ─────────────────
// CompressionStream('deflate') is zlib level 6, whose LZ77 match search
// costs 20-30 ms on a Paeth-filtered 512² slope tile (Chromium, Node) and
// gains nothing there: the residuals of a smooth field have no far repeats.
// Measured on real tiles (Mont-Blanc z12/z13, Lyon, Paris): level 6 gives
// 69-98 KB, zlib's Z_RLE strategy 69-95 KB at a tenth of the time. This is
// that strategy — a byte repeating the previous one becomes a distance-1
// match (flat ground, sea), everything else a Huffman-coded literal — with
// one dynamic block per 16 K symbols like zlib. Every tree keeps at least two
// codes, as zlib's encoder does, so all inflaters accept it (an incomplete
// code-length code is an error for zlib's inflate).
// Used for the opaque gray slope tile (buildGrayPng) and the Up-filtered RGB
// DEM tile (encodeTerrainRGBPng). Not for unfiltered rows: Terrain-RGB RGBA
// triplets repeat at distance 4 and gray + alpha pairs at distance 2, where
// level 6 stays 12-50 % smaller.

const _ZRLE_BLOCK_SYMBOLS = 16384;
const _ZRLE_LEN_BASE = [3, 4, 5, 6, 7, 8, 9, 10, 11, 13, 15, 17, 19, 23, 27, 31,
  35, 43, 51, 59, 67, 83, 99, 115, 131, 163, 195, 227, 258];
const _ZRLE_LEN_EXTRA = [0, 0, 0, 0, 0, 0, 0, 0, 1, 1, 1, 1, 2, 2, 2, 2,
  3, 3, 3, 3, 4, 4, 4, 4, 5, 5, 5, 5, 0];
const _ZRLE_CL_ORDER = [16, 17, 18, 0, 8, 7, 9, 6, 10, 5, 11, 4, 12, 3, 13, 2, 14, 1, 15];
// Match length (3…258) → length code index (0…28, i.e. symbols 257…285).
const _ZRLE_LEN_CODE = (() => {
  const t = new Uint8Array(259);
  for (let c = 0; c < 29; c++) {
    const hi = Math.min(258, _ZRLE_LEN_BASE[c] + (1 << _ZRLE_LEN_EXTRA[c]) - 1);
    for (let l = _ZRLE_LEN_BASE[c]; l <= hi; l++) t[l] = c;
  }
  return t;
})();

// Huffman code lengths ≤ maxBits for `freq` (two-queue construction on the
// sorted leaves; frequencies halved and rebuilt in the rare case a code is
// too long). The caller guarantees at least two non-zero frequencies.
function _zrleCodeLengths(freq, maxBits) {
  const lengths = new Uint8Array(freq.length);
  const symbols = [];
  for (let s = 0; s < freq.length; s++) if (freq[s] > 0) symbols.push(s);
  const m = symbols.length;
  let weights = symbols.map((s) => freq[s]);
  const weight = new Float64Array(2 * m);
  const parent = new Int32Array(2 * m);
  const depth = new Uint16Array(2 * m);
  for (;;) {
    const order = weights.map((_, i) => i).sort((a, b) => weights[a] - weights[b]);
    for (let i = 0; i < m; i++) weight[i] = weights[order[i]];
    let leaf = 0;
    let node = m;
    const pick = (end) => (leaf < m && (node >= end || weight[leaf] <= weight[node]) ? leaf++ : node++);
    for (let k = m; k < 2 * m - 1; k++) {
      const a = pick(k);
      const b = pick(k);
      weight[k] = weight[a] + weight[b];
      parent[a] = k;
      parent[b] = k;
    }
    depth[2 * m - 2] = 0;
    let longest = 0;
    for (let k = 2 * m - 3; k >= 0; k--) {
      depth[k] = depth[parent[k]] + 1;
      if (k < m && depth[k] > longest) longest = depth[k];
    }
    if (longest <= maxBits) {
      for (let i = 0; i < m; i++) lengths[symbols[order[i]]] = depth[i];
      return lengths;
    }
    weights = weights.map((w) => (w >> 1) | 1);
  }
}

// Canonical codes (RFC 1951 §3.2.2), bit-reversed for LSB-first output.
function _zrleCodes(lengths) {
  const count = new Uint16Array(16);
  for (let s = 0; s < lengths.length; s++) count[lengths[s]]++;
  count[0] = 0;
  const next = new Uint16Array(16);
  let code = 0;
  for (let bits = 1; bits < 16; bits++) {
    code = (code + count[bits - 1]) << 1;
    next[bits] = code;
  }
  const codes = new Uint16Array(lengths.length);
  for (let s = 0; s < lengths.length; s++) {
    const len = lengths[s];
    if (!len) continue;
    let c = next[len]++;
    let r = 0;
    for (let i = 0; i < len; i++) { r = (r << 1) | (c & 1); c >>= 1; }
    codes[s] = r;
  }
  return codes;
}

function _zrleEnsureTwoCodes(freq) {
  let used = 0;
  for (let s = 0; s < freq.length && used < 2; s++) if (freq[s] > 0) used++;
  for (let s = 0; used < 2; s++) if (freq[s] === 0) { freq[s] = 1; used++; }
}

function _zrleAdler32(data) {
  let a = 1;
  let b = 0;
  for (let i = 0; i < data.length;) {
    const end = Math.min(i + 5552, data.length);
    for (; i < end; i++) { a += data[i]; b += a; }
    a %= 65521;
    b %= 65521;
  }
  return ((b << 16) | a) >>> 0;
}

// zlib stream (RFC 1950) of `data`, readable by any inflater.
function zlibDeflateRle(data) {
  const n = data.length;
  let out = new Uint8Array(Math.max(1024, (n >> 1) + 1024));
  let pos = 2;
  out[0] = 0x78; // deflate, 32 K window
  out[1] = 0x01; // FLEVEL 0 (fastest), FCHECK so that 0x7801 % 31 === 0
  let bitBuf = 0;
  let bitCnt = 0;
  const put = (value, bits) => {
    bitBuf |= value << bitCnt;
    bitCnt += bits;
    while (bitCnt >= 8) {
      out[pos++] = bitBuf & 0xff;
      bitBuf >>>= 8;
      bitCnt -= 8;
    }
  };

  const symbols = new Uint16Array(_ZRLE_BLOCK_SYMBOLS); // < 256 literal, else 256 + match length
  const litFreq = new Uint32Array(286);
  const distFreq = new Uint32Array(30);
  const clFreq = new Uint32Array(19);
  const clOps = new Uint16Array(286 + 30); // code-length symbol | extra value << 5
  let i = 0;
  do {
    litFreq.fill(0);
    distFreq.fill(0);
    let count = 0;
    while (i < n && count < _ZRLE_BLOCK_SYMBOLS) {
      const byte = data[i];
      if (i > 0 && byte === data[i - 1]) {
        const end = Math.min(n, i + 258);
        let j = i + 1;
        while (j < end && data[j] === byte) j++;
        const len = j - i;
        if (len >= 3) {
          symbols[count++] = 256 + len;
          litFreq[257 + _ZRLE_LEN_CODE[len]]++;
          distFreq[0]++;
          i = j;
          continue;
        }
      }
      symbols[count++] = byte;
      litFreq[byte]++;
      i++;
    }
    const final = i >= n;
    litFreq[256] = 1;
    _zrleEnsureTwoCodes(litFreq);
    _zrleEnsureTwoCodes(distFreq);
    const litLen = _zrleCodeLengths(litFreq, 15);
    const distLen = _zrleCodeLengths(distFreq, 15);
    const litCode = _zrleCodes(litLen);
    const distCode = _zrleCodes(distLen);
    let nLit = 286;
    while (nLit > 257 && litLen[nLit - 1] === 0) nLit--;
    let nDist = 30;
    while (nDist > 1 && distLen[nDist - 1] === 0) nDist--;

    // Code lengths of both trees as one sequence, run-length coded (16/17/18).
    const seq = new Uint8Array(nLit + nDist);
    seq.set(litLen.subarray(0, nLit), 0);
    seq.set(distLen.subarray(0, nDist), nLit);
    clFreq.fill(0);
    let nOps = 0;
    const op = (sym, extra) => { clOps[nOps++] = sym | (extra << 5); clFreq[sym]++; };
    for (let k = 0; k < seq.length;) {
      const len = seq[k];
      let run = 1;
      while (k + run < seq.length && seq[k + run] === len) run++;
      k += run;
      if (len === 0) {
        while (run >= 11) { const r = Math.min(run, 138); op(18, r - 11); run -= r; }
        if (run >= 3) { op(17, run - 3); run = 0; }
      } else {
        op(len, 0);
        run--;
        while (run >= 3) { const r = Math.min(run, 6); op(16, r - 3); run -= r; }
      }
      while (run-- > 0) op(len, 0);
    }
    _zrleEnsureTwoCodes(clFreq);
    const clLen = _zrleCodeLengths(clFreq, 7);
    const clCode = _zrleCodes(clLen);
    let nCl = 19;
    while (nCl > 4 && clLen[_ZRLE_CL_ORDER[nCl - 1]] === 0) nCl--;

    // Worst case: 21 bits per symbol (15 + 5 extra + 1 distance) + the
    // block header (≤ 316 code-length ops of 14 bits).
    const need = pos + count * 3 + 1024;
    if (need > out.length) {
      const grown = new Uint8Array(Math.max(need, out.length * 2));
      grown.set(out.subarray(0, pos));
      out = grown;
    }

    put(final ? 1 : 0, 1);
    put(2, 2); // dynamic Huffman
    put(nLit - 257, 5);
    put(nDist - 1, 5);
    put(nCl - 4, 4);
    for (let k = 0; k < nCl; k++) put(clLen[_ZRLE_CL_ORDER[k]], 3);
    for (let k = 0; k < nOps; k++) {
      const sym = clOps[k] & 31;
      put(clCode[sym], clLen[sym]);
      if (sym === 16) put(clOps[k] >> 5, 2);
      else if (sym === 17) put(clOps[k] >> 5, 3);
      else if (sym === 18) put(clOps[k] >> 5, 7);
    }
    const distSym = distCode[0];
    const distBits = distLen[0];
    for (let k = 0; k < count; k++) {
      const s = symbols[k];
      if (s < 256) {
        put(litCode[s], litLen[s]);
      } else {
        const len = s - 256;
        const c = _ZRLE_LEN_CODE[len];
        put(litCode[257 + c], litLen[257 + c]);
        if (_ZRLE_LEN_EXTRA[c]) put(len - _ZRLE_LEN_BASE[c], _ZRLE_LEN_EXTRA[c]);
        put(distSym, distBits);
      }
    }
    put(litCode[256], litLen[256]);
  } while (i < n);

  if (bitCnt > 0) out[pos++] = bitBuf & 0xff;
  const adler = _zrleAdler32(data);
  if (pos + 4 > out.length) {
    const grown = new Uint8Array(pos + 4);
    grown.set(out.subarray(0, pos));
    out = grown;
  }
  out[pos++] = adler >>> 24;
  out[pos++] = (adler >>> 16) & 0xff;
  out[pos++] = (adler >>> 8) & 0xff;
  out[pos++] = adler & 0xff;
  return out.subarray(0, pos);
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
// `colorType`: 6 = RGBA (default), 2 = RGB, 4 = gray + alpha.
async function buildPngFromScanlines(width, height, raw, colorType = 6) {
  // Compress with deflate via CompressionStream
  const cs = new CompressionStream('deflate');
  const writer = cs.writable.getWriter();
  writer.write(raw);
  writer.close();
  const compressed = await new Response(cs.readable).arrayBuffer();
  return buildPngFromZlib(width, height, new Uint8Array(compressed), colorType);
}

// PNG around an already compressed zlib stream of the scanlines.
function buildPngFromZlib(width, height, compData, colorType) {
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
// Kept on zlib level 6: the alpha bytes interleaved with the gray ones break
// the runs, and zlibDeflateRle came out 12-18 % larger on real zone tiles.
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
// zlibDeflateRle then brings a real 512² tile from 22-34 ms (level 6) to a
// few ms at the same size.
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
  return buildPngFromZlib(width, height, zlibDeflateRle(raw), 0);
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

// Writes the Terrain-RGB scanlines directly: RGB (colour type 2, the alpha was
// always 255) with PNG's Up filter (each byte minus the one above), compressed
// by zlibDeflateRle. Neighbouring rows of an elevation field differ little,
// so the residuals are small bytes that Huffman codes well without any match
// search. Measured in Chromium against the former RGBA unfiltered tile through
// CompressionStream (level 6): real Terrarium tiles (Mont-Blanc z12, Chamonix
// z13, Aiguilles z14, Beauce z12) 3.1-4.6 ms / 45-62 KB instead of
// 5.7-10.2 ms / 60-88 KB; a noisy 0.40 m-like surface 5.1 ms / 88 KB instead
// of 8.6 ms / 113 KB. Level 6 on the filtered rows is smaller on smooth tiles
// (26-41 KB) but 84 % slower on noisy ones, where its match search finds
// nothing. Decoded slightly faster too (createImageBitmap + getImageData).
// Decoders read any PNG colour type and filter, so tiles already cached in the
// old format stay valid.
//
// The same loop also produces the exact Float32 grid a later decode of this
// blob would return (`-10000 + val * 0.1`, computed with the same integer
// `val`), and seeds DECODED_TERRAIN_RGB_CACHE with it: the health guard,
// the overzoom flat check and slope/altitude decodes of a freshly built tile
// then cost nothing.
async function encodeTerrainRGBPng(elevations) {
  const size = DEM_TILE_SIZE;
  const rowLen = size * 3;
  const rowBytes = 1 + rowLen;
  const raw = new Uint8Array(size * rowBytes);
  const decoded = new Float32Array(size * size);
  // Bytes of the row above (zeros above the first row: Up = None there).
  const above = new Uint8Array(rowLen);

  for (let y = 0; y < size; y++) {
    const rowOffset = y * rowBytes;
    raw[rowOffset] = 2; // filter: Up
    let o = rowOffset + 1;
    let p = 0;
    const rowStart = y * size;
    for (let x = 0; x < size; x++) {
      const i = rowStart + x;
      const height = sanitizeElevation(elevations[i]);
      const val = Math.max(0, Math.min(16777215, Math.round((height + 10000) * 10)));
      const r = (val >> 16) & 0xff;
      const g = (val >> 8) & 0xff;
      const b = val & 0xff;
      // Uint8Array stores the difference modulo 256, as the filter wants.
      raw[o] = r - above[p];
      raw[o + 1] = g - above[p + 1];
      raw[o + 2] = b - above[p + 2];
      above[p] = r;
      above[p + 1] = g;
      above[p + 2] = b;
      o += 3;
      p += 3;
      decoded[i] = -10000 + val * 0.1;
    }
  }

  const blob = buildPngFromZlib(size, size, zlibDeflateRle(raw), 2);
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
