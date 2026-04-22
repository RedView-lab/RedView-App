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
async function buildAltitudeTile(demBlob) {
  const t0 = performance.now();
  const elevations = await decodeTerrainRGBBlob(demBlob);
  const t1 = performance.now();
  const blob = await encodeAltitudePng(elevations);
  const t3 = performance.now();

  if (DEBUG) {
    console.log(
      `[altitude] dec=${(t1 - t0).toFixed(0)} enc=${(t3 - t1).toFixed(0)} total=${(t3 - t0).toFixed(0)}ms`,
    );
  }

  return blob;
}