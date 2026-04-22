// ---------------------------------------------------------------------------
// Altitude overlay tiles derived from DEM elevations.
//
// Output: Terrain-RGB-compatible PNG with transparent NoData pixels.
//   - RGB encodes altitude in meters using standard Terrain-RGB formula
//   - A   = 0 on NoData, 255 otherwise
//
// Colorisation, hide-bands and gradient/step mode are applied GPU-side via
// Mapbox `raster-color` + `raster-color-mix`, exactly like the slope overlay.
// This keeps the SW cache keyed only by (z, x, y, resFactor).
// ---------------------------------------------------------------------------

// ── Optional box-average downsampling ──────────────────────────────────────
// The UI resolution selector mirrors the slope overlay: lower resolutions
// average N×N DEM pixels into a coarser block while preserving the 256×256
// output grid. This changes the actual sampled altitude field, so it belongs
// in the SW tile cache key.
function downsampleElevations(elevations, factor) {
  if (!factor || factor <= 1) return elevations;

  const size = DEM_TILE_SIZE;
  const out = new Float32Array(size * size);

  for (let by = 0; by < size; by += factor) {
    const yEnd = Math.min(by + factor, size);
    for (let bx = 0; bx < size; bx += factor) {
      const xEnd = Math.min(bx + factor, size);
      let sum = 0;
      let count = 0;

      for (let y = by; y < yEnd; y++) {
        const row = y * size;
        for (let x = bx; x < xEnd; x++) {
          const elev = elevations[row + x];
          if (!Number.isFinite(elev) || elev <= DEM_NODATA_THRESHOLD) continue;
          sum += elev;
          count++;
        }
      }

      const avg = count > 0 ? sum / count : DEM_NODATA_THRESHOLD;
      for (let y = by; y < yEnd; y++) {
        const row = y * size;
        for (let x = bx; x < xEnd; x++) {
          out[row + x] = avg;
        }
      }
    }
  }

  return out;
}

// ── Altitude-only RGBA PNG ─────────────────────────────────────────────────
// We reuse Terrain-RGB encoding for the RGB channels so GPU-side decoding can
// reconstruct meters with a single raster-color-mix. Unlike the DEM terrain
// mesh tiles, NoData pixels stay transparent so the orthophoto remains visible
// where the DEM pipeline has no altitude sample.
async function encodeAltitudePng(elevations) {
  const size = DEM_TILE_SIZE;
  const rgba = new Uint8Array(size * size * 4);

  for (let i = 0; i < elevations.length; i++) {
    const elev = elevations[i];
    const idx = i * 4;

    if (!Number.isFinite(elev) || elev <= DEM_NODATA_THRESHOLD) {
      rgba[idx + 3] = 0;
      continue;
    }

    const height = sanitizeElevation(elev);
    const val = Math.max(0, Math.min(16777215, Math.round((height + 10000) / 0.1)));
    rgba[idx] = (val >> 16) & 0xff;
    rgba[idx + 1] = (val >> 8) & 0xff;
    rgba[idx + 2] = val & 0xff;
    rgba[idx + 3] = 255;
  }

  return buildRawPng(size, size, rgba);
}

// ── Full pipeline — DEM blob → altitude overlay PNG ────────────────────────
async function buildAltitudeTile(demBlob, resFactor) {
  const t0 = performance.now();
  const elevations = await decodeTerrainRGBBlob(demBlob);
  const t1 = performance.now();
  const sampled = resFactor && resFactor > 1
    ? downsampleElevations(elevations, resFactor | 0)
    : elevations;
  const t2 = performance.now();
  const blob = await encodeAltitudePng(sampled);
  const t3 = performance.now();

  if (DEBUG) {
    console.log(
      `[altitude] dec=${(t1 - t0).toFixed(0)} avg=${(t2 - t1).toFixed(0)} enc=${(t3 - t2).toFixed(0)} total=${(t3 - t0).toFixed(0)}ms res=${resFactor || 1}`,
    );
  }

  return blob;
}