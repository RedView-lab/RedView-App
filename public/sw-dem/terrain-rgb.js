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
  // Build raw scanlines: filter-byte(0) + row RGBA data per row
  const rowBytes = 1 + width * 4;
  const raw = new Uint8Array(height * rowBytes);
  for (let y = 0; y < height; y++) {
    const off = y * rowBytes;
    raw[off] = 0; // filter: None
    raw.set(rgba.subarray(y * width * 4, (y + 1) * width * 4), off + 1);
  }

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
  ihdrData[9] = 6;  // color type: RGBA
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

// ── Encode elevations → Terrain-RGB PNG ───────────────────────────────

async function encodeTerrainRGBPng(elevations) {
  const size = DEM_TILE_SIZE;
  const rgba = new Uint8Array(size * size * 4);

  for (let i = 0; i < elevations.length; i++) {
    const height = sanitizeElevation(elevations[i]);
    const val = Math.max(0, Math.min(16777215, Math.round((height + 10000) / 0.1)));
    const idx = i * 4;
    rgba[idx]     = (val >> 16) & 0xff;
    rgba[idx + 1] = (val >>  8) & 0xff;
    rgba[idx + 2] =  val        & 0xff;
    rgba[idx + 3] = 255;
  }

  return buildRawPng(size, size, rgba);
}

// ── Decode Terrain-RGB PNG → Float32 elevations ───────────────────────

async function decodeTerrainRGBBlob(blob) {
  const img = await createImageBitmap(blob, {
    colorSpaceConversion: 'none',
    premultiplyAlpha: 'none',
  });
  const canvas = new OffscreenCanvas(img.width, img.height);
  const ctx = canvas.getContext('2d', { colorSpace: 'srgb' });
  ctx.drawImage(img, 0, 0);
  const imageData = ctx.getImageData(0, 0, img.width, img.height);
  const pixels = imageData.data;
  const elevations = new Float32Array(img.width * img.height);

  for (let i = 0; i < elevations.length; i++) {
    const idx = i * 4;
    const r = pixels[idx];
    const g = pixels[idx + 1];
    const b = pixels[idx + 2];
    elevations[i] = -10000 + (r * 65536 + g * 256 + b) * 0.1;
  }
  return elevations;
}
