// ---------------------------------------------------------------------------
// Composite IGN + Mapbox elevations with blend zone at coverage boundary
// Uses: Chamfer distance transform + IDW offset correction + smoothstep blend
// ---------------------------------------------------------------------------

async function compositeIGNMapbox(ignElevations, coverage, z, x, y) {
  const mapboxBlob = await fetchMapboxTile(z, x, y);
  if (!mapboxBlob) {
    return encodeTerrainRGBPng(ignElevations);
  }

  const mbElevations = await decodeTerrainRGBBlob(mapboxBlob);
  if (mbElevations.length === 0) {
    return encodeTerrainRGBPng(ignElevations);
  }

  const totalPixels = DEM_TILE_SIZE * DEM_TILE_SIZE;

  // Adaptive blend radius: wider at low zoom (each pixel covers more ground)
  const BLEND_RADIUS = Math.max(64, Math.round(160 / Math.pow(1.1, Math.max(0, z - 5))));

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

  return encodeTerrainRGBPng(result);
}
