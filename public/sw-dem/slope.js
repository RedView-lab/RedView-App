// ---------------------------------------------------------------------------
// Slope computation from DEM elevations
// Uses Horn's method (3×3 neighborhood) for robust gradient estimation.
// Encodes slope angle (degrees) in Terrain-RGB format for raster-color usage.
// ---------------------------------------------------------------------------

/**
 * Compute ground-level cell sizes (meters) for a Mercator tile.
 * Returns {cellSizeX, cellSizeY} — average ground distance per pixel.
 */
function computeCellSize(z, x, y, tileSize) {
  const bounds = mercatorTileBounds(z, x, y);
  const midLat = (bounds.north + bounds.south) / 2;
  const latRad = (midLat * Math.PI) / 180;

  // Longitude span → meters at this latitude
  const metersX = ((bounds.east - bounds.west) * Math.PI * 6378137 * Math.cos(latRad)) / 180;
  // Latitude span → meters (roughly constant)
  const metersY = ((bounds.north - bounds.south) * Math.PI * 6378137) / 180;

  return {
    cellSizeX: metersX / tileSize,
    cellSizeY: metersY / tileSize,
  };
}

/**
 * Compute slope angles (degrees) from an elevation Float32Array.
 * Horn's method — weights the 3×3 neighborhood:
 *
 *   a  b  c
 *   d  e  f
 *   g  h  i
 *
 *   dz/dx = ((c + 2f + i) - (a + 2d + g)) / (8 * cellSizeX)
 *   dz/dy = ((g + 2h + i) - (a + 2b + c)) / (8 * cellSizeY)
 *   slope = atan(sqrt(dz_dx² + dz_dy²)) in degrees
 *
 * Edges replicate the nearest border pixel.
 */
function computeSlopes(elevations, tileSize, cellSizeX, cellSizeY) {
  const slopes = new Float32Array(tileSize * tileSize);
  const inv8x = 1 / (8 * cellSizeX);
  const inv8y = 1 / (8 * cellSizeY);
  const RAD2DEG = 180 / Math.PI;

  for (let row = 0; row < tileSize; row++) {
    for (let col = 0; col < tileSize; col++) {
      // Clamp indices for edge replication
      const r0 = Math.max(row - 1, 0);
      const r2 = Math.min(row + 1, tileSize - 1);
      const c0 = Math.max(col - 1, 0);
      const c2 = Math.min(col + 1, tileSize - 1);

      const a = elevations[r0 * tileSize + c0];
      const b = elevations[r0 * tileSize + col];
      const c = elevations[r0 * tileSize + c2];
      const d = elevations[row * tileSize + c0];
      // e = center, not needed
      const f = elevations[row * tileSize + c2];
      const g = elevations[r2 * tileSize + c0];
      const h = elevations[r2 * tileSize + col];
      const i = elevations[r2 * tileSize + c2];

      const dzDx = ((c + 2 * f + i) - (a + 2 * d + g)) * inv8x;
      const dzDy = ((g + 2 * h + i) - (a + 2 * b + c)) * inv8y;

      const slopeDeg = Math.atan(Math.sqrt(dzDx * dzDx + dzDy * dzDy)) * RAD2DEG;
      slopes[row * tileSize + col] = slopeDeg;
    }
  }
  return slopes;
}

/**
 * Encode slope degrees as Terrain-RGB PNG.
 * Uses the same formula as DEM: value = (slope + 10000) / 0.1
 * This gives 0.1° precision and is compatible with `raster-color-mix`.
 *
 * Alpha channel: 255 for valid data, 0 for NODATA pixels.
 */
async function encodeSlopePng(slopes, elevations) {
  const size = DEM_TILE_SIZE;
  const rgba = new Uint8Array(size * size * 4);

  for (let j = 0; j < slopes.length; j++) {
    const elev = elevations[j];
    const isNoData = elev <= DEM_NODATA_THRESHOLD;

    const slopeDeg = isNoData ? 0 : slopes[j];
    const val = Math.max(0, Math.min(16777215, Math.round((slopeDeg + 10000) / 0.1)));
    const idx = j * 4;
    rgba[idx]     = (val >> 16) & 0xff;
    rgba[idx + 1] = (val >>  8) & 0xff;
    rgba[idx + 2] =  val        & 0xff;
    rgba[idx + 3] = isNoData ? 0 : 255;
  }

  return buildRawPng(size, size, rgba);
}

/**
 * Full pipeline: DEM blob → slope PNG blob.
 * Returns null if decoding fails.
 */
async function buildSlopeTile(demBlob, z, x, y) {
  const elevations = await decodeTerrainRGBBlob(demBlob);
  const { cellSizeX, cellSizeY } = computeCellSize(z, x, y, DEM_TILE_SIZE);
  const slopes = computeSlopes(elevations, DEM_TILE_SIZE, cellSizeX, cellSizeY);
  return encodeSlopePng(slopes, elevations);
}
