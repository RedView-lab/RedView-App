// ---------------------------------------------------------------------------
// Minimal Cloud-Optimised GeoTIFF (COG) reader for swissSURFACE3D Raster
// ---------------------------------------------------------------------------
// Why a custom reader instead of geotiff.js?
//   * The SW is a *classic* Worker (importScripts) — geotiff.js v2 ships ESM
//     and adding a build step to bundle it adds friction we don't need.
//   * swisstopo COGs are remarkably uniform: single Float32 band, internal
//     tiling, DEFLATE compression, GeoKey-described EPSG:2056 georeferencing.
//   * We only need a tiny subset of TIFF: enough tags to map (LV95 metres) →
//     (image px) → (internal-tile index) → (range request) → (Float32 sample).
//
// Implementation contract:
//   const cog = await openSwissCOG(url);
//   const elev = await cog.sampleLV95(E, N);   // metres or NaN
//
// All Range fetches go through `swissScheduleFetch()` (in swiss-fetcher.js)
// to share one concurrency limiter for the whole Swiss pipeline.
// ---------------------------------------------------------------------------

// ─── TIFF tag IDs we care about ─────────────────────────────────────────────
const T_ImageWidth         = 256;
const T_ImageLength        = 257;
const T_BitsPerSample      = 258;
const T_Compression        = 259;
const T_SamplesPerPixel    = 277;
const T_TileWidth          = 322;
const T_TileLength         = 323;
const T_TileOffsets        = 324;
const T_TileByteCounts     = 325;
const T_SampleFormat       = 339;
const T_ModelPixelScaleTag = 33550;
const T_ModelTiepointTag   = 33922;
const T_GDAL_NODATA        = 42113;

// TIFF field type sizes
const TIFF_TYPE_SIZE = {
  1: 1,  // BYTE
  2: 1,  // ASCII
  3: 2,  // SHORT
  4: 4,  // LONG
  5: 8,  // RATIONAL
  6: 1,  // SBYTE
  7: 1,  // UNDEFINED
  8: 2,  // SSHORT
  9: 4,  // SLONG
  10: 8, // SRATIONAL
  11: 4, // FLOAT
  12: 8, // DOUBLE
};

// ─── Helpers ────────────────────────────────────────────────────────────────

// Decompress DEFLATE (RFC 1951 + zlib wrapper). swisstopo COGs use
// Compression=8 which is the zlib-wrapped form; native DecompressionStream
// supports both 'deflate' (zlib) and 'deflate-raw'. We try zlib first.
async function inflateDeflate(buffer) {
  // buffer: Uint8Array
  const tryDecompress = async (format) => {
    const stream = new Blob([buffer]).stream().pipeThrough(new DecompressionStream(format));
    const out = await new Response(stream).arrayBuffer();
    return new Uint8Array(out);
  };
  try { return await tryDecompress('deflate'); }
  catch {
    try { return await tryDecompress('deflate-raw'); }
    catch (e2) { throw new Error(`DEFLATE decode failed: ${e2.message || e2}`); }
  }
}

function readTagValue(view, entryOffset, type, count, littleEndian, bytesView) {
  const typeSize = TIFF_TYPE_SIZE[type] || 0;
  const totalBytes = typeSize * count;
  // For inline values (≤4 bytes) the value sits in the value/offset slot
  // (entryOffset+8). For larger payloads it's an offset into the file.
  const isInline = totalBytes <= 4;
  let dataOffset, data;
  if (isInline) {
    dataOffset = entryOffset + 8;
    data = view;
  } else {
    dataOffset = view.getUint32(entryOffset + 8, littleEndian);
    data = new DataView(bytesView.buffer, bytesView.byteOffset, bytesView.byteLength);
  }

  const out = new Array(count);
  for (let i = 0; i < count; i++) {
    const off = dataOffset + i * typeSize;
    switch (type) {
      case 1: case 7: out[i] = data.getUint8(off); break;
      case 2: out[i] = data.getUint8(off); break;
      case 3: out[i] = data.getUint16(off, littleEndian); break;
      case 4: out[i] = data.getUint32(off, littleEndian); break;
      case 6: out[i] = data.getInt8(off); break;
      case 8: out[i] = data.getInt16(off, littleEndian); break;
      case 9: out[i] = data.getInt32(off, littleEndian); break;
      case 11: out[i] = data.getFloat32(off, littleEndian); break;
      case 12: out[i] = data.getFloat64(off, littleEndian); break;
      default: out[i] = 0;
    }
  }
  return out;
}

// ─── COG header parser ──────────────────────────────────────────────────────
// Reads enough of the TIFF header to locate the full-resolution IFD and its
// internal-tile offset/byte-count tables. Returns a descriptor with all the
// info we need to range-fetch and decompress individual tiles on demand.
//
// We deliberately READ THE FULL FIRST IFD from the initial header range
// fetch (32 KB). swisstopo COGs put the IFD0 right after the header (TIFF
// classic) and TileOffsets/TileByteCounts arrays for a 2000² image with
// 256² internals are ~8×8 = 64 entries → 256 bytes each, easily inside.
// If the offset arrays land outside the initial range, we follow up with a
// targeted second range fetch.
async function parseSwissCOGHeader(url, headerBytes) {
  if (headerBytes.byteLength < 16) throw new Error('header too short');
  const view = new DataView(headerBytes.buffer, headerBytes.byteOffset, headerBytes.byteLength);

  // Byte order
  const bo = view.getUint16(0, true);
  let LE;
  if (bo === 0x4949) LE = true;       // "II" little-endian
  else if (bo === 0x4D4D) LE = false; // "MM" big-endian
  else throw new Error('not a TIFF');

  const magic = view.getUint16(2, LE);
  if (magic !== 42) {
    // BigTIFF (43) is rare for COGs of this size — bail out gracefully so
    // the caller can fall back to Mapbox without a hard crash.
    throw new Error(`unsupported TIFF magic ${magic}`);
  }

  const ifd0Offset = view.getUint32(4, LE);
  if (ifd0Offset + 2 > headerBytes.byteLength) {
    return { _needMoreBytes: ifd0Offset + 4096 };
  }

  const numEntries = view.getUint16(ifd0Offset, LE);
  const entriesStart = ifd0Offset + 2;
  if (entriesStart + numEntries * 12 + 4 > headerBytes.byteLength) {
    return { _needMoreBytes: entriesStart + numEntries * 12 + 4 };
  }

  // Build a tag map
  const tags = {};
  let largestNeeded = ifd0Offset + 2 + numEntries * 12 + 4;

  for (let i = 0; i < numEntries; i++) {
    const entryOff = entriesStart + i * 12;
    const tag   = view.getUint16(entryOff, LE);
    const type  = view.getUint16(entryOff + 2, LE);
    const count = view.getUint32(entryOff + 4, LE);

    const typeSize = TIFF_TYPE_SIZE[type] || 0;
    const totalBytes = typeSize * count;
    const inline = totalBytes <= 4;
    const valueOffset = inline ? (entryOff + 8) : view.getUint32(entryOff + 8, LE);

    if (!inline) {
      const need = valueOffset + totalBytes;
      if (need > largestNeeded) largestNeeded = need;
    }

    tags[tag] = { type, count, valueOffset, inline, _entryOff: entryOff };
  }

  // If any tag's payload is outside our initial range we cannot continue
  // with this header buffer — let caller refetch a larger range.
  if (largestNeeded > headerBytes.byteLength) {
    return { _needMoreBytes: largestNeeded };
  }

  const readTag = (tagId) => {
    const t = tags[tagId];
    if (!t) return null;
    return readTagValue(view, t._entryOff, t.type, t.count, LE, headerBytes);
  };

  const width  = readTag(T_ImageWidth)?.[0]  ?? 0;
  const height = readTag(T_ImageLength)?.[0] ?? 0;
  const tileW  = readTag(T_TileWidth)?.[0];
  const tileH  = readTag(T_TileLength)?.[0];
  const compression = readTag(T_Compression)?.[0] ?? 1;
  const sampleFormat = readTag(T_SampleFormat)?.[0] ?? 1;
  const bitsPerSample = readTag(T_BitsPerSample)?.[0] ?? 8;
  const samplesPerPixel = readTag(T_SamplesPerPixel)?.[0] ?? 1;

  if (!tileW || !tileH) throw new Error('not a tiled TIFF');
  if (samplesPerPixel !== 1) throw new Error(`unsupported samplesPerPixel=${samplesPerPixel}`);
  if (sampleFormat !== 3 || bitsPerSample !== 32) {
    throw new Error(`unsupported sample format=${sampleFormat} bits=${bitsPerSample} (expected Float32)`);
  }
  // Compression: 1 (none), 8 (DEFLATE/zlib), 32946 (also DEFLATE alias)
  if (compression !== 1 && compression !== 8 && compression !== 32946) {
    throw new Error(`unsupported compression=${compression}`);
  }

  const tileOffsets    = readTag(T_TileOffsets);
  const tileByteCounts = readTag(T_TileByteCounts);
  if (!tileOffsets || !tileByteCounts) {
    throw new Error('missing TileOffsets / TileByteCounts');
  }

  const pixelScale = readTag(T_ModelPixelScaleTag); // [sx, sy, sz]
  const tiepoint   = readTag(T_ModelTiepointTag);   // [I, J, K, X, Y, Z] (×n)
  if (!pixelScale || !tiepoint || tiepoint.length < 6) {
    throw new Error('missing georeferencing tags');
  }
  const [sx, sy /*, sz*/] = pixelScale;
  const [I, J /*K*/, , X, Y /*Z*/] = tiepoint;
  // Affine: image (i,j) → world (X + (i-I)*sx, Y - (j-J)*sy)
  // For COGs the tiepoint is usually (0,0,0,Xul,Yul,0); we don't assume.
  const originE = X - I * sx;
  const originN = Y + J * sy;

  const nodataTag = readTag(T_GDAL_NODATA);
  let nodata = NaN;
  if (nodataTag && nodataTag.length > 0) {
    // GDAL_NODATA is ASCII; we read it as bytes — convert to number.
    let str = '';
    for (let i = 0; i < nodataTag.length; i++) {
      const c = nodataTag[i];
      if (c === 0) break;
      str += String.fromCharCode(c);
    }
    const n = parseFloat(str);
    if (Number.isFinite(n)) nodata = n;
  }

  const tilesAcross = Math.ceil(width / tileW);
  const tilesDown   = Math.ceil(height / tileH);

  return {
    url,
    LE,
    width, height,
    tileW, tileH,
    tilesAcross, tilesDown,
    compression,
    tileOffsets,         // Array<number>
    tileByteCounts,      // Array<number>
    originE, originN,    // upper-left LV95 metres (north-up)
    pixelScaleX: sx,
    pixelScaleY: sy,
    nodata,
    // Bounding box (LV95)
    Emin: originE,
    Emax: originE + width * sx,
    Nmax: originN,
    Nmin: originN - height * sy,
  };
}

// ─── Internal-tile fetch + decode ───────────────────────────────────────────

async function fetchAndDecodeTile(cog, tileIndex, fetcher) {
  const offset = cog.tileOffsets[tileIndex];
  const length = cog.tileByteCounts[tileIndex];
  if (!Number.isFinite(offset) || !Number.isFinite(length) || length <= 0) {
    return null;
  }
  const buf = await fetcher(cog.url, offset, length);
  if (!buf) return null;

  let raw;
  if (cog.compression === 1) {
    raw = new Uint8Array(buf);
  } else {
    raw = await inflateDeflate(new Uint8Array(buf));
  }

  const expectedBytes = cog.tileW * cog.tileH * 4;
  if (raw.byteLength < expectedBytes) {
    if (DEBUG) console.warn(`[swiss-cog] short tile ${tileIndex}: ${raw.byteLength}/${expectedBytes}`);
    return null;
  }

  // Build a Float32Array view aligned at byte 0. The decompressed buffer is
  // produced fresh by DecompressionStream so it's already 4-byte aligned.
  return new Float32Array(raw.buffer, raw.byteOffset, cog.tileW * cog.tileH);
}

// Convert LV95 (E, N) → image (px, py) in *pixel-centre* coordinates.
function cogLV95ToPixel(cog, E, N) {
  const px = (E - cog.originE) / cog.pixelScaleX;
  const py = (cog.originN - N) / cog.pixelScaleY;
  return { px, py };
}

// Bilinear-sample a single LV95 point. Returns NaN if outside bounds or no
// data. The COG object must expose a `getInternalTile(tileIndex)` async
// helper (memoised by the caller).
async function sampleSwissCOG(cog, E, N, getInternalTile) {
  if (E < cog.Emin || E > cog.Emax || N < cog.Nmin || N > cog.Nmax) return NaN;

  const { px, py } = cogLV95ToPixel(cog, E, N);
  // Clamp to image extent (bilinear uses 4 neighbours)
  const x0 = Math.max(0, Math.min(Math.floor(px), cog.width - 1));
  const y0 = Math.max(0, Math.min(Math.floor(py), cog.height - 1));
  const x1 = Math.min(x0 + 1, cog.width - 1);
  const y1 = Math.min(y0 + 1, cog.height - 1);
  const fx = px - x0;
  const fy = py - y0;

  // Internal tile lookup for each of the (up to 4) sample pixels.
  const sampleAt = async (x, y) => {
    const tx = (x / cog.tileW) | 0;
    const ty = (y / cog.tileH) | 0;
    const tileIndex = ty * cog.tilesAcross + tx;
    const tile = await getInternalTile(tileIndex);
    if (!tile) return NaN;
    const lx = x - tx * cog.tileW;
    const ly = y - ty * cog.tileH;
    const v = tile[ly * cog.tileW + lx];
    if (!Number.isFinite(v)) return NaN;
    if (cog.nodata !== undefined && v === cog.nodata) return NaN;
    return v;
  };

  const v00 = await sampleAt(x0, y0);
  const v10 = await sampleAt(x1, y0);
  const v01 = await sampleAt(x0, y1);
  const v11 = await sampleAt(x1, y1);

  // If any neighbour is NaN, fall back to nearest-valid average.
  let sum = 0, count = 0;
  if (!Number.isNaN(v00)) { sum += v00 * (1 - fx) * (1 - fy); count++; }
  if (!Number.isNaN(v10)) { sum += v10 * fx * (1 - fy); count++; }
  if (!Number.isNaN(v01)) { sum += v01 * (1 - fx) * fy; count++; }
  if (!Number.isNaN(v11)) { sum += v11 * fx * fy; count++; }
  if (count === 0) return NaN;
  if (count === 4) return sum;
  // Partial coverage — re-weight by valid bilinear weights only.
  let wSum = 0;
  if (!Number.isNaN(v00)) wSum += (1 - fx) * (1 - fy);
  if (!Number.isNaN(v10)) wSum += fx * (1 - fy);
  if (!Number.isNaN(v01)) wSum += (1 - fx) * fy;
  if (!Number.isNaN(v11)) wSum += fx * fy;
  return wSum > 0 ? sum / wSum : NaN;
}
