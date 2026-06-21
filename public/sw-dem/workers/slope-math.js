// ---------------------------------------------------------------------------
// Slope math — PURE functions shared by the in-process SW path (slope.js)
// and the dedicated slope worker pool (slope-pool.worker.js).
//
// NOTHING in this file may reference SW-only globals (no SLOPE_INFLIGHT,
// no demCache, no caches, no self.clients). It depends only on:
//   - config constants  (DEM_TILE_SIZE, DEM_NODATA_THRESHOLD, …)
//   - geo.js            (mercatorTileBounds)
//   - terrain-rgb.js    (buildRawPng, decodeTerrainRGBBlob)
//
// Both slope.js (in-process fallback) and the worker importScripts this
// module so the Horn kernel + sqrt-gamma encode + border harmonisation
// live in exactly ONE place. A bug fix here propagates to both paths.
//
// Worker-only orchestrator (no demCache): buildSlopeRgbaFromElevations()
// takes PRE-DECODED neighbour elevations and returns the RGBA buffer +
// the list of neighbour directions that were absent (so the SW can warm
// them after responding). This is what the worker pool calls.
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

// ── Horn's method on the padded buffer ────────────────────────────────
function computeHornSlope(a, b, c, d, f, g, h, i, inv8x, inv8y) {
  const dzDx = ((c + 2 * f + i) - (a + 2 * d + g)) * inv8x;
  const dzDy = ((g + 2 * h + i) - (a + 2 * b + c)) * inv8y;
  return Math.atan(Math.sqrt(dzDx * dzDx + dzDy * dzDy)) * (180 / Math.PI);
}

function clampIndex(value, max) {
  if (value <= 0) return 0;
  if (value >= max) return max;
  return value;
}

function sampleTile(elevations, row, col) {
  const S = DEM_TILE_SIZE;
  if (!elevations) return NaN;
  const rr = clampIndex(row, S - 1);
  const cc = clampIndex(col, S - 1);
  return elevations[rr * S + cc];
}

function computeSlopesFromPadded(pad, cellSizeX, cellSizeY) {
  const S = DEM_TILE_SIZE;
  const P = S + 2;
  const slopes = new Float32Array(S * S);
  const inv8x = 1 / (8 * cellSizeX);
  const inv8y = 1 / (8 * cellSizeY);

  for (let row = 0; row < S; row++) {
    const r0 = row * P;
    const r1 = (row + 1) * P;
    const r2 = (row + 2) * P;
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

      slopes[outRow + col] = computeHornSlope(a, b, c, d, f, g, h, i, inv8x, inv8y);
    }
  }
  return slopes;
}

// ── Padded elevation buffer from PRE-DECODED neighbour elevations ──────
// `neighbourElevations` is { north?, east?, south?, west? } where each
// value is a Float32Array(S*S) or absent. Mirrors buildPaddedElevations()
// in slope.js but takes decoded arrays instead of touching demCache —
// this is the form the worker pool receives (the SW resolved + decoded
// the neighbours before posting the job).
//
// Returns { pad, edgeNeighbours, neighbourElevations, missingDirections }.
function buildPaddedElevationsFromArrays(ownElev, neighbourElevations) {
  const S = DEM_TILE_SIZE;
  const P = S + 2;
  const pad = new Float32Array(P * P);
  const missingDirections = [];

  for (let r = 0; r < S; r++) {
    pad.set(ownElev.subarray(r * S, (r + 1) * S), (r + 1) * P + 1);
  }

  const nN = neighbourElevations?.north || null;
  const nE = neighbourElevations?.east || null;
  const nS = neighbourElevations?.south || null;
  const nW = neighbourElevations?.west || null;
  if (!nN) missingDirections.push('north');
  if (!nE) missingDirections.push('east');
  if (!nS) missingDirections.push('south');
  if (!nW) missingDirections.push('west');

  for (let c = 0; c < S; c++) {
    pad[0 * P + (c + 1)] = nN ? nN[(S - 1) * S + c] : ownElev[c];
  }
  for (let c = 0; c < S; c++) {
    pad[(S + 1) * P + (c + 1)] = nS ? nS[c] : ownElev[(S - 1) * S + c];
  }
  for (let r = 0; r < S; r++) {
    pad[(r + 1) * P + 0] = nW ? nW[r * S + (S - 1)] : ownElev[r * S];
  }
  for (let r = 0; r < S; r++) {
    pad[(r + 1) * P + (S + 1)] = nE ? nE[r * S] : ownElev[r * S + (S - 1)];
  }
  pad[0] = ownElev[0];
  pad[S + 1] = ownElev[S - 1];
  pad[(S + 1) * P] = ownElev[(S - 1) * S];
  pad[(S + 1) * P + (S + 1)] = ownElev[(S - 1) * S + (S - 1)];

  return {
    pad,
    edgeNeighbours: { north: Boolean(nN), east: Boolean(nE), south: Boolean(nS), west: Boolean(nW) },
    neighbourElevations: { north: nN, east: nE, south: nS, west: nW },
    missingDirections,
  };
}

// ── Fused Horn + sqrt-gamma encode in a single pass ───────────────────
function computeAndEncodeSlopeFused(pad, ownElev, cellSizeX, cellSizeY, edgeNeighbours) {
  const S = DEM_TILE_SIZE;
  const P = S + 2;
  const n = S * S;
  const rgba = new Uint8Array(n * 4);
  const inv8x = 1 / (8 * cellSizeX);
  const inv8y = 1 / (8 * cellSizeY);
  const ENC_K = 255 / Math.sqrt(Math.PI / 2);

  for (let row = 0; row < S; row++) {
    const r0 = row * P;
    const r1 = (row + 1) * P;
    const r2 = (row + 2) * P;
    const outRow = row * S;
    for (let col = 0; col < S; col++) {
      const elev = ownElev[outRow + col];
      const idx = (outRow + col) * 4;
      if (elev <= DEM_NODATA_THRESHOLD) {
        rgba[idx + 3] = 0;
        continue;
      }
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
      const gradMag = Math.sqrt(dzDx * dzDx + dzDy * dzDy);
      let enc = Math.sqrt(Math.atan(gradMag)) * ENC_K;
      if (enc < 0) enc = 0; else if (enc > 255) enc = 255;
      rgba[idx] = enc + 0.5 | 0;
      rgba[idx + 3] = 255;
    }
  }

  const copyRgba = (dstIdx, srcIdx) => {
    rgba[dstIdx]     = rgba[srcIdx];
    rgba[dstIdx + 1] = rgba[srcIdx + 1];
    rgba[dstIdx + 2] = rgba[srcIdx + 2];
    rgba[dstIdx + 3] = rgba[srcIdx + 3];
  };
  if (!edgeNeighbours?.north) {
    for (let col = 0; col < S; col++) copyRgba(col * 4, (S + col) * 4);
  }
  if (!edgeNeighbours?.south) {
    const base = (S - 1) * S;
    const src = (S - 2) * S;
    for (let col = 0; col < S; col++) copyRgba((base + col) * 4, (src + col) * 4);
  }
  if (!edgeNeighbours?.west) {
    for (let r = 0; r < S; r++) copyRgba(r * S * 4, (r * S + 1) * 4);
  }
  if (!edgeNeighbours?.east) {
    for (let r = 0; r < S; r++) copyRgba((r * S + S - 1) * 4, (r * S + S - 2) * 4);
  }

  return rgba;
}

function encodeSingleSlopeByte(deg) {
  let d = deg;
  if (d < 0) d = 0; else if (d > 90) d = 90;
  return Math.max(0, Math.min(255, Math.round(Math.sqrt(d / 90) * 255)));
}

function harmonizeSlopeBordersIntoRgba(rgba, ownElev, neighbourElevations, cellSizeX, cellSizeY) {
  if (!neighbourElevations) return;
  const S = DEM_TILE_SIZE;
  const inv8x = 1 / (8 * cellSizeX);
  const inv8y = 1 / (8 * cellSizeY);

  const blend = (idx, paired) => {
    if (rgba[idx + 3] === 0) return;
    const r = rgba[idx];
    const own = (r / 255);
    const ownDeg = own * own * 90;
    const avgDeg = (ownDeg + paired) * 0.5;
    rgba[idx] = encodeSingleSlopeByte(avgDeg);
  };

  if (neighbourElevations.north) {
    const north = neighbourElevations.north;
    for (let col = 0; col < S; col++) {
      const paired = computeHornSlope(
        sampleTile(north, S - 2, col - 1),
        sampleTile(north, S - 2, col),
        sampleTile(north, S - 2, col + 1),
        sampleTile(north, S - 1, col - 1),
        sampleTile(north, S - 1, col + 1),
        sampleTile(ownElev, 0, col - 1),
        sampleTile(ownElev, 0, col),
        sampleTile(ownElev, 0, col + 1),
        inv8x, inv8y,
      );
      blend(col * 4, paired);
    }
  }

  if (neighbourElevations.south) {
    const south = neighbourElevations.south;
    const ownRow = (S - 1) * S;
    for (let col = 0; col < S; col++) {
      const paired = computeHornSlope(
        sampleTile(ownElev, S - 1, col - 1),
        sampleTile(ownElev, S - 1, col),
        sampleTile(ownElev, S - 1, col + 1),
        sampleTile(south, 0, col - 1),
        sampleTile(south, 0, col + 1),
        sampleTile(south, 1, col - 1),
        sampleTile(south, 1, col),
        sampleTile(south, 1, col + 1),
        inv8x, inv8y,
      );
      blend((ownRow + col) * 4, paired);
    }
  }

  if (neighbourElevations.west) {
    const west = neighbourElevations.west;
    for (let row = 0; row < S; row++) {
      const paired = computeHornSlope(
        sampleTile(west, row - 1, S - 2),
        sampleTile(west, row - 1, S - 1),
        sampleTile(ownElev, row - 1, 0),
        sampleTile(west, row, S - 2),
        sampleTile(ownElev, row, 0),
        sampleTile(west, row + 1, S - 2),
        sampleTile(west, row + 1, S - 1),
        sampleTile(ownElev, row + 1, 0),
        inv8x, inv8y,
      );
      blend(row * S * 4, paired);
    }
  }

  if (neighbourElevations.east) {
    const east = neighbourElevations.east;
    for (let row = 0; row < S; row++) {
      const paired = computeHornSlope(
        sampleTile(ownElev, row - 1, S - 1),
        sampleTile(east, row - 1, 0),
        sampleTile(east, row - 1, 1),
        sampleTile(ownElev, row, S - 1),
        sampleTile(east, row, 1),
        sampleTile(ownElev, row + 1, S - 1),
        sampleTile(east, row + 1, 0),
        sampleTile(east, row + 1, 1),
        inv8x, inv8y,
      );
      blend((row * S + S - 1) * 4, paired);
    }
  }
}

// ── Resolution downsampling (legacy resFactor > 1 path) ───────────────
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

function harmonizeSlopeBorders(slopes, ownElev, neighbourElevations, cellSizeX, cellSizeY) {
  if (!neighbourElevations) return slopes;
  const S = DEM_TILE_SIZE;
  const inv8x = 1 / (8 * cellSizeX);
  const inv8y = 1 / (8 * cellSizeY);

  if (neighbourElevations.north) {
    const north = neighbourElevations.north;
    for (let col = 0; col < S; col++) {
      const paired = computeHornSlope(
        sampleTile(north, S - 2, col - 1), sampleTile(north, S - 2, col), sampleTile(north, S - 2, col + 1),
        sampleTile(north, S - 1, col - 1), sampleTile(north, S - 1, col + 1),
        sampleTile(ownElev, 0, col - 1), sampleTile(ownElev, 0, col), sampleTile(ownElev, 0, col + 1),
        inv8x, inv8y,
      );
      slopes[col] = (slopes[col] + paired) * 0.5;
    }
  }
  if (neighbourElevations.south) {
    const south = neighbourElevations.south;
    const ownRow = (S - 1) * S;
    for (let col = 0; col < S; col++) {
      const idx = ownRow + col;
      const paired = computeHornSlope(
        sampleTile(ownElev, S - 1, col - 1), sampleTile(ownElev, S - 1, col), sampleTile(ownElev, S - 1, col + 1),
        sampleTile(south, 0, col - 1), sampleTile(south, 0, col + 1),
        sampleTile(south, 1, col - 1), sampleTile(south, 1, col), sampleTile(south, 1, col + 1),
        inv8x, inv8y,
      );
      slopes[idx] = (slopes[idx] + paired) * 0.5;
    }
  }
  if (neighbourElevations.west) {
    const west = neighbourElevations.west;
    for (let row = 0; row < S; row++) {
      const idx = row * S;
      const paired = computeHornSlope(
        sampleTile(west, row - 1, S - 2), sampleTile(west, row - 1, S - 1), sampleTile(ownElev, row - 1, 0),
        sampleTile(west, row, S - 2), sampleTile(ownElev, row, 0),
        sampleTile(west, row + 1, S - 2), sampleTile(west, row + 1, S - 1), sampleTile(ownElev, row + 1, 0),
        inv8x, inv8y,
      );
      slopes[idx] = (slopes[idx] + paired) * 0.5;
    }
  }
  if (neighbourElevations.east) {
    const east = neighbourElevations.east;
    for (let row = 0; row < S; row++) {
      const idx = row * S + (S - 1);
      const paired = computeHornSlope(
        sampleTile(ownElev, row - 1, S - 1), sampleTile(east, row - 1, 0), sampleTile(east, row - 1, 1),
        sampleTile(ownElev, row, S - 1), sampleTile(east, row, 1),
        sampleTile(ownElev, row + 1, S - 1), sampleTile(east, row + 1, 0), sampleTile(east, row + 1, 1),
        inv8x, inv8y,
      );
      slopes[idx] = (slopes[idx] + paired) * 0.5;
    }
  }
  return slopes;
}

async function encodeSlopePng(slopes, ownElev, edgeNeighbours) {
  const size = DEM_TILE_SIZE;
  const n = size * size;
  const rgba = new Uint8Array(n * 4);

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

  const INV_MAX = 1 / 90;
  for (let j = 0; j < n; j++) {
    const elev = ownElev[j];
    const idx = j * 4;
    if (elev <= DEM_NODATA_THRESHOLD) {
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

// ── Worker-only orchestrator ──────────────────────────────────────────
// Pure CPU path: own elevation + already-decoded neighbour elevations in,
// PNG-encoded ArrayBuffer out. NO demCache, NO SLOPE_INFLIGHT — the SW
// resolved everything before posting. This is the single function the
// slope worker pool invokes.
//
// Inputs:
//   ownElev            Float32Array(S*S) — decoded own DEM tile
//   neighbourElevations { north?, east?, south?, west? } Float32Array each
//   z, x, y            tile coords (for cell-size + diagnostics)
//   resFactor          1 = fused fast path; >1 = legacy downsample path
//
// Output:
//   { pngArrayBuffer: ArrayBuffer, missingDirections: string[] }
async function buildSlopeRgbaFromElevations(ownElev, neighbourElevations, z, x, y, resFactor) {
  const { cellSizeX, cellSizeY } = computeCellSize(z, x, y, DEM_TILE_SIZE);
  const {
    pad, edgeNeighbours, neighbourElevations: ne, missingDirections,
  } = buildPaddedElevationsFromArrays(ownElev, neighbourElevations);

  let blob;
  const useFusedFastPath = !resFactor || resFactor <= 1;
  if (useFusedFastPath) {
    const rgba = computeAndEncodeSlopeFused(pad, ownElev, cellSizeX, cellSizeY, edgeNeighbours);
    harmonizeSlopeBordersIntoRgba(rgba, ownElev, ne, cellSizeX, cellSizeY);
    // Use the slope-optimised encoder (Sub filter) when available — ~2-3x
    // faster deflate + smaller PNGs. Fall back to buildRawPng for any caller
    // that loads slope-math.js without terrain-rgb.js's new helper (none
    // today, but defensive).
    blob = (typeof buildRawPngSlope === 'function')
      ? await buildRawPngSlope(DEM_TILE_SIZE, DEM_TILE_SIZE, rgba)
      : await buildRawPng(DEM_TILE_SIZE, DEM_TILE_SIZE, rgba);
  } else {
    let slopes = computeSlopesFromPadded(pad, cellSizeX, cellSizeY);
    slopes = harmonizeSlopeBorders(slopes, ownElev, ne, cellSizeX, cellSizeY);
    slopes = downsampleSlopes(slopes, resFactor | 0);
    blob = await encodeSlopePng(slopes, ownElev, edgeNeighbours);
  }

  const pngArrayBuffer = await blob.arrayBuffer();
  return { pngArrayBuffer, missingDirections };
}
