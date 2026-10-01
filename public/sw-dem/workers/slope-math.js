// ---------------------------------------------------------------------------
// Slope math — PURE functions shared by the in-process SW path (slope.js)
// and the dedicated slope worker pool (slope-pool.worker.js).
//
// NOTHING in this file may reference SW-only globals (no SLOPE_INFLIGHT,
// no demCache, no caches, no self.clients). It depends only on:
//   - config constants  (DEM_TILE_SIZE, DEM_NODATA_THRESHOLD, …)
//   - terrain-rgb.js    (buildGrayPng, buildGrayAlphaPng)
//
// Both slope.js (in-process fallback) and the worker importScripts this
// module so the Horn kernel, the upsample and the PNG encode live in exactly
// ONE place: pool and in-process outputs are byte-identical.
//
// Pipeline (buildSlopePngFromElevations):
//   1. own DEM tile + 3-cell border from the 4 cardinal neighbour tiles
//   2. Horn 3×3 slope on the tile and 2 cells beyond each edge, ground cell
//      size per row (Web Mercator is conformal: same spacing in x and y at a
//      given latitude)
//   3. sqrt-gamma encode: value = sqrt(deg / 90) · 255, kept continuous
//   4. output: native resolution (zone tiles) or 2× Catmull-Rom upsample of
//      the encoded field (terrain-aligned tiles, see slope-source.ts)
//   5. gray PNG — gray + alpha only where a NoData / analysis-zone mask
//      makes part of the tile transparent
//
// Why upsample the SLOPE and never the DEM: Horn on an interpolated DEM turns
// the spline's curvature into ripples at the source spacing. The slope field
// itself is interpolated here exactly like the GPU would (but with a smooth
// cubic instead of bilinear facets), and the 2-cell margin computed from the
// neighbour DEMs makes two adjacent tiles interpolate the same values on
// their shared edge — no seam.
// ---------------------------------------------------------------------------

const SLOPE_EARTH_CIRCUMFERENCE_M = 40075016.686;
// encoded = sqrt(atan(g) / (π/2)) · 255 = sqrt(deg / 90) · 255
const SLOPE_ENC_K = 255 / Math.sqrt(Math.PI / 2);

// DEM cells borrowed from each neighbour: Horn needs 1, the Catmull-Rom
// upsample needs the slope 2 cells beyond the edge, hence 3.
const SLOPE_DEM_BORDER = 3;
const SLOPE_FIELD_MARGIN = SLOPE_DEM_BORDER - 1;

// Catmull-Rom weights for a 2× upsample sampled at pixel centres: output
// pixel 2i sits at source i − 0.25 (taps i−2 … i+1), 2i+1 at i + 0.25
// (taps i−1 … i+2).
const SLOPE_CR_EVEN = [-0.0234375, 0.2265625, 0.8671875, -0.0703125];
const SLOPE_CR_ODD = [-0.0703125, 0.8671875, 0.2265625, -0.0234375];

// ── Padded elevation buffer from PRE-DECODED neighbour elevations ──────
// `neighbourElevations` is { north?, east?, south?, west? } with each value a
// Float32Array(S*S). Missing neighbours are linearly extrapolated (only the
// first border cell feeds a kept slope value — see replicateMissingSlopeMargins).
// Corners have no diagonal neighbour: bilinear-plane extrapolation of the
// two adjacent strips.
function buildPaddedElevationsFromArrays(ownElev, neighbourElevations) {
  const S = DEM_TILE_SIZE;
  const B = SLOPE_DEM_BORDER;
  const P = S + 2 * B;
  const pad = new Float32Array(P * P);
  const nN = neighbourElevations?.north || null;
  const nE = neighbourElevations?.east || null;
  const nS = neighbourElevations?.south || null;
  const nW = neighbourElevations?.west || null;
  const missingDirections = [];
  if (!nN) missingDirections.push('north');
  if (!nE) missingDirections.push('east');
  if (!nS) missingDirections.push('south');
  if (!nW) missingDirections.push('west');

  for (let r = 0; r < S; r++) {
    pad.set(ownElev.subarray(r * S, (r + 1) * S), (r + B) * P + B);
  }

  // North strip: tile rows −1 … −B.
  for (let k = 1; k <= B; k++) {
    const dst = (B - k) * P + B;
    if (nN) {
      pad.set(nN.subarray((S - k) * S, (S - k + 1) * S), dst);
    } else {
      for (let c = 0; c < S; c++) pad[dst + c] = ownElev[c] + k * (ownElev[c] - ownElev[S + c]);
    }
  }
  // South strip: tile rows S … S+B−1.
  for (let k = 0; k < B; k++) {
    const dst = (B + S + k) * P + B;
    if (nS) {
      pad.set(nS.subarray(k * S, (k + 1) * S), dst);
    } else {
      const last = (S - 1) * S;
      const prev = (S - 2) * S;
      for (let c = 0; c < S; c++) {
        pad[dst + c] = ownElev[last + c] + (k + 1) * (ownElev[last + c] - ownElev[prev + c]);
      }
    }
  }
  // West / east strips.
  for (let r = 0; r < S; r++) {
    const row = (r + B) * P;
    const src = r * S;
    for (let k = 1; k <= B; k++) {
      pad[row + B - k] = nW
        ? nW[src + S - k]
        : ownElev[src] + k * (ownElev[src] - ownElev[src + 1]);
    }
    for (let k = 0; k < B; k++) {
      pad[row + B + S + k] = nE
        ? nE[src + k]
        : ownElev[src + S - 1] + (k + 1) * (ownElev[src + S - 1] - ownElev[src + S - 2]);
    }
  }
  // Corner blocks.
  const fillCorner = (r0, r1, c0, c1) => {
    for (let r = r0; r < r1; r++) {
      const re = r < B ? B : B + S - 1;
      for (let c = c0; c < c1; c++) {
        const ce = c < B ? B : B + S - 1;
        pad[r * P + c] = pad[r * P + ce] + pad[re * P + c] - pad[re * P + ce];
      }
    }
  };
  fillCorner(0, B, 0, B);
  fillCorner(0, B, B + S, P);
  fillCorner(B + S, P, 0, B);
  fillCorner(B + S, P, B + S, P);

  return { pad, missingDirections };
}

// ── Horn slope field (encoded, continuous) ────────────────────────────
// Covers the tile plus SLOPE_FIELD_MARGIN cells beyond each edge:
// F = S + 2·M cells per side. The ground cell size follows each row's
// latitude; one value per tile used to skew low-zoom tiles by several percent
// between their top and bottom rows and left a step at every horizontal seam.
function computeSlopeField(pad, z, y) {
  const S = DEM_TILE_SIZE;
  const B = SLOPE_DEM_BORDER;
  const M = SLOPE_FIELD_MARGIN;
  const P = S + 2 * B;
  const F = S + 2 * M;
  const field = new Float32Array(F * F);
  const worldRows = S * 2 ** z;
  const metresPerCellAtEquator = SLOPE_EARTH_CIRCUMFERENCE_M / worldRows;

  for (let fr = 0; fr < F; fr++) {
    const tileRow = fr - M;
    const mercN = Math.PI * (1 - (2 * (y * S + tileRow + 0.5)) / worldRows);
    const cell = metresPerCellAtEquator * Math.cos(Math.atan(Math.sinh(mercN)));
    const inv8 = 1 / (8 * cell);
    const pr = tileRow + B;
    const r0 = (pr - 1) * P;
    const r1 = pr * P;
    const r2 = (pr + 1) * P;
    const out = fr * F;
    for (let fc = 0; fc < F; fc++) {
      const pc = fc - M + B;
      const a = pad[r0 + pc - 1];
      const b = pad[r0 + pc];
      const c = pad[r0 + pc + 1];
      const d = pad[r1 + pc - 1];
      const f = pad[r1 + pc + 1];
      const g = pad[r2 + pc - 1];
      const h = pad[r2 + pc];
      const i = pad[r2 + pc + 1];
      const dzDx = ((c + 2 * f + i) - (a + 2 * d + g)) * inv8;
      const dzDy = ((g + 2 * h + i) - (a + 2 * b + c)) * inv8;
      field[out + fc] = Math.sqrt(Math.atan(Math.sqrt(dzDx * dzDx + dzDy * dzDy))) * SLOPE_ENC_K;
    }
  }
  return field;
}

// Beyond an edge without a neighbour tile the margin would come from
// extrapolated elevations: replicate the edge slope instead.
function replicateMissingSlopeMargins(field, missingDirections) {
  if (!missingDirections.length) return;
  const S = DEM_TILE_SIZE;
  const M = SLOPE_FIELD_MARGIN;
  const F = S + 2 * M;
  const missing = new Set(missingDirections);
  if (missing.has('north')) {
    for (let fr = 0; fr < M; fr++) field.copyWithin(fr * F, M * F, M * F + F);
  }
  if (missing.has('south')) {
    const edge = (M + S - 1) * F;
    for (let fr = M + S; fr < F; fr++) field.copyWithin(fr * F, edge, edge + F);
  }
  if (missing.has('west') || missing.has('east')) {
    for (let fr = 0; fr < F; fr++) {
      const row = fr * F;
      if (missing.has('west')) {
        for (let fc = 0; fc < M; fc++) field[row + fc] = field[row + M];
      }
      if (missing.has('east')) {
        for (let fc = M + S; fc < F; fc++) field[row + fc] = field[row + M + S - 1];
      }
    }
  }
}

function clampSlopeByte(v) {
  if (v <= 0) return 0;
  if (v >= 255) return 255;
  return (v + 0.5) | 0;
}

// Native resolution: the tile's own cells, quantised.
function slopeFieldInterior(field) {
  const S = DEM_TILE_SIZE;
  const M = SLOPE_FIELD_MARGIN;
  const F = S + 2 * M;
  const out = new Uint8Array(S * S);
  for (let r = 0; r < S; r++) {
    const src = (r + M) * F + M;
    const dst = r * S;
    for (let c = 0; c < S; c++) out[dst + c] = clampSlopeByte(field[src + c]);
  }
  return out;
}

// Separable 2× Catmull-Rom of the encoded field → (2S)² bytes.
function upsampleSlopeField2x(field) {
  const S = DEM_TILE_SIZE;
  const M = SLOPE_FIELD_MARGIN;
  const F = S + 2 * M;
  const O = 2 * S;
  const [e0, e1, e2, e3] = SLOPE_CR_EVEN;
  const [o0, o1, o2, o3] = SLOPE_CR_ODD;

  const tmp = new Float32Array(F * O);
  for (let r = 0; r < F; r++) {
    const src = r * F + M;
    const dst = r * O;
    for (let i = 0; i < S; i++) {
      const s = src + i;
      tmp[dst + 2 * i] = e0 * field[s - 2] + e1 * field[s - 1] + e2 * field[s] + e3 * field[s + 1];
      tmp[dst + 2 * i + 1] = o0 * field[s - 1] + o1 * field[s] + o2 * field[s + 1] + o3 * field[s + 2];
    }
  }

  const out = new Uint8Array(O * O);
  for (let i = 0; i < S; i++) {
    const r = M + i;
    const rm2 = (r - 2) * O;
    const rm1 = (r - 1) * O;
    const r00 = r * O;
    const rp1 = (r + 1) * O;
    const rp2 = (r + 2) * O;
    const even = 2 * i * O;
    const odd = even + O;
    for (let c = 0; c < O; c++) {
      out[even + c] = clampSlopeByte(e0 * tmp[rm2 + c] + e1 * tmp[rm1 + c] + e2 * tmp[r00 + c] + e3 * tmp[rp1 + c]);
      out[odd + c] = clampSlopeByte(o0 * tmp[rm1 + c] + o1 * tmp[r00 + c] + o2 * tmp[rp1 + c] + o3 * tmp[rp2 + c]);
    }
  }
  return out;
}

// Nearest-neighbour fallback for the (theoretical) NoData case: a Catmull-Rom
// tap on a NoData cell would bleed its garbage gradient into valid pixels.
function upsampleBytesNearest(bytes, size, scale) {
  const O = size * scale;
  const out = new Uint8Array(O * O);
  for (let r = 0; r < O; r++) {
    const src = ((r / scale) | 0) * size;
    const dst = r * O;
    for (let c = 0; c < O; c++) out[dst + c] = bytes[src + ((c / scale) | 0)];
  }
  return out;
}

// Legacy `?res=N` mode: N×N block average of the native slope.
function blockAverageSlopeBytes(bytes, factor) {
  const S = DEM_TILE_SIZE;
  const out = new Uint8Array(S * S);
  for (let by = 0; by < S; by += factor) {
    const yEnd = Math.min(by + factor, S);
    for (let bx = 0; bx < S; bx += factor) {
      const xEnd = Math.min(bx + factor, S);
      let sum = 0;
      let n = 0;
      for (let yy = by; yy < yEnd; yy++) {
        for (let xx = bx; xx < xEnd; xx++) { sum += bytes[yy * S + xx]; n++; }
      }
      const avg = n > 0 ? Math.round(sum / n) : 0;
      for (let yy = by; yy < yEnd; yy++) out.fill(avg, yy * S + bx, yy * S + xEnd);
    }
  }
  return out;
}

// ── Analysis-zone per-pixel mask ──────────────────────────────────────
// PURE functions (geo.js's mercatorTileBounds only) shared by the SW scope
// and the worker pool, so pool and in-process builds are byte-identical.
//
// rasterizeRingMask projects the polygon ring ([lng, lat] pairs) into tile
// pixel space and fills it with a scanline algorithm at 2× supersampling;
// the 2×2 box downsample gives a natural ~1 px feathered edge so the zone
// boundary doesn't alias against the terrain mesh.

function rasterizeRingMask(ring, z, x, y, size) {
  const n = ring.length;
  if (!n || n < 3) return null;

  // 2× supersampled coverage buffer.
  const ss = 2;
  const sw = size * ss;
  const worldTiles = 1 << z;

  // Project polygon vertices into Web Mercator pixel coordinates in [0, sw] space.
  const px = new Float64Array(n);
  const py = new Float64Array(n);
  for (let i = 0; i < n; i++) {
    const lng = ring[i][0];
    const lat = ring[i][1];

    // X in Web Mercator tile pixel space
    const tileFracX = ((lng + 180) / 360) * worldTiles - x;
    px[i] = tileFracX * sw;

    // Y in Web Mercator tile pixel space
    const latRad = (lat * Math.PI) / 180;
    const sinLat = Math.sin(latRad);
    const clampedSin = Math.max(-0.999999, Math.min(0.999999, sinLat));
    const mercY = 0.5 * Math.log((1 + clampedSin) / (1 - clampedSin));
    const yFrac = 0.5 - mercY / (2 * Math.PI);
    const tileFracY = yFrac * worldTiles - y;
    py[i] = tileFracY * sw;
  }

  const mask = new Uint8Array(sw * sw);
  const xs = [];
  for (let row = 0; row < sw; row++) {
    const sy = row + 0.5;
    xs.length = 0;
    for (let e = 0; e < n; e++) {
      const i1 = (e + 1) % n;
      const y0 = py[e];
      const y1 = py[i1];
      if ((sy >= y0 && sy < y1) || (sy >= y1 && sy < y0)) {
        const t = (sy - y0) / (y1 - y0);
        xs.push(px[e] + t * (px[i1] - px[e]));
      }
    }
    if (xs.length < 2) continue;
    xs.sort((a, c) => a - c);
    const rowBase = row * sw;
    for (let k = 0; k + 1 < xs.length; k += 2) {
      const cx0 = Math.max(0, Math.ceil(xs[k]));
      const cx1 = Math.min(sw - 1, Math.floor(xs[k + 1]));
      for (let cx = cx0; cx <= cx1; cx++) {
        mask[rowBase + cx] = 255;
      }
    }
  }

  // 2×2 average downsample → feathered alpha.
  const out = new Uint8Array(size * size);
  for (let r = 0; r < size; r++) {
    const sRow = r * ss * sw;
    const oRow = r * size;
    for (let c = 0; c < size; c++) {
      const s0 = sRow + c * ss;
      out[oRow + c] = (mask[s0] + mask[s0 + 1] + mask[s0 + sw] + mask[s0 + sw + 1]) >> 2;
    }
  }
  return out;
}

// Multiplies the RGBA alpha channel by the mask (0 → fully transparent,
// 255 → untouched). RGB is left as-is: GPU-side raster-color only reads
// pixels with alpha > 0 (bilinear alpha blend handles the feather).
function applyRingMaskToRgba(rgba, mask) {
  const n = mask.length;
  for (let j = 0; j < n; j++) {
    const m = mask[j];
    if (m >= 255) continue;
    const idx = j * 4;
    if (m === 0) {
      rgba[idx] = 0;
      rgba[idx + 1] = 0;
      rgba[idx + 2] = 0;
      rgba[idx + 3] = 0;
    } else {
      rgba[idx + 3] = ((rgba[idx + 3] * m) + 127) >> 8;
    }
  }
}

// Same as applyRingMaskToRgba for a separate alpha plane.
function applyRingMaskToAlpha(alpha, mask) {
  const n = mask.length;
  for (let j = 0; j < n; j++) {
    const m = mask[j];
    if (m < 255) alpha[j] = ((alpha[j] * m) + 127) >> 8;
  }
}

// ── Orchestrator ──────────────────────────────────────────────────────
// Own elevation + already-decoded neighbour elevations in, PNG out. This is
// the single function the worker pool and the in-process fallback invoke.
//
//   options.outputScale  1 = native DEM resolution (zone tiles),
//                        2 = 2× Catmull-Rom (terrain-aligned tiles)
//   options.resFactor    legacy `?res=N` block average (native output)
//   options.zoneRing     optional [[lng, lat], …] analysis-zone ring
//
// Returns { blob: Blob (gray or gray + alpha PNG), missingDirections: string[] }.
async function buildSlopePngFromElevations(ownElev, neighbourElevations, z, x, y, options = {}) {
  const S = DEM_TILE_SIZE;
  const resFactor = Number(options.resFactor) > 1 ? Math.min(64, Number(options.resFactor) | 0) : 1;
  const outputScale = resFactor > 1 ? 1 : (Number(options.outputScale) >= 2 ? 2 : 1);

  const { pad, missingDirections } = buildPaddedElevationsFromArrays(ownElev, neighbourElevations);
  const field = computeSlopeField(pad, z, y);
  replicateMissingSlopeMargins(field, missingDirections);

  let noData = null;
  for (let j = 0; j < S * S; j++) {
    if (ownElev[j] <= DEM_NODATA_THRESHOLD) {
      if (!noData) noData = new Uint8Array(S * S);
      noData[j] = 1;
    }
  }

  let gray;
  if (resFactor > 1) {
    gray = blockAverageSlopeBytes(slopeFieldInterior(field), resFactor);
  } else if (outputScale === 2) {
    gray = noData
      ? upsampleBytesNearest(slopeFieldInterior(field), S, 2)
      : upsampleSlopeField2x(field);
  } else {
    gray = slopeFieldInterior(field);
  }

  const size = S * outputScale;
  const zoneMask = options.zoneRing ? rasterizeRingMask(options.zoneRing, z, x, y, size) : null;
  // The usual tile is fully opaque: gray-only PNG (half the bytes to deflate).
  if (!noData && !zoneMask) {
    return { blob: await buildGrayPng(size, size, gray), missingDirections };
  }

  const alpha = new Uint8Array(size * size).fill(255);
  if (noData) {
    const mask = outputScale === 2 ? upsampleBytesNearest(noData, S, 2) : noData;
    for (let j = 0; j < alpha.length; j++) {
      if (mask[j]) { alpha[j] = 0; gray[j] = 0; }
    }
  }
  if (zoneMask) applyRingMaskToAlpha(alpha, zoneMask);

  const blob = await buildGrayAlphaPng(size, size, gray, alpha);
  return { blob, missingDirections };
}
