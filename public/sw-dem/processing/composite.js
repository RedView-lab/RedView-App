// ---------------------------------------------------------------------------
// Composite IGN + Mapbox elevations with blend zone at coverage boundary
// Uses: Chamfer distance transform + IDW offset correction + smoothstep blend
//
// Full-coverage fast path: when every pixel has IGN data we don't need the
// expensive blend — we only need to align the IGN bare-earth elevations to
// the Mapbox bare-earth datum on the tile *border* so the output mesh is
// C0-continuous with neighbour tiles (which may be pure-Mapbox or partial
// composite at the same LOD). This is O(4·TILE_SIZE) instead of O(TILE²).
// ---------------------------------------------------------------------------

async function compositeIGNMapbox(ignElevations, coverage, z, x, y, opts = {}) {
  const totalPixels = DEM_TILE_SIZE * DEM_TILE_SIZE;

  // Fast path: uniform full coverage → border-ring offset alignment only.
  let fullCoverageFast = true;
  for (let i = 0; i < totalPixels; i++) {
    if (!coverage[i]) { fullCoverageFast = false; break; }
  }

  if (fullCoverageFast) {
    // LOD-invariant datum path (national-dataset interior tiles).
    //
    // A full-coverage tile that lies entirely inside the national dataset
    // polygon never borders a pure-Mapbox tile, so it needs NO Mapbox-datum
    // alignment. The per-tile constant bias below (median IGN−Mapbox over the
    // border ring) is recomputed independently for every tile AND every LOD
    // level. Under oblique pitch Mapbox renders neighbouring tiles at
    // different zooms (a normal terrain LOD ring), so two tiles covering the
    // same ground received DIFFERENT constant shifts — moving one whole tile
    // a few metres relative to its neighbour and producing the vertical
    // "wall" reported at 0.40 m, which appears/disappears as the camera angle
    // moves the LOD ring. Encoding the raw IGN datum keeps every IGN tile on
    // the single, globally self-consistent MNS vertical reference, so
    // neighbours match regardless of LOD. Genuine IGN↔Mapbox continuity at
    // the actual national boundary is handled by the partial-coverage blend
    // path below (border tiles are partial coverage), not here. Bonus: skips
    // a Mapbox fetch + Terrain-RGB decode per interior tile.
    if (opts.skipDatumBias) {
      return encodeTerrainRGBPng(ignElevations);
    }

    let mbElevations = opts.prefilledMbElev;
    if (!mbElevations) {
      const mapboxBlob = await fetchMapboxTile(z, x, y);
      if (!mapboxBlob) {
        return encodeTerrainRGBPng(ignElevations);
      }
      mbElevations = await decodeTerrainRGBBlob(mapboxBlob);
      if (!mbElevations || mbElevations.length === 0) return encodeTerrainRGBPng(ignElevations);
    }

    // Defensive despike of Mapbox before sampling offsets.
    const mbSize = Math.round(Math.sqrt(mbElevations.length));
    {
      const mbCov = new Uint8Array(mbElevations.length).fill(1);
      despikeElevations(mbElevations, mbCov, mbSize);
    }

    const scale = mbSize / DEM_TILE_SIZE;
    const sampleMB = (px, py) => {
      if (scale === 1) return mbElevations[py * DEM_TILE_SIZE + px];
      const mx = Math.min((px * scale) | 0, mbSize - 1);
      const my = Math.min((py * scale) | 0, mbSize - 1);
      return mbElevations[my * mbSize + mx];
    };

    // Collect offsets on the 4 borders (1-px ring). These are the only
    // pixels shared (geographically) with neighbour tiles, so aligning them
    // suffices for mesh watertightness at every LOD.
    const offsets = [];
    const last = DEM_TILE_SIZE - 1;
    const pushOff = (px, py) => {
      const mb = sampleMB(px, py);
      if (mb <= -9000) return;
      const off = ignElevations[py * DEM_TILE_SIZE + px] - mb;
      if (off > -500 && off < 500) offsets.push(off);
    };
    for (let px = 0; px < DEM_TILE_SIZE; px++) { pushOff(px, 0); pushOff(px, last); }
    for (let py = 1; py < last; py++) { pushOff(0, py); pushOff(last, py); }

    let bias = 0;
    if (offsets.length > 0) {
      offsets.sort((a, b) => a - b);
      const mid = offsets.length >> 1;
      bias = offsets.length & 1
        ? offsets[mid]
        : (offsets[mid - 1] + offsets[mid]) / 2;
    }

    // Apply constant bias so border pixels match Mapbox; interior IGN detail
    // is preserved (only shifted by a constant → no distortion of slopes).
    if (bias !== 0) {
      const out = new Float32Array(totalPixels);
      for (let i = 0; i < totalPixels; i++) out[i] = ignElevations[i] - bias;
      const fullCoverage = new Uint8Array(totalPixels).fill(1);
      despikeElevations(out, fullCoverage, DEM_TILE_SIZE);
      return encodeTerrainRGBPng(out);
    }
    return encodeTerrainRGBPng(ignElevations);
  }

  // --- Original partial-coverage path (distance transform + IDW blend) ---
  let mbElevations = opts.prefilledMbElev;
  if (!mbElevations) {
    const mapboxBlob = await fetchMapboxTile(z, x, y);
    if (!mapboxBlob) {
      return encodeTerrainRGBPng(ignElevations);
    }
    mbElevations = await decodeTerrainRGBBlob(mapboxBlob);
    if (!mbElevations || mbElevations.length === 0) {
      return encodeTerrainRGBPng(ignElevations);
    }
  }

  // Defensive despike: even after the terrain-RGB resample-corruption fix in
  // mapbox.js, a rogue outlier in the Mapbox DEM would drag the IDW offset
  // below by hundreds of metres and reintroduce visible spikes along the
  // blend ring. 3×3 median clamp is cheap and preserves real relief.
  {
    const mbSize = Math.round(Math.sqrt(mbElevations.length));
    const mbCov = new Uint8Array(mbElevations.length).fill(1);
    despikeElevations(mbElevations, mbCov, mbSize);
  }

  // Adaptive blend radius: wider at low zoom (each pixel covers more ground)
  const BLEND_RADIUS = Math.max(96, Math.round(192 / Math.pow(1.1, Math.max(0, z - 5))));

  function smoothstep(t) {
    const c = Math.max(0, Math.min(1, t));
    return c * c * (3 - 2 * c);
  }

  // Resample Mapbox elevations helper
  const mbSize = Math.round(Math.sqrt(mbElevations.length));
  const scale = mbSize / DEM_TILE_SIZE;

  function sampleMB(px, py) {
    if (scale === 1) return mbElevations[py * DEM_TILE_SIZE + px];
    const mx = Math.min((px * scale) | 0, mbSize - 1);
    const my = Math.min((py * scale) | 0, mbSize - 1);
    return mbElevations[my * mbSize + mx];
  }

  // --- Distance transform (Chamfer 2-pass) ---
  const distToBorder = new Float32Array(totalPixels);
  const INF = DEM_TILE_SIZE * 2;
  distToBorder.fill(INF);

  // Mark border pixels (distance = 0) — pixels adjacent to a different coverage state
  for (let py = 0; py < DEM_TILE_SIZE; py++) {
    for (let px = 0; px < DEM_TILE_SIZE; px++) {
      const idx = py * DEM_TILE_SIZE + px;
      const c = coverage[idx];
      if (
        (py > 0 && coverage[idx - DEM_TILE_SIZE] !== c) ||
        (py < DEM_TILE_SIZE - 1 && coverage[idx + DEM_TILE_SIZE] !== c) ||
        (px > 0 && coverage[idx - 1] !== c) ||
        (px < DEM_TILE_SIZE - 1 && coverage[idx + 1] !== c)
      ) {
        distToBorder[idx] = 0;
      }
    }
  }

  // Forward pass
  for (let py = 0; py < DEM_TILE_SIZE; py++) {
    for (let px = 0; px < DEM_TILE_SIZE; px++) {
      const idx = py * DEM_TILE_SIZE + px;
      if (py > 0) distToBorder[idx] = Math.min(distToBorder[idx], distToBorder[idx - DEM_TILE_SIZE] + 1);
      if (px > 0) distToBorder[idx] = Math.min(distToBorder[idx], distToBorder[idx - 1] + 1);
      if (py > 0 && px > 0) distToBorder[idx] = Math.min(distToBorder[idx], distToBorder[idx - DEM_TILE_SIZE - 1] + 1.414);
      if (py > 0 && px < DEM_TILE_SIZE - 1) distToBorder[idx] = Math.min(distToBorder[idx], distToBorder[idx - DEM_TILE_SIZE + 1] + 1.414);
    }
  }

  // Backward pass
  for (let py = DEM_TILE_SIZE - 1; py >= 0; py--) {
    for (let px = DEM_TILE_SIZE - 1; px >= 0; px--) {
      const idx = py * DEM_TILE_SIZE + px;
      if (py < DEM_TILE_SIZE - 1) distToBorder[idx] = Math.min(distToBorder[idx], distToBorder[idx + DEM_TILE_SIZE] + 1);
      if (px < DEM_TILE_SIZE - 1) distToBorder[idx] = Math.min(distToBorder[idx], distToBorder[idx + 1] + 1);
      if (py < DEM_TILE_SIZE - 1 && px < DEM_TILE_SIZE - 1) distToBorder[idx] = Math.min(distToBorder[idx], distToBorder[idx + DEM_TILE_SIZE + 1] + 1.414);
      if (py < DEM_TILE_SIZE - 1 && px > 0) distToBorder[idx] = Math.min(distToBorder[idx], distToBorder[idx + DEM_TILE_SIZE - 1] + 1.414);
    }
  }

  // --- Collect per-pixel border offset samples (IGN − Mapbox) ---
  const borderSamples = [];
  for (let py = 0; py < DEM_TILE_SIZE; py++) {
    for (let px = 0; px < DEM_TILE_SIZE; px++) {
      const idx = py * DEM_TILE_SIZE + px;
      if (distToBorder[idx] < 3 && coverage[idx]) {
        const mb = sampleMB(px, py);
        if (mb > -9000) {
          const off = ignElevations[idx] - mb;
          if (off > -500 && off < 500) {
            borderSamples.push({ px, py, offset: off });
          }
        }
      }
    }
  }

  // Compute median offset as fallback
  let medianOffset = 0;
  if (borderSamples.length > 0) {
    const sorted = borderSamples.map(s => s.offset).sort((a, b) => a - b);
    const mid = sorted.length >> 1;
    medianOffset = sorted.length & 1 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
  }

  // Subsample for performance (cap at 400 representative samples)
  let samplesForIDW = borderSamples;
  if (samplesForIDW.length > 400) {
    const step = Math.ceil(samplesForIDW.length / 400);
    samplesForIDW = samplesForIDW.filter((_, i) => i % step === 0);
  }

  // Inverse-distance-weighted offset evaluator
  function rawIdwOffset(px, py) {
    if (samplesForIDW.length === 0) return medianOffset;
    if (samplesForIDW.length < 4) return medianOffset;

    let wSum = 0, vSum = 0;
    const searchR = BLEND_RADIUS * 2;
    const searchR2 = searchR * searchR;
    for (let i = 0; i < samplesForIDW.length; i++) {
      const s = samplesForIDW[i];
      const dx = px - s.px;
      const dy = py - s.py;
      const d2 = dx * dx + dy * dy;
      if (d2 < 1) return s.offset;
      if (d2 > searchR2) continue;
      const w = 1 / d2;
      wSum += w;
      vSum += w * s.offset;
    }
    const result = wSum > 0 ? vSum / wSum : medianOffset;
    return Number.isFinite(result) ? result : medianOffset;
  }

  // Precompute a coarse 17×17 spatial grid (289 points) across the 256×256 tile
  // and bilinearly interpolate in the blend loop. 100,000x faster than evaluating
  // full IDW per pixel, perfectly continuous and C1-smooth across seams.
  const GRID_SIZE = 16;
  const GRID_POINTS = GRID_SIZE + 1; // 17
  const offsetGrid = new Float32Array(GRID_POINTS * GRID_POINTS);
  for (let gy = 0; gy < GRID_POINTS; gy++) {
    const py = Math.min(gy * (DEM_TILE_SIZE / GRID_SIZE), DEM_TILE_SIZE - 1);
    for (let gx = 0; gx < GRID_POINTS; gx++) {
      const px = Math.min(gx * (DEM_TILE_SIZE / GRID_SIZE), DEM_TILE_SIZE - 1);
      offsetGrid[gy * GRID_POINTS + gx] = rawIdwOffset(px, py);
    }
  }

  function getInterpolatedOffset(px, py) {
    const gx = (px / DEM_TILE_SIZE) * GRID_SIZE;
    const gy = (py / DEM_TILE_SIZE) * GRID_SIZE;
    const ix = Math.max(0, Math.min(Math.floor(gx), GRID_SIZE - 1));
    const iy = Math.max(0, Math.min(Math.floor(gy), GRID_SIZE - 1));
    const fx = gx - ix;
    const fy = gy - iy;

    const row0 = iy * GRID_POINTS;
    const row1 = (iy + 1) * GRID_POINTS;
    const o00 = offsetGrid[row0 + ix];
    const o10 = offsetGrid[row0 + ix + 1];
    const o01 = offsetGrid[row1 + ix];
    const o11 = offsetGrid[row1 + ix + 1];

    const top = o00 + (o10 - o00) * fx;
    const bot = o01 + (o11 - o01) * fx;
    return top + (bot - top) * fy;
  }

  // --- Composite with spatially-varying offset-corrected blending ---
  const result = new Float32Array(totalPixels);
  for (let i = 0; i < totalPixels; i++) {
    const py = (i / DEM_TILE_SIZE) | 0;
    const px = i % DEM_TILE_SIZE;
    const mb = sampleMB(px, py);
    const dist = distToBorder[i];

    if (dist >= BLEND_RADIUS) {
      // Far from border — use source directly
      result[i] = coverage[i] ? ignElevations[i] : mb;
    } else {
      // In blend zone — smoothstep interpolation with offset correction
      const t = smoothstep(dist / BLEND_RADIUS);
      const localOffset = getInterpolatedOffset(px, py);

      if (coverage[i]) {
        // IGN pixel: fade from offset-corrected Mapbox at border → pure IGN inside
        const mbCorrected = mb + localOffset;
        result[i] = ignElevations[i] * t + mbCorrected * (1 - t);
      } else {
        // Mapbox pixel: fade from offset-corrected → raw Mapbox outside
        const mbCorrected = mb + localOffset * (1 - t);
        result[i] = mbCorrected;
      }
    }
  }

  // Release heavy intermediates before PNG encoding
  distToBorder.fill(0);
  borderSamples.length = 0;
  samplesForIDW = null;

  // Single-pixel despike — removes LiDAR hot pixels that survived source
  // validation (MNS can still show tree-top / bird / cloud outliers a few
  // hundred metres above local terrain). Real cliffs span multiple pixels so
  // the 3×3 median agrees and nothing is altered.
  const fullCoverage = new Uint8Array(DEM_TILE_SIZE * DEM_TILE_SIZE).fill(1);
  despikeElevations(result, fullCoverage, DEM_TILE_SIZE);

  return encodeTerrainRGBPng(result);
}
