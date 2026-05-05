// ---------------------------------------------------------------------------
// BIL decoder, elevation sanitizer, NODATA-aware interpolation
// ---------------------------------------------------------------------------

function decodeBIL32(buffer) {
  const expectedBytes = IGN_SRC_TILE_SIZE * IGN_SRC_TILE_SIZE * 4;
  if (buffer.byteLength !== expectedBytes) {
    throw new Error(`Invalid BIL size: expected ${expectedBytes}, got ${buffer.byteLength}`);
  }
  return new Float32Array(buffer);
}

function sanitizeElevation(value) {
  if (Number.isNaN(value)) return 0;
  if (value < MIN_VALID_ELEVATION_M) return 0;
  if (value > MAX_VALID_ELEVATION_M) return 0;
  return value;
}

// Check if a single BIL pixel is valid (not NaN, not NODATA, not out-of-range)
function isRawValid(data, x, y) {
  const cx = Math.max(0, Math.min(x, IGN_SRC_TILE_SIZE - 1));
  const cy = Math.max(0, Math.min(y, IGN_SRC_TILE_SIZE - 1));
  const val = data[cy * IGN_SRC_TILE_SIZE + cx];
  return !Number.isNaN(val)
    && val >= MIN_VALID_ELEVATION_M
    && val <= MAX_VALID_ELEVATION_M;
}

// Check if the raw elevation at nearest pixel is actually valid data
function hasValidRawElevation(data, fx, fy) {
  const ix = Math.max(0, Math.min(Math.round(fx), IGN_SRC_TILE_SIZE - 1));
  const iy = Math.max(0, Math.min(Math.round(fy), IGN_SRC_TILE_SIZE - 1));
  const val = data[iy * IGN_SRC_TILE_SIZE + ix];
  return !Number.isNaN(val)
    && val >= MIN_VALID_ELEVATION_M
    && val <= MAX_VALID_ELEVATION_M;
}

// ---------------------------------------------------------------------------
// Catmull-Rom bicubic with bilinear/nearest fallback near NODATA
// ---------------------------------------------------------------------------

function cubicHermite(A, B, C, D, t) {
  const a = -A / 2 + (3 * B) / 2 - (3 * C) / 2 + D / 2;
  const b = A - (5 * B) / 2 + 2 * C - D / 2;
  const c = -A / 2 + C / 2;
  return a * t * t * t + b * t * t + c * t + B;
}

function sampleAt(data, x, y) {
  const cx = Math.max(0, Math.min(x, IGN_SRC_TILE_SIZE - 1));
  const cy = Math.max(0, Math.min(y, IGN_SRC_TILE_SIZE - 1));
  return sanitizeElevation(data[cy * IGN_SRC_TILE_SIZE + cx]);
}

function bicubicSample(data, fx, fy) {
  const ix = Math.floor(fx);
  const iy = Math.floor(fy);
  const dx = fx - ix;
  const dy = fy - iy;

  // Check all 16 kernel pixels for NODATA. If any is invalid,
  // Catmull-Rom would mix real elevation with NODATA→0, causing
  // extreme overshoot spikes. Fall back to safer interpolation.
  let allValid = true;
  for (let j = -1; j <= 2 && allValid; j++) {
    for (let k = -1; k <= 2 && allValid; k++) {
      if (!isRawValid(data, ix + k, iy + j)) allValid = false;
    }
  }

  if (allValid) {
    // Full Catmull-Rom bicubic — safe, all 16 pixels are valid
    const rows = [];
    for (let j = -1; j <= 2; j++) {
      const c0 = sampleAt(data, ix - 1, iy + j);
      const c1 = sampleAt(data, ix, iy + j);
      const c2 = sampleAt(data, ix + 1, iy + j);
      const c3 = sampleAt(data, ix + 2, iy + j);
      rows.push(cubicHermite(c0, c1, c2, c3, dx));
    }
    return cubicHermite(rows[0], rows[1], rows[2], rows[3], dy);
  }

  // Fallback: bilinear using only the 4 inner (nearest) pixels
  const p00v = isRawValid(data, ix, iy);
  const p10v = isRawValid(data, ix + 1, iy);
  const p01v = isRawValid(data, ix, iy + 1);
  const p11v = isRawValid(data, ix + 1, iy + 1);
  const validCount = (p00v ? 1 : 0) + (p10v ? 1 : 0) + (p01v ? 1 : 0) + (p11v ? 1 : 0);

  if (validCount < 2) {
    // Nearest-neighbor: return closest valid pixel
    if (p00v) return sampleAt(data, ix, iy);
    if (p10v) return sampleAt(data, ix + 1, iy);
    if (p01v) return sampleAt(data, ix, iy + 1);
    if (p11v) return sampleAt(data, ix + 1, iy + 1);
    return NaN; // Propagate as NODATA — prevents 0m sea-level cliffs at borders
  }

  // Weighted bilinear: substitute invalid pixels with average of valid ones
  const p00 = p00v ? sampleAt(data, ix, iy) : 0;
  const p10 = p10v ? sampleAt(data, ix + 1, iy) : 0;
  const p01 = p01v ? sampleAt(data, ix, iy + 1) : 0;
  const p11 = p11v ? sampleAt(data, ix + 1, iy + 1) : 0;
  const validAvg = (p00 * (p00v ? 1 : 0) + p10 * (p10v ? 1 : 0) + p01 * (p01v ? 1 : 0) + p11 * (p11v ? 1 : 0)) / validCount;

  const s00 = p00v ? p00 : validAvg;
  const s10 = p10v ? p10 : validAvg;
  const s01 = p01v ? p01 : validAvg;
  const s11 = p11v ? p11 : validAvg;

  const top = s00 + (s10 - s00) * dx;
  const bot = s01 + (s11 - s01) * dx;
  return top + (bot - top) * dy;
}

// ---------------------------------------------------------------------------
// Despike filter — 3×3 median, applied on the already-resampled tile.
// Removes isolated single-pixel outliers (LiDAR hot pixels, scanner artifacts)
// without erasing real terrain: real cliffs / ridgelines span multiple pixels,
// so the neighborhood median agrees with the centre value and nothing changes.
// Only pixels differing from the median by more than DESPIKE_THRESHOLD_M are
// rewritten.
// ---------------------------------------------------------------------------
function despikeElevations(elevations, coverage, size) {
  const out = new Float32Array(elevations);
  const neigh = new Float32Array(9);
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const idx = y * size + x;
      if (!coverage[idx]) continue;
      let n = 0;
      for (let dy = -1; dy <= 1; dy++) {
        const yy = y + dy;
        if (yy < 0 || yy >= size) continue;
        for (let dx = -1; dx <= 1; dx++) {
          const xx = x + dx;
          if (xx < 0 || xx >= size) continue;
          const nIdx = yy * size + xx;
          if (!coverage[nIdx]) continue;
          neigh[n++] = elevations[nIdx];
        }
      }
      if (n < 3) continue; // need at least 3 to compute a trustworthy median
      // Partial selection sort — enough to find the median
      for (let i = 0; i < n; i++) {
        let minJ = i;
        for (let j = i + 1; j < n; j++) if (neigh[j] < neigh[minJ]) minJ = j;
        if (minJ !== i) { const t = neigh[i]; neigh[i] = neigh[minJ]; neigh[minJ] = t; }
        if (i >= (n >> 1)) break;
      }
      // True median for even n: average of two middle elements. Prevents a
      // single outlier that happened to be ordered middle-ish from surviving.
      const mid = n >> 1;
      const median = (n & 1) ? neigh[mid] : (neigh[mid - 1] + neigh[mid]) / 2;
      if (Math.abs(elevations[idx] - median) > DESPIKE_THRESHOLD_M) {
        out[idx] = median;
      }
    }
  }
  elevations.set(out);
}
function bilinearSample(data, fx, fy) {
  const ix = Math.floor(fx);
  const iy = Math.floor(fy);
  const dx = fx - ix;
  const dy = fy - iy;

  const p00v = isRawValid(data, ix, iy);
  const p10v = isRawValid(data, ix + 1, iy);
  const p01v = isRawValid(data, ix, iy + 1);
  const p11v = isRawValid(data, ix + 1, iy + 1);
  const validCount = (p00v ? 1 : 0) + (p10v ? 1 : 0) + (p01v ? 1 : 0) + (p11v ? 1 : 0);

  if (validCount === 0) return NaN;
  if (validCount < 2) {
    if (p00v) return sampleAt(data, ix, iy);
    if (p10v) return sampleAt(data, ix + 1, iy);
    if (p01v) return sampleAt(data, ix, iy + 1);
    return sampleAt(data, ix + 1, iy + 1);
  }

  const p00 = p00v ? sampleAt(data, ix, iy) : 0;
  const p10 = p10v ? sampleAt(data, ix + 1, iy) : 0;
  const p01 = p01v ? sampleAt(data, ix, iy + 1) : 0;
  const p11 = p11v ? sampleAt(data, ix + 1, iy + 1) : 0;
  const validAvg = (p00 * (p00v ? 1 : 0) + p10 * (p10v ? 1 : 0) + p01 * (p01v ? 1 : 0) + p11 * (p11v ? 1 : 0)) / validCount;

  const s00 = p00v ? p00 : validAvg;
  const s10 = p10v ? p10 : validAvg;
  const s01 = p01v ? p01 : validAvg;
  const s11 = p11v ? p11 : validAvg;

  const top = s00 + (s10 - s00) * dx;
  const bot = s01 + (s11 - s01) * dx;
  return top + (bot - top) * dy;
}
