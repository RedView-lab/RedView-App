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

async function compositeIGNMapbox(ignElevations, coverage, z, x, y) {
  const totalPixels = DEM_TILE_SIZE * DEM_TILE_SIZE;

  // Fast path: uniform full coverage → border-ring offset alignment only.
  let fullCoverageFast = true;
  for (let i = 0; i < totalPixels; i++) {
    if (!coverage[i]) { fullCoverageFast = false; break; }
  }

  if (fullCoverageFast) {
    const mapboxBlob = await fetchMapboxTile(z, x, y);
    if (!mapboxBlob) {
      // No Mapbox reference available — encode IGN as-is. Neighbour tiles in
      // the same situation will share the same (un-shifted) datum, so seams
      // remain continuous among IGN-only tiles; the only visible offset can
      // appear against pure-Mapbox tiles that did fetch successfully, and
      // that's the same failure mode as pre-composite.
      return encodeTerrainRGBPng(ignElevations);
    }
    const mbElevations = await decodeTerrainRGBBlob(mapboxBlob);
    if (mbElevations.length === 0) return encodeTerrainRGBPng(ignElevations);

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
  const mapboxBlob = await fetchMapboxTile(z, x, y);
  if (!mapboxBlob) {
    return encodeTerrainRGBPng(ignElevations);
  }

  const mbElevations = await decodeTerrainRGBBlob(mapboxBlob);
  if (mbElevations.length === 0) {
    return encodeTerrainRGBPng(ignElevations);
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

  // Subsample for performance (cap at 2000)
  let samplesForIDW = borderSamples;
  if (samplesForIDW.length > 2000) {
    const step = Math.ceil(samplesForIDW.length / 2000);
    samplesForIDW = samplesForIDW.filter((_, i) => i % step === 0);
  }

  // Inverse-distance-weighted offset at a given pixel
  function idwOffset(px, py) {
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
      const localOffset = idwOffset(px, py);

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
