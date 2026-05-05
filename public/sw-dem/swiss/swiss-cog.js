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
  catch { return await tryDecompress('deflate-raw'); }
}

// ─── TIFF LZW decoder (Compression = 5) ─────────────────────────────────────
// swisstopo swissSURFACE3D Raster COGs are LZW-compressed (verified by
// header probing — Tag 259 = 5). DecompressionStream has no LZW backend,
// so we ship a minimal pure-JS decoder.
//
// TIFF 6.0 §13 LZW specifics (vs. textbook LZW / GIF):
//   * Bit packing is **MSB-first** (GIF is LSB-first).
//   * Code width starts at 9 bits, grows when the dictionary index reaches
//     the "early change" thresholds 510, 1022, 2046 (one less than
//     2^width − 1, per the TIFF errata of 2002).
//   * CLEAR = 256 resets the dictionary and code width to 9 bits.
//   * EOI = 257 terminates the stream.
//   * Dictionary entries 258+ are { firstCode, suffixByte } pairs; output
//     length is unbounded so we accumulate into chunks, then concat once.
function decodeTIFFLZW(input) {
  const CLEAR = 256;
  const EOI = 257;
  const MAX_CODE = 4093; // 2^12 − 3 (entries 4094 and 4095 are reserved/forbidden)

  const inLen = input.length;
  // Pre-allocate output guess (LZW typically expands ~2-3×; we'll grow).
  // Tile is tileW*tileH*4 bytes (e.g. 512*512*4 = 1 MiB) so start there.
  let out = new Uint8Array(Math.max(inLen * 3, 1 << 16));
  let outPos = 0;
  const ensureOut = (need) => {
    if (outPos + need <= out.length) return;
    let cap = out.length * 2;
    while (cap < outPos + need) cap *= 2;
    const next = new Uint8Array(cap);
    next.set(out);
    out = next;
  };

  // Bit reader (MSB-first across the input byte stream).
  let bitBuf = 0;
  let bitCnt = 0;
  let bytePos = 0;
  const readCode = (width) => {
    while (bitCnt < width && bytePos < inLen) {
      bitBuf = (bitBuf << 8) | input[bytePos++];
      bitCnt += 8;
    }
    if (bitCnt < width) return -1;
    bitCnt -= width;
    return (bitBuf >>> bitCnt) & ((1 << width) - 1);
  };

  // Dictionary as parallel arrays (prefixCode, suffixByte). Resolving an
  // entry walks back through prefix chain into a small scratch buffer.
  const prefix = new Int16Array(4096);
  const suffix = new Uint8Array(4096);
  const scratch = new Uint8Array(4096);

  const writeEntry = (code) => {
    let len = 0;
    let c = code;
    while (c >= 0) {
      scratch[len++] = (c < 256) ? c : suffix[c];
      if (c < 256) break;
      c = prefix[c];
    }
    ensureOut(len);
    // scratch is in reverse order — emit backwards.
    for (let i = len - 1; i >= 0; i--) out[outPos++] = scratch[i];
    return scratch[len - 1]; // first byte of the entry
  };

  let codeWidth = 9;
  let nextCode = 258;
  let prevCode = -1;

  while (true) {
    const code = readCode(codeWidth);
    if (code < 0 || code === EOI) break;
    if (code === CLEAR) {
      codeWidth = 9;
      nextCode = 258;
      prevCode = -1;
      continue;
    }

    let firstByte;
    if (code < nextCode) {
      // Known code — emit and (if we have a previous) add prev+firstByte to dict.
      firstByte = writeEntry(code);
      if (prevCode !== -1 && nextCode <= MAX_CODE) {
        prefix[nextCode] = prevCode;
        suffix[nextCode] = firstByte;
        nextCode++;
      }
    } else if (code === nextCode && prevCode !== -1) {
      // KwKwK case: new code = prev + firstByte(prev). Add to dict, then emit.
      // First derive firstByte of prev WITHOUT emitting it (walk chain).
      let c = prevCode;
      while (c >= 256) c = prefix[c];
      firstByte = c;
      if (nextCode <= MAX_CODE) {
        prefix[nextCode] = prevCode;
        suffix[nextCode] = firstByte;
        nextCode++;
      }
      writeEntry(code);
    } else {
      // Bad code — corrupt stream. Bail.
      break;
    }

    prevCode = code;

    // TIFF "early change": grow width one code BEFORE the dictionary fills,
    // so that the encoder and decoder agree on the width of the next code.
    if (codeWidth < 12 && nextCode === ((1 << codeWidth) - 1)) {
      codeWidth++;
    }
  }

  return out.subarray(0, outPos);
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
// Reads the TIFF header AND walks the IFD chain so we expose the full
// pyramid (full-res IFD0 + 2× / 4× / 8× ... overview IFDs). Returns a
// descriptor whose `levels[]` array carries one entry per resolution level.
// Callers pick the appropriate level for the requested output mpp via
// pickSwissCOGLevel() so we don't always pay for the 0.5 m native data.
//
// swissSURFACE3D Raster COGs are 2000×2000 px with internal tiling and
// usually carry 4-5 overview levels (1000², 500², 250², 125²). The
// per-IFD payload is small (<1 KB each) so a 128 KB initial header fetch
// covers IFD0 + every overview without a second round-trip.
//
// Helper: parse one IFD starting at `ifdOffset`. Returns either a
//   { level, nextIFDOffset, _largestNeeded }
// or a { _needMoreBytes } refetch request. `inheritedTiepoint` /
// `inheritedNoData` propagate when an overview IFD omits them (some GDAL
// writers strip those tags from the pyramid levels).
function _parseIFD(ifdOffset, view, headerBytes, LE, inheritedTiepoint, inheritedNoData) {
  if (ifdOffset + 2 > headerBytes.byteLength) {
    return { _needMoreBytes: ifdOffset + 4096 };
  }
  const numEntries = view.getUint16(ifdOffset, LE);
  const entriesStart = ifdOffset + 2;
  if (entriesStart + numEntries * 12 + 4 > headerBytes.byteLength) {
    return { _needMoreBytes: entriesStart + numEntries * 12 + 4 };
  }

  const tags = {};
  let largestNeeded = entriesStart + numEntries * 12 + 4;
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
  if (compression !== 1 && compression !== 5 && compression !== 8 && compression !== 32946) {
    throw new Error(`unsupported compression=${compression}`);
  }
  const tileOffsets    = readTag(T_TileOffsets);
  const tileByteCounts = readTag(T_TileByteCounts);
  if (!tileOffsets || !tileByteCounts) {
    throw new Error('missing TileOffsets / TileByteCounts');
  }

  const pixelScale = readTag(T_ModelPixelScaleTag); // [sx, sy, sz]
  const tiepoint   = readTag(T_ModelTiepointTag) || inheritedTiepoint;
  const nodataTag  = readTag(T_GDAL_NODATA);
  let nodata = inheritedNoData;
  if (nodataTag && nodataTag.length > 0) {
    let str = '';
    for (let i = 0; i < nodataTag.length; i++) {
      const c = nodataTag[i];
      if (c === 0) break;
      str += String.fromCharCode(c);
    }
    const n = parseFloat(str);
    if (Number.isFinite(n)) nodata = n;
  }

  // pixelScale / tiepoint: overview IFDs frequently omit them; derive from
  // dimension ratio against IFD0 in caller if missing.
  const tilesAcross = Math.ceil(width / tileW);
  const tilesDown   = Math.ceil(height / tileH);

  // Read NextIFDOffset (last 4 bytes of the directory).
  const nextIFDOffset = view.getUint32(entriesStart + numEntries * 12, LE);

  const level = {
    width, height,
    tileW, tileH,
    tilesAcross, tilesDown,
    compression,
    tileOffsets,
    tileByteCounts,
    pixelScale,    // null if absent — caller will derive
    tiepoint,      // 6-element array or null
    nodata,
  };
  return { level, nextIFDOffset, _largestNeeded: largestNeeded };
}

async function parseSwissCOGHeader(url, headerBytes) {
  if (headerBytes.byteLength < 16) throw new Error('header too short');
  const view = new DataView(headerBytes.buffer, headerBytes.byteOffset, headerBytes.byteLength);

  const bo = view.getUint16(0, true);
  let LE;
  if (bo === 0x4949) LE = true;
  else if (bo === 0x4D4D) LE = false;
  else throw new Error('not a TIFF');

  const magic = view.getUint16(2, LE);
  if (magic !== 42) throw new Error(`unsupported TIFF magic ${magic}`);

  let nextOffset = view.getUint32(4, LE);
  const rawLevels = [];
  let inheritedTiepoint = null;
  let inheritedNoData = NaN;
  let safety = 0;
  let largestNeededOverall = 0;

  while (nextOffset !== 0 && safety < 16) {
    const r = _parseIFD(nextOffset, view, headerBytes, LE, inheritedTiepoint, inheritedNoData);
    if (r._needMoreBytes) {
      // Surface refetch request. Use the larger of this IFD's need and any
      // earlier-discovered overrun so we don't ping-pong refetches.
      return { _needMoreBytes: Math.max(r._needMoreBytes, largestNeededOverall) };
    }
    rawLevels.push(r.level);
    if (r._largestNeeded > largestNeededOverall) largestNeededOverall = r._largestNeeded;
    if (r.level.tiepoint) inheritedTiepoint = r.level.tiepoint;
    if (Number.isFinite(r.level.nodata)) inheritedNoData = r.level.nodata;
    nextOffset = r.nextIFDOffset;
    safety++;
  }
  if (rawLevels.length === 0) throw new Error('no IFDs found');

  // IFD0 must have georeferencing.
  const lvl0 = rawLevels[0];
  if (!lvl0.pixelScale || !lvl0.tiepoint || lvl0.tiepoint.length < 6) {
    throw new Error('missing georeferencing tags on IFD0');
  }
  const [sx0, sy0] = lvl0.pixelScale;
  const [I0, J0, , X0, Y0] = lvl0.tiepoint;
  const originE = X0 - I0 * sx0;
  const originN = Y0 + J0 * sy0;

  // Build levels[]. For overview IFDs without explicit pixelScale, derive
  // from the dimension ratio against IFD0 (standard COG convention).
  const levels = rawLevels.map((lv, idx) => {
    let pixelScaleX, pixelScaleY;
    if (lv.pixelScale) {
      pixelScaleX = lv.pixelScale[0];
      pixelScaleY = lv.pixelScale[1];
    } else {
      pixelScaleX = sx0 * (lvl0.width / lv.width);
      pixelScaleY = sy0 * (lvl0.height / lv.height);
    }
    return {
      idx,
      width: lv.width,
      height: lv.height,
      tileW: lv.tileW,
      tileH: lv.tileH,
      tilesAcross: lv.tilesAcross,
      tilesDown: lv.tilesDown,
      compression: lv.compression,
      tileOffsets: lv.tileOffsets,
      tileByteCounts: lv.tileByteCounts,
      pixelScaleX,
      pixelScaleY,
    };
  });

  // Sort levels by ascending pixelScale (level 0 = finest). swisstopo COGs
  // already write them in this order but enforce defensively.
  levels.sort((a, b) => a.pixelScaleX - b.pixelScaleX);
  for (let i = 0; i < levels.length; i++) levels[i].idx = i;

  const nodata = Number.isFinite(lvl0.nodata) ? lvl0.nodata : NaN;

  return {
    url,
    LE,
    levels,
    originE, originN,
    nodata,
    // Bounding box (LV95) from level 0
    Emin: originE,
    Emax: originE + levels[0].width * levels[0].pixelScaleX,
    Nmax: originN,
    Nmin: originN - levels[0].height * levels[0].pixelScaleY,
  };
}

// Pick the coarsest level whose pixelScale is still ≤ desired output mpp.
// If the requested mpp is finer than the COG's native resolution, return
// level 0. Caller should clamp mppOut to a sane lower bound (e.g. native
// 0.5 m) — we don't oversample.
function pickSwissCOGLevel(cog, mppOut) {
  const levels = cog.levels;
  let best = 0;
  for (let i = 1; i < levels.length; i++) {
    if (levels[i].pixelScaleX <= mppOut) best = i;
    else break;
  }
  return best;
}

// ─── Internal-tile fetch + decode ───────────────────────────────────────────

async function fetchAndDecodeTile(cog, levelIdx, tileIndex, fetcher) {
  const level = cog.levels[levelIdx];
  if (!level) return null;
  const offset = level.tileOffsets[tileIndex];
  const length = level.tileByteCounts[tileIndex];
  if (!Number.isFinite(offset) || !Number.isFinite(length) || length <= 0) {
    return null;
  }
  const buf = await fetcher(cog.url, offset, length);
  if (!buf) return null;

  let raw;
  if (level.compression === 1) {
    raw = new Uint8Array(buf);
  } else if (level.compression === 5) {
    try {
      raw = decodeTIFFLZW(new Uint8Array(buf));
    } catch (e) {
      console.warn(`[swiss-cog] LZW decode failed for L${levelIdx}/${tileIndex}:`, e?.message || e);
      return null;
    }
  } else if (level.compression === 8 || level.compression === 32946) {
    raw = await inflateDeflate(new Uint8Array(buf));
  } else {
    console.warn(`[swiss-cog] unsupported compression=${level.compression} for L${levelIdx}/${tileIndex}`);
    return null;
  }

  const expectedBytes = level.tileW * level.tileH * 4;
  if (raw.byteLength < expectedBytes) {
    if (DEBUG) console.warn(`[swiss-cog] short tile L${levelIdx}/${tileIndex}: ${raw.byteLength}/${expectedBytes}`);
    return null;
  }

  return new Float32Array(raw.buffer, raw.byteOffset, level.tileW * level.tileH);
}

// Convert LV95 (E, N) → image (px, py) in *pixel-centre* coordinates for
// the chosen pyramid level.
function cogLV95ToPixel(cog, level, E, N) {
  const px = (E - cog.originE) / level.pixelScaleX;
  const py = (cog.originN - N) / level.pixelScaleY;
  return { px, py };
}

// Bilinear-sample a single LV95 point at the given pyramid level. Returns
// NaN if outside bounds or no data. The COG object must expose a
// `getInternalTile(levelIdx, tileIndex)` async helper (memoised by caller).
async function sampleSwissCOG(cog, levelIdx, E, N, getInternalTile) {
  if (E < cog.Emin || E > cog.Emax || N < cog.Nmin || N > cog.Nmax) return NaN;
  const level = cog.levels[levelIdx];
  if (!level) return NaN;

  const { px, py } = cogLV95ToPixel(cog, level, E, N);
  const x0 = Math.max(0, Math.min(Math.floor(px), level.width - 1));
  const y0 = Math.max(0, Math.min(Math.floor(py), level.height - 1));
  const x1 = Math.min(x0 + 1, level.width - 1);
  const y1 = Math.min(y0 + 1, level.height - 1);
  const fx = px - x0;
  const fy = py - y0;

  const sampleAt = async (x, y) => {
    const tx = (x / level.tileW) | 0;
    const ty = (y / level.tileH) | 0;
    const tileIndex = ty * level.tilesAcross + tx;
    const tile = await getInternalTile(levelIdx, tileIndex);
    if (!tile) return NaN;
    const lx = x - tx * level.tileW;
    const ly = y - ty * level.tileH;
    const v = tile[ly * level.tileW + lx];
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
