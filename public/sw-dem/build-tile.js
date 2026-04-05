// ---------------------------------------------------------------------------
// Build IGN Terrain-RGB tile (Mercator ← WGS84G resampling + border dilation)
// Returns { blob, elevations, coverage } or null
// ---------------------------------------------------------------------------

async function buildIGNTile(mercZ, mercX, mercY) {
  const demZ = Math.max(IGN_DEM_MINZOOM, Math.min(mercZ, IGN_DEM_MAXZOOM));
  const bounds = mercatorTileBounds(mercZ, mercX, mercY);
  const tl = lngLatToWGS84GTile(bounds.west, bounds.north, demZ);
  const br = lngLatToWGS84GTile(bounds.east, bounds.south, demZ);

  // Fetch all needed IGN tiles
  const tileMap = new Map();
  const fetches = [];
  for (let row = tl.row; row <= br.row; row++) {
    for (let col = tl.col; col <= br.col; col++) {
      fetches.push(
        getIGNTile(demZ, col, row).then((d) => {
          tileMap.set(`${col}/${row}`, d);
        }),
      );
    }
  }
  await Promise.all(fetches);

  const totalPixels = DEM_TILE_SIZE * DEM_TILE_SIZE;
  const elevations = new Float32Array(totalPixels);
  const coverage = new Uint8Array(totalPixels);
  const n = 1 << mercZ;
  const matrixWidth = 1 << (demZ + 1);
  const matrixHeight = 1 << demZ;
  let coveredCount = 0;

  for (let py = 0; py < DEM_TILE_SIZE; py++) {
    const yFrac = (mercY + (py + 0.5) / DEM_TILE_SIZE) / n;
    const lat = mercatorYToLat(yFrac);

    for (let px = 0; px < DEM_TILE_SIZE; px++) {
      const xFrac = (mercX + (px + 0.5) / DEM_TILE_SIZE) / n;
      const lng = xFrac * 360 - 180;

      const col = Math.max(0, Math.min(Math.floor(((lng + 180) / 360) * matrixWidth), matrixWidth - 1));
      const row = Math.max(0, Math.min(Math.floor(((90 - lat) / 180) * matrixHeight), matrixHeight - 1));

      const tileData = tileMap.get(`${col}/${row}`);
      if (tileData) {
        const fx = (((lng + 180) / 360) * matrixWidth - col) * IGN_SRC_TILE_SIZE;
        const fy = (((90 - lat) / 180) * matrixHeight - row) * IGN_SRC_TILE_SIZE;
        if (hasValidRawElevation(tileData, fx, fy)) {
          elevations[py * DEM_TILE_SIZE + px] = bicubicSample(tileData, fx, fy);
          coverage[py * DEM_TILE_SIZE + px] = 1;
          coveredCount++;
        }
      }
    }
  }

  if (coveredCount === 0) return null;

  if (coveredCount === totalPixels) {
    return { blob: await encodeTerrainRGBPng(elevations), elevations, coverage };
  }

  // --- Border pixel dilation (2 passes) ---
  for (let pass = 0; pass < 2; pass++) {
    const newElevations = new Float32Array(elevations);
    const newCoverage = new Uint8Array(coverage);
    for (let py = 0; py < DEM_TILE_SIZE; py++) {
      for (let px = 0; px < DEM_TILE_SIZE; px++) {
        const idx = py * DEM_TILE_SIZE + px;
        if (coverage[idx]) continue;
        let sum = 0, count = 0;
        if (py > 0 && coverage[idx - DEM_TILE_SIZE]) { sum += elevations[idx - DEM_TILE_SIZE]; count++; }
        if (py < DEM_TILE_SIZE - 1 && coverage[idx + DEM_TILE_SIZE]) { sum += elevations[idx + DEM_TILE_SIZE]; count++; }
        if (px > 0 && coverage[idx - 1]) { sum += elevations[idx - 1]; count++; }
        if (px < DEM_TILE_SIZE - 1 && coverage[idx + 1]) { sum += elevations[idx + 1]; count++; }
        if (count > 0) {
          newElevations[idx] = sum / count;
          newCoverage[idx] = 1;
          coveredCount++;
        }
      }
    }
    elevations.set(newElevations);
    coverage.set(newCoverage);
  }

  if (coveredCount >= totalPixels) {
    return { blob: await encodeTerrainRGBPng(elevations), elevations, coverage };
  }

  return { blob: null, elevations, coverage };
}
