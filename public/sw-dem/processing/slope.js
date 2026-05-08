// ---------------------------------------------------------------------------
// Slope computation from DEM elevations
// Uses Horn's method (3×3 neighborhood) on a 258×258 padded buffer stitched
// from the DEM cache — eliminates the visible seams that edge-replication
// produces between adjacent slope tiles.
//
// Output: 8-bit slope-only RGBA PNG with a sqrt-gamma encoding.
//   - R encodes the slope angle on a perceptual ramp:
//       R = round(sqrt(deg / 90) * 255)
//       deg = (R / 255)^2 * 90      (recovered GPU-side)
//     The sqrt is critical: it concentrates the 256 distinct codes near low
//     slopes (≈0.04°/step at 0°, ≈0.56°/step at 90°), so the 0–7° "flat"
//     band — where any quantization is most visible — gets ~67 codes
//     instead of the ~20 codes a linear 8-bit ramp would give.
//   - G,B = 0
//   - A   = 0 on NoData, 255 otherwise
//
// Why a SINGLE channel instead of the previous 16-bit RG packing:
//   raster-resampling: 'linear' bilinearly interpolates each channel
//   independently. With 16-bit RG, every R-byte boundary (~0.35°) makes
//   bilinear sampling produce nonsense decoded values between adjacent
//   pixels — visible as a regular dot/grid moiré on otherwise smooth
//   terrain. A single-channel ramp interpolates correctly under bilinear,
//   eliminating the artefact entirely without any smoothing post-pass.
//
// Colorisation, hide-bands, and colour-mode (gradient/step) are applied
// GPU-side via Mapbox `raster-color` + `raster-color-mix` paint properties.
// This means the SW caches a SINGLE PNG per (z, x, y, resFactor) — colour
// changes, band-toggles and mode swaps are instantaneous (no tile refetch,
// no SW round-trip, no DEM re-decode, no PNG re-encode).
// ---------------------------------------------------------------------------

// DEM PNG decode is one of the hottest CPU paths in the 1 m slope overlay.
// A cold viewport can ask each elevation tile as: own DEM for its slope tile
// plus north/east/south/west neighbour for four adjacent slope tiles. Without
// an in-memory decoded cache, that is up to 5 Terrain-RGB decodes per DEM tile
// on top of CacheStorage blob reads. Keep a small LRU of Float32Array grids in
// the service worker so visible-tile slope builds share decoded elevations.
const SLOPE_DECODED_DEM_CACHE_MAX = 160;
const slopeDecodedDemCache = new Map();
const slopeDecodedDemInflight = new Map();
let slopeDecodeCacheGeneration = 0;

function slopeDemDecodeKey(z, x, y, demProfile) {
  return `${demProfile || 'default'}:${z}/${x}/${y}`;
}

function rememberSlopeDecodedDem(key, elevations, generation) {
  if (!elevations) return elevations;
  if (generation !== slopeDecodeCacheGeneration) return elevations;
  if (slopeDecodedDemCache.has(key)) slopeDecodedDemCache.delete(key);
  slopeDecodedDemCache.set(key, elevations);
  while (slopeDecodedDemCache.size > SLOPE_DECODED_DEM_CACHE_MAX) {
    const oldest = slopeDecodedDemCache.keys().next().value;
    if (oldest === undefined) break;
    slopeDecodedDemCache.delete(oldest);
  }
  return elevations;
}

async function decodeSlopeDemBlob(demBlob, z, x, y, demProfile) {
  const key = slopeDemDecodeKey(z, x, y, demProfile);
  if (slopeDecodedDemCache.has(key)) {
    const cached = slopeDecodedDemCache.get(key);
    slopeDecodedDemCache.delete(key);
    slopeDecodedDemCache.set(key, cached);
    return cached;
  }
  if (slopeDecodedDemInflight.has(key)) return slopeDecodedDemInflight.get(key);

  const generation = slopeDecodeCacheGeneration;
  const work = decodeTerrainRGBBlob(demBlob)
    .then((elevations) => rememberSlopeDecodedDem(key, elevations, generation))
    .finally(() => slopeDecodedDemInflight.delete(key));
  slopeDecodedDemInflight.set(key, work);
  return work;
}

function clearSlopeProcessingCaches() {
  slopeDecodeCacheGeneration++;
  slopeDecodedDemCache.clear();
  slopeDecodedDemInflight.clear();
}

function invalidateSlopeProcessingTile(z, x, y) {
  slopeDecodeCacheGeneration++;
  slopeDecodedDemCache.delete(slopeDemDecodeKey(z, x, y, 'default'));
  slopeDecodedDemCache.delete(slopeDemDecodeKey(z, x, y, 'terrain'));
  slopeDecodedDemInflight.delete(slopeDemDecodeKey(z, x, y, 'default'));
  slopeDecodedDemInflight.delete(slopeDemDecodeKey(z, x, y, 'terrain'));
}

function isValidSlopeTileCoord(z, x, y) {
  const n = 1 << z;
  return x >= 0 && y >= 0 && x < n && y < n;
}

// ── Ground-cell size (meters per DEM pixel) ───────────────────────────
function computeCellSize(z, x, y, tileSize) {
  const bounds = mercatorTileBounds(z, x, y);
  const midLat = (bounds.north + bounds.south) / 2;
  const latRad = (midLat * Math.PI) / 180;
  const metersX = ((bounds.east - bounds.west) * Math.PI * 6378137 * Math.cos(latRad)) / 180;
  const metersY = ((bounds.north - bounds.south) * Math.PI * 6378137) / 180;
  return { cellSizeX: metersX / tileSize, cellSizeY: metersY / tileSize };
}

// ── Padded elevation buffer: 258×258 with 1 px border from neighbour tiles ──
// When a neighbour tile is absent from the DEM cache (not yet loaded or
// outside coverage) we replicate the own-tile edge — identical to the old
// behaviour, so there is no regression; where neighbours *are* cached (the
// common case during steady viewing) the seam disappears.
function buildSlopeDemCachePath(z, x, y, demProfile) {
  return demProfile === 'terrain'
    ? `/dem-tiles/${z}/${x}/${y}?rv-dem-profile=terrain`
    : `/dem-tiles/${z}/${x}/${y}`;
}

async function buildPaddedElevations(ownElev, z, x, y, demCache, demProfile) {
  const S = DEM_TILE_SIZE;
  const P = S + 2;
  const pad = new Float32Array(P * P);
  const missingNeighbours = [];

  // Copy own tile into interior [1..S, 1..S]
  for (let r = 0; r < S; r++) {
    pad.set(ownElev.subarray(r * S, (r + 1) * S), (r + 1) * P + 1);
  }

  async function cachedElev(nx, ny) {
    if (!isValidSlopeTileCoord(z, nx, ny)) return null;
    if (!demCache) {
      missingNeighbours.push([nx, ny]);
      return null;
    }
    const resp = await demCache.match(new Request(buildSlopeDemCachePath(z, nx, ny, demProfile)));
    if (!resp || resp.status !== 200) {
      missingNeighbours.push([nx, ny]);
      return null;
    }
    try { return await decodeSlopeDemBlob(await resp.clone().blob(), z, nx, ny, demProfile); }
    catch {
      missingNeighbours.push([nx, ny]);
      return null;
    }
  }

  const [nN, nE, nS, nW] = await Promise.all([
    cachedElev(x, y - 1),
    cachedElev(x + 1, y),
    cachedElev(x, y + 1),
    cachedElev(x - 1, y),
  ]);

  // Top row (pad row 0) — take last row of north neighbour, else replicate
  for (let c = 0; c < S; c++) {
    pad[0 * P + (c + 1)] = nN ? nN[(S - 1) * S + c] : ownElev[c];
  }
  // Bottom row (pad row S+1)
  for (let c = 0; c < S; c++) {
    pad[(S + 1) * P + (c + 1)] = nS ? nS[c] : ownElev[(S - 1) * S + c];
  }
  // Left column (pad col 0)
  for (let r = 0; r < S; r++) {
    pad[(r + 1) * P + 0] = nW ? nW[r * S + (S - 1)] : ownElev[r * S];
  }
  // Right column (pad col S+1)
  for (let r = 0; r < S; r++) {
    pad[(r + 1) * P + (S + 1)] = nE ? nE[r * S] : ownElev[r * S + (S - 1)];
  }
  // Four corners — replicate the own-tile corner (minor inaccuracy only on
  // two pixels; trying to fetch diagonal neighbours is not worth the latency)
  pad[0] = ownElev[0];
  pad[S + 1] = ownElev[S - 1];
  pad[(S + 1) * P] = ownElev[(S - 1) * S];
  pad[(S + 1) * P + (S + 1)] = ownElev[(S - 1) * S + (S - 1)];

  return {
    pad,
    missingNeighbours,
    edgeNeighbours: {
      north: Boolean(nN),
      east: Boolean(nE),
      south: Boolean(nS),
      west: Boolean(nW),
    },
  };
}

// ── Horn's method on the padded buffer ────────────────────────────────
// Inner loop has no clamping branches — the pad row/column already covers
// the edge case. Branches-free makes the JIT produce tight SIMD-friendly code.
function computeSlopesFromPadded(pad, cellSizeX, cellSizeY) {
  const S = DEM_TILE_SIZE;
  const P = S + 2;
  const slopes = new Float32Array(S * S);
  const inv8x = 1 / (8 * cellSizeX);
  const inv8y = 1 / (8 * cellSizeY);
  const RAD2DEG = 180 / Math.PI;

  for (let row = 0; row < S; row++) {
    const r0 = row * P;         // pad row (row-1 of 3×3)
    const r1 = (row + 1) * P;   // pad row (row   of 3×3)
    const r2 = (row + 2) * P;   // pad row (row+1 of 3×3)
    const outRow = row * S;
    for (let col = 0; col < S; col++) {
      const a = pad[r0 + col];
      const b = pad[r0 + col + 1];
      const c = pad[r0 + col + 2];
      const d = pad[r1 + col];
      const f = pad[r1 + col + 2];
      const g = pad[r2 + col];
      const h = pad[r2 + col + 1];
      const i = pad[r2 + col + 2];

      const dzDx = ((c + 2 * f + i) - (a + 2 * d + g)) * inv8x;
      const dzDy = ((g + 2 * h + i) - (a + 2 * b + c)) * inv8y;
      slopes[outRow + col] = Math.atan(Math.sqrt(dzDx * dzDx + dzDy * dzDy)) * RAD2DEG;
    }
  }
  return slopes;
}

// ── Slope-only RGBA PNG (R = sqrt-encoded angle, A = NoData mask) ─────
async function encodeSlopePng(slopes, ownElev, edgeNeighbours) {
  const size = DEM_TILE_SIZE;
  const n = size * size;
  const rgba = new Uint8Array(n * 4);

  // ── Border slope clamping ───────────────────────────────────────────
  // Only clamp fallback borders where the neighbour DEM was missing. When a
  // neighbour is available, Horn's kernel already used its edge samples; if we
  // overwrite that result with the own-tile interior we reintroduce a visible
  // per-tile demarcation in 1 m terrain mode.
  if (!edgeNeighbours?.north) {
    for (let c = 0; c < size; c++) slopes[c] = slopes[size + c];
  }
  if (!edgeNeighbours?.south) {
    for (let c = 0; c < size; c++) slopes[(size - 1) * size + c] = slopes[(size - 2) * size + c];
  }
  if (!edgeNeighbours?.west) {
    for (let r = 0; r < size; r++) slopes[r * size] = slopes[r * size + 1];
  }
  if (!edgeNeighbours?.east) {
    for (let r = 0; r < size; r++) slopes[r * size + size - 1] = slopes[r * size + size - 2];
  }

  // sqrt-gamma encoding: R = round(sqrt(deg/90) * 255). See header comment.
  const INV_MAX = 1 / 90;

  for (let j = 0; j < n; j++) {
    const elev = ownElev[j];
    const idx = j * 4;
    if (elev <= DEM_NODATA_THRESHOLD) {
      // Transparent on NoData — keeps the ortho visible where DEM is absent
      rgba[idx + 3] = 0;
      continue;
    }
    let d = slopes[j];
    if (d < 0) d = 0; else if (d > 90) d = 90;
    const enc = Math.max(0, Math.min(255, Math.round(Math.sqrt(d * INV_MAX) * 255)));
    rgba[idx] = enc;
    rgba[idx + 1] = 0;
    rgba[idx + 2] = 0;
    rgba[idx + 3] = 255;
  }

  return buildRawPng(size, size, rgba);
}

// ── Resolution downsampling ──────────────────────────────────────────
// The user picks a target ground resolution in the Control Panel. We honour
// it by box-averaging the per-pixel slope values into N×N blocks ("on fait
// une moyenne" — see UX request). Block-fill keeps the output buffer the
// same 256×256 grid so all downstream encoding stays unchanged.
function downsampleSlopes(slopes, factor) {
  if (!factor || factor <= 1) return slopes;
  const S = DEM_TILE_SIZE;
  const out = new Float32Array(S * S);
  for (let by = 0; by < S; by += factor) {
    const yEnd = Math.min(by + factor, S);
    for (let bx = 0; bx < S; bx += factor) {
      const xEnd = Math.min(bx + factor, S);
      let sum = 0, n = 0;
      for (let y = by; y < yEnd; y++) {
        const row = y * S;
        for (let x = bx; x < xEnd; x++) {
          sum += slopes[row + x];
          n++;
        }
      }
      const avg = n > 0 ? sum / n : 0;
      for (let y = by; y < yEnd; y++) {
        const row = y * S;
        for (let x = bx; x < xEnd; x++) {
          out[row + x] = avg;
        }
      }
    }
  }
  return out;
}

// ── Full pipeline — DEM blob → slope PNG blob ─────────────────────────
// `demCache` is optional; when provided we borrow neighbour tile borders
// to seam-correct the slope at tile edges.
//
// No CPU-side smoothing: the previous 1-2-1 separable blur was masking the
// real artefact (16-bit RG bilinear glitch). With single-channel sqrt-gamma
// encoding the GPU samples the slope ramp cleanly and shows the raw 1 m
// terrain signal as-is — no flou needed.
async function buildSlopeTile(demBlob, z, x, y, demCache, resFactor, demProfile) {
  const t0 = performance.now();
  const ownElev = await decodeSlopeDemBlob(demBlob, z, x, y, demProfile);
  const t1 = performance.now();
  const { cellSizeX, cellSizeY } = computeCellSize(z, x, y, DEM_TILE_SIZE);
  const { pad, missingNeighbours, edgeNeighbours } = await buildPaddedElevations(ownElev, z, x, y, demCache, demProfile);
  const t2 = performance.now();
  let slopes = computeSlopesFromPadded(pad, cellSizeX, cellSizeY);
  if (resFactor && resFactor > 1) slopes = downsampleSlopes(slopes, resFactor | 0);
  const t3 = performance.now();
  const blob = await encodeSlopePng(slopes, ownElev, edgeNeighbours);
  const t4 = performance.now();

  if (DEBUG) {
    console.log(
      `[slope] ${z}/${x}/${y} dec=${(t1 - t0).toFixed(0)} pad=${(t2 - t1).toFixed(0)} horn=${(t3 - t2).toFixed(0)} enc=${(t4 - t3).toFixed(0)} total=${(t4 - t0).toFixed(0)}ms res=${resFactor || 1} profile=${demProfile || 'default'} missingN=${missingNeighbours.length}`
    );
  }
  return { blob, missingNeighbours };
}

