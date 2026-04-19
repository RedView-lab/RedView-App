// ---------------------------------------------------------------------------
// Slope computation from DEM elevations
// Uses Horn's method (3×3 neighborhood) on a 258×258 padded buffer stitched
// from the DEM cache — eliminates the visible seams that edge-replication
// produces between adjacent slope tiles. Output is a pre-coloured RGBA PNG
// so the raster layer renders with zero GPU-side decode cost.
// ---------------------------------------------------------------------------

// ── Ground-cell size (meters per DEM pixel) ───────────────────────────
function computeCellSize(z, x, y, tileSize) {
  const bounds = mercatorTileBounds(z, x, y);
  const midLat = (bounds.north + bounds.south) / 2;
  const latRad = (midLat * Math.PI) / 180;
  const metersX = ((bounds.east - bounds.west) * Math.PI * 6378137 * Math.cos(latRad)) / 180;
  const metersY = ((bounds.north - bounds.south) * Math.PI * 6378137) / 180;
  return { cellSizeX: metersX / tileSize, cellSizeY: metersY / tileSize };
}

// ── Colour LUT (1° buckets, 0..90) ────────────────────────────────────
// Pre-built once per colour mode. Encode loop becomes a single table lookup
// per pixel which is ~3× faster than the former per-pixel interpolation.
const SLOPE_COLOR_STOPS = [
  { deg:  0, r: 0x2D, g: 0xBF, b: 0x5E },
  { deg:  7, r: 0xFF, g: 0xD8, b: 0x4D },
  { deg: 15, r: 0xFF, g: 0xA0, b: 0x33 },
  { deg: 25, r: 0xFF, g: 0x57, b: 0x33 },
  { deg: 35, r: 0xE5, g: 0x26, b: 0x1F },
  { deg: 45, r: 0x8B, g: 0x00, b: 0x00 },
];

function _lutGradient() {
  const lut = new Uint8Array(91 * 3);
  const stops = SLOPE_COLOR_STOPS;
  for (let d = 0; d <= 90; d++) {
    let r, g, b;
    if (d <= stops[0].deg) { r = stops[0].r; g = stops[0].g; b = stops[0].b; }
    else if (d >= stops[stops.length - 1].deg) {
      const s = stops[stops.length - 1]; r = s.r; g = s.g; b = s.b;
    } else {
      for (let i = 0; i < stops.length - 1; i++) {
        if (d >= stops[i].deg && d < stops[i + 1].deg) {
          const t = (d - stops[i].deg) / (stops[i + 1].deg - stops[i].deg);
          r = Math.round(stops[i].r + t * (stops[i + 1].r - stops[i].r));
          g = Math.round(stops[i].g + t * (stops[i + 1].g - stops[i].g));
          b = Math.round(stops[i].b + t * (stops[i + 1].b - stops[i].b));
          break;
        }
      }
    }
    lut[d * 3] = r; lut[d * 3 + 1] = g; lut[d * 3 + 2] = b;
  }
  return lut;
}

function _lutStep() {
  const lut = new Uint8Array(91 * 3);
  const stops = SLOPE_COLOR_STOPS;
  for (let d = 0; d <= 90; d++) {
    let s = stops[0];
    for (let i = stops.length - 1; i >= 0; i--) {
      if (d >= stops[i].deg) { s = stops[i]; break; }
    }
    lut[d * 3] = s.r; lut[d * 3 + 1] = s.g; lut[d * 3 + 2] = s.b;
  }
  return lut;
}

const SLOPE_LUT_GRADIENT = _lutGradient();
const SLOPE_LUT_STEP = _lutStep();

// ── Padded elevation buffer: 258×258 with 1 px border from neighbour tiles ──
// When a neighbour tile is absent from the DEM cache (not yet loaded or
// outside coverage) we replicate the own-tile edge — identical to the old
// behaviour, so there is no regression; where neighbours *are* cached (the
// common case during steady viewing) the seam disappears.
async function buildPaddedElevations(ownElev, z, x, y, demCache) {
  const S = DEM_TILE_SIZE;
  const P = S + 2;
  const pad = new Float32Array(P * P);

  // Copy own tile into interior [1..S, 1..S]
  for (let r = 0; r < S; r++) {
    pad.set(ownElev.subarray(r * S, (r + 1) * S), (r + 1) * P + 1);
  }

  async function cachedElev(nx, ny) {
    if (!demCache) return null;
    const resp = await demCache.match(new Request(`/dem-tiles/${z}/${nx}/${ny}`));
    if (!resp || resp.status !== 200) return null;
    try { return await decodeTerrainRGBBlob(await resp.clone().blob()); }
    catch { return null; }
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

  return pad;
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

// ── Pre-coloured RGBA PNG with LUT + NoData alpha ─────────────────────
async function encodeSlopePng(slopes, ownElev, colorMode, hiddenRanges, dynamicStops) {
  const size = DEM_TILE_SIZE;
  const n = size * size;
  const rgba = new Uint8Array(n * 4);

  // Build LUT: use dynamic stops if provided, else fallback to hardcoded
  const stops = dynamicStops || SLOPE_COLOR_STOPS;
  let lut;
  if (colorMode === 'step') {
    lut = _buildLutStep(stops);
  } else {
    lut = _buildLutGradient(stops);
  }

  const hasHide = Array.isArray(hiddenRanges) && hiddenRanges.length > 0;

  for (let j = 0; j < n; j++) {
    const elev = ownElev[j];
    const idx = j * 4;
    if (elev <= DEM_NODATA_THRESHOLD) {
      // Transparent on NoData — keeps the ortho visible where DEM is absent
      rgba[idx + 3] = 0;
      continue;
    }
    // Clamp degrees to [0, 90]
    let d = slopes[j];
    if (d < 0) d = 0; else if (d > 90) d = 90;

    // Hidden-band check: make pixels in those degree ranges fully transparent
    if (hasHide) {
      let hidden = false;
      for (let h = 0; h < hiddenRanges.length; h++) {
        const r = hiddenRanges[h];
        if (d >= r[0] && d < r[1]) { hidden = true; break; }
      }
      if (hidden) { rgba[idx + 3] = 0; continue; }
    }

    const k = (d + 0.5) | 0;
    const lo = k * 3;
    rgba[idx]     = lut[lo];
    rgba[idx + 1] = lut[lo + 1];
    rgba[idx + 2] = lut[lo + 2];
    rgba[idx + 3] = 255;
  }

  return buildRawPng(size, size, rgba);
}

// Dynamic LUT builders that accept any stops array [{deg, r, g, b}, ...]
function _buildLutGradient(stops) {
  const lut = new Uint8Array(91 * 3);
  for (let d = 0; d <= 90; d++) {
    let r, g, b;
    if (d <= stops[0].deg) { r = stops[0].r; g = stops[0].g; b = stops[0].b; }
    else if (d >= stops[stops.length - 1].deg) {
      const s = stops[stops.length - 1]; r = s.r; g = s.g; b = s.b;
    } else {
      for (let i = 0; i < stops.length - 1; i++) {
        if (d >= stops[i].deg && d < stops[i + 1].deg) {
          const t = (d - stops[i].deg) / (stops[i + 1].deg - stops[i].deg);
          r = Math.round(stops[i].r + t * (stops[i + 1].r - stops[i].r));
          g = Math.round(stops[i].g + t * (stops[i + 1].g - stops[i].g));
          b = Math.round(stops[i].b + t * (stops[i + 1].b - stops[i].b));
          break;
        }
      }
    }
    lut[d * 3] = r; lut[d * 3 + 1] = g; lut[d * 3 + 2] = b;
  }
  return lut;
}

function _buildLutStep(stops) {
  const lut = new Uint8Array(91 * 3);
  for (let d = 0; d <= 90; d++) {
    let s = stops[0];
    for (let i = stops.length - 1; i >= 0; i--) {
      if (d >= stops[i].deg) { s = stops[i]; break; }
    }
    lut[d * 3] = s.r; lut[d * 3 + 1] = s.g; lut[d * 3 + 2] = s.b;
  }
  return lut;
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
async function buildSlopeTile(demBlob, z, x, y, colorMode, demCache, hiddenRanges, dynamicStops, resFactor) {
  const t0 = performance.now();
  const ownElev = await decodeTerrainRGBBlob(demBlob);
  const t1 = performance.now();
  const { cellSizeX, cellSizeY } = computeCellSize(z, x, y, DEM_TILE_SIZE);
  const pad = await buildPaddedElevations(ownElev, z, x, y, demCache);
  const t2 = performance.now();
  let slopes = computeSlopesFromPadded(pad, cellSizeX, cellSizeY);
  if (resFactor && resFactor > 1) slopes = downsampleSlopes(slopes, resFactor | 0);
  const t3 = performance.now();
  const blob = await encodeSlopePng(slopes, ownElev, colorMode, hiddenRanges, dynamicStops);
  const t4 = performance.now();

  if (DEBUG) {
    console.log(
      `[slope] ${z}/${x}/${y} dec=${(t1 - t0).toFixed(0)} pad=${(t2 - t1).toFixed(0)} horn=${(t3 - t2).toFixed(0)} enc=${(t4 - t3).toFixed(0)} total=${(t4 - t0).toFixed(0)}ms res=${resFactor || 1}`
    );
  }
  return blob;
}

