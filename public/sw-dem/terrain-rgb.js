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
      console.log(`[sw-dem] Flat DEM tile generated: ${blob.size} bytes (${size}x${size})`);
      return blob;
    })();
  }
  return _flatDemTilePromise;
}

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
  let canvas, ctx, imageData;
  try {
    canvas = new OffscreenCanvas(img.width, img.height);
    ctx = canvas.getContext('2d', { colorSpace: 'srgb' });
    ctx.drawImage(img, 0, 0);
    imageData = ctx.getImageData(0, 0, img.width, img.height);
  } finally {
    img.close(); // Release GPU texture memory immediately
  }
  const pixels = imageData.data;
  const elevations = new Float32Array(canvas.width * canvas.height);

  for (let i = 0; i < elevations.length; i++) {
    const idx = i * 4;
    const r = pixels[idx];
    const g = pixels[idx + 1];
    const b = pixels[idx + 2];
    elevations[i] = -10000 + (r * 65536 + g * 256 + b) * 0.1;
  }

  // ── DEBUG: log decode diagnostics ──
  let minE = Infinity, maxE = -Infinity, sumE = 0;
  for (let i = 0; i < elevations.length; i++) {
    const e = elevations[i];
    if (e < minE) minE = e;
    if (e > maxE) maxE = e;
    sumE += e;
  }
  const meanE = sumE / elevations.length;
  // Sample 5 pixels from the center of the tile
  const tileW = canvas.width;
  const tileH = canvas.height;
  const mid = Math.floor(tileH / 2) * tileW + Math.floor(tileW / 2);
  const sampleRGB = [];
  for (let s = 0; s < 5; s++) {
    const si = (mid + s) * 4;
    sampleRGB.push(`(${pixels[si]},${pixels[si+1]},${pixels[si+2]},a=${pixels[si+3]})`);
  }
  console.log(
    `[slope][decode] %c DEM decoded %c ${tileW}x${tileH}, blob=${blob.size}B | elev min=${minE.toFixed(1)} max=${maxE.toFixed(1)} mean=${meanE.toFixed(1)} range=${(maxE-minE).toFixed(1)}m | center RGB: ${sampleRGB.join(' ')}`,
    'background:#2196F3;color:#fff;padding:2px 4px;border-radius:2px', ''
  );
  if (maxE - minE < 1) {
    console.warn(`[slope][decode] %c FLAT DEM %c Elevation range < 1m — slopes will all be ~0°! Check DEM source.`, 'background:#f44336;color:#fff;padding:2px 4px;border-radius:2px', '');
  }

  return elevations;
}

// ── Overzoom: extract & upsample a sub-tile from a lower-zoom DEM ─────

/**
 * Given a parent DEM tile blob at (parentZ, parentX, parentY), extract the
 * sub-region corresponding to (targetZ, targetX, targetY) and bilinear-
 * upsample it to DEM_TILE_SIZE × DEM_TILE_SIZE.
 *
 * Returns a Terrain-RGB PNG Blob, or null on failure.
 */
async function overzoomDemTile(parentBlob, parentZ, parentX, parentY, targetZ, targetX, targetY) {
  const parentElevations = await decodeTerrainRGBBlob(parentBlob);
  const size = DEM_TILE_SIZE; // 512

  const dz = targetZ - parentZ;
  const nChildren = 1 << dz; // e.g. dz=2 → 4 sub-tiles per axis

  // Which child within the parent grid
  const childX = targetX - (parentX << dz);
  const childY = targetY - (parentY << dz);

  // Source pixel region in the parent tile
  const srcSize = size / nChildren; // pixels covered by one child
  const srcX0 = childX * srcSize;
  const srcY0 = childY * srcSize;

  // Bilinear upsample from srcSize×srcSize region → size×size
  const out = new Float32Array(size * size);

  for (let py = 0; py < size; py++) {
    // Map output pixel to fractional source coordinate
    const sy = srcY0 + (py + 0.5) * srcSize / size - 0.5;
    const iy = Math.floor(sy);
    const fy = sy - iy;

    for (let px = 0; px < size; px++) {
      const sx = srcX0 + (px + 0.5) * srcSize / size - 0.5;
      const ix = Math.floor(sx);
      const fx = sx - ix;

      // Clamp to parent tile bounds
      const x0 = Math.max(0, Math.min(ix, size - 1));
      const x1 = Math.max(0, Math.min(ix + 1, size - 1));
      const y0 = Math.max(0, Math.min(iy, size - 1));
      const y1 = Math.max(0, Math.min(iy + 1, size - 1));

      const e00 = parentElevations[y0 * size + x0];
      const e10 = parentElevations[y0 * size + x1];
      const e01 = parentElevations[y1 * size + x0];
      const e11 = parentElevations[y1 * size + x1];

      const top = e00 + (e10 - e00) * fx;
      const bot = e01 + (e11 - e01) * fx;
      out[py * size + px] = top + (bot - top) * fy;
    }
  }

  console.log(
    `[sw-dem][overzoom] %c OVERZOOM %c ${parentZ}/${parentX}/${parentY} → ${targetZ}/${targetX}/${targetY} (dz=${dz}, child=${childX},${childY}, srcRegion=${srcSize}px)`,
    'background:#FF9800;color:#fff;padding:2px 4px;border-radius:2px', ''
  );

  return encodeTerrainRGBPng(out);
}
