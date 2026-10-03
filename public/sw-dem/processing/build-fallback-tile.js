// ---------------------------------------------------------------------------
// Build HIGHRES (5 m) fallback tile — same resampling as buildIGNTile but
// targeting ELEVATION.ELEVATIONGRIDCOVERAGE.HIGHRES (WGS84G_6_14, z6-14).
// Called only when MNS returned 0 coverage for this tile.
// ---------------------------------------------------------------------------
async function buildIGNFallbackTile(mercZ, mercX, mercY) {
  const t0 = performance.now();
  const demZ = Math.max(IGN_DEM_FALLBACK_MINZOOM, Math.min(mercZ, IGN_DEM_FALLBACK_MAXZOOM));
  const bounds = mercatorTileBounds(mercZ, mercX, mercY);
  const tl = lngLatToWGS84GTile(bounds.west, bounds.north, demZ);
  const br = lngLatToWGS84GTile(bounds.east, bounds.south, demZ);

  const gridCols = br.col - tl.col + 1;
  const gridRows = br.row - tl.row + 1;
  const totalSubTiles = Math.max(0, gridCols * gridRows);
  const subTileGrid = new Array(totalSubTiles).fill(null);

  const fetches = [];
  let fetchCount = 0;
  for (let row = tl.row; row <= br.row; row++) {
    const rowOffset = (row - tl.row) * gridCols;
    for (let col = tl.col; col <= br.col; col++) {
      const gridIdx = rowOffset + (col - tl.col);
      fetchCount++;
      subTileGrid[gridIdx] = undefined;
      fetches.push(
        getHighresTileWithFallback(demZ, col, row).then((result) => {
          subTileGrid[gridIdx] = result || null;
        }),
      );
    }
  }

  // Shorter deadline for HIGHRES
  const softDeadlineMs = Math.min(3000, typeof ignSoftDeadlineMs === 'function'
    ? ignSoftDeadlineMs(mercZ) : IGN_SUBTILE_SOFT_DEADLINE_MS);
  await Promise.race([
    Promise.all(fetches),
    new Promise((resolve) => setTimeout(resolve, softDeadlineMs)),
  ]);

  let pendingCount = 0;
  for (let i = 0; i < totalSubTiles; i++) {
    if (subTileGrid[i] === undefined) { subTileGrid[i] = null; pendingCount++; }
  }
  const hasPending = pendingCount > 0;

  let hrOk = 0, hrMissing = 0;
  for (let i = 0; i < totalSubTiles; i++) {
    const result = subTileGrid[i];
    if (result && result.data) hrOk++;
    else hrMissing++;
  }
  if (typeof swLog !== 'undefined' && swLog.isDebug()) {
    swLog.debug(
      'build-hr',
      `%c HIGHRES %c ${mercZ}/${mercX}/${mercY} — ${fetchCount} sub-tiles: ok=${hrOk} missing=${hrMissing} (demZ=${demZ})`,
      'background:#9C27B0;color:#fff;padding:2px 4px;border-radius:2px', ''
    );
  }

  const totalPixels = DEM_TILE_SIZE * DEM_TILE_SIZE;
  const elevations = new Float32Array(totalPixels);
  const coverage = new Uint8Array(totalPixels);
  const n = 1 << mercZ;
  let coveredCount = 0;

  const matrixWidth = 1 << (demZ + 1);
  const matrixHeight = 1 << demZ;

  for (let py = 0; py < DEM_TILE_SIZE; py++) {
    const yFrac = (mercY + (py + 0.5) / DEM_TILE_SIZE) / n;
    const lat = mercatorYToLat(yFrac);
    const row = Math.max(0, Math.min(Math.floor(((90 - lat) / 180) * matrixHeight), matrixHeight - 1));
    const relRow = row - tl.row;
    const rowInGrid = relRow >= 0 && relRow < gridRows;
    const rowOffset = relRow * gridCols;

    for (let px = 0; px < DEM_TILE_SIZE; px++) {
      const xFrac = (mercX + (px + 0.5) / DEM_TILE_SIZE) / n;
      const lng = xFrac * 360 - 180;

      if (!rowInGrid) continue;
      const col = Math.max(0, Math.min(Math.floor(((lng + 180) / 360) * matrixWidth), matrixWidth - 1));
      const relCol = col - tl.col;
      if (relCol < 0 || relCol >= gridCols) continue;

      const result = subTileGrid[rowOffset + relCol];
      if (result && result.data) {
        const aZ = result.actualZ;
        const aCol = result.actualCol;
        const aRow = result.actualRow;
        const aMatW = 1 << (aZ + 1);
        const aMatH = 1 << aZ;

        const fx = (((lng + 180) / 360) * aMatW - aCol) * IGN_SRC_TILE_SIZE;
        const fy = (((90 - lat) / 180) * aMatH - aRow) * IGN_SRC_TILE_SIZE;

        if (hasValidRawElevation(result.data, fx, fy)) {
          const sampled = bilinearSample(result.data, fx, fy);
          if (!Number.isNaN(sampled)) {
            elevations[py * DEM_TILE_SIZE + px] = sampled;
            coverage[py * DEM_TILE_SIZE + px] = 1;
            coveredCount++;
          }
        }
      }
    }
  }

  subTileGrid.fill(null);
  const pendingFetches = hasPending ? fetches : null;

  if (coveredCount === 0) {
    const dt = (performance.now() - t0).toFixed(1);
    if (typeof swLog !== 'undefined') {
      swLog.debug('build-hr', `${mercZ}/${mercX}/${mercY} — 0 HIGHRES coverage, ${dt}ms`);
    }
    return null;
  }

  const source = 'ign-highres';

  // Full coverage fast path
  if (coveredCount === totalPixels) {
    const dt = (performance.now() - t0).toFixed(1);
    if (typeof swLog !== 'undefined' && swLog.isDebug()) {
      swLog.debug(
        'build-hr',
        `%c ${source} %c ${mercZ}/${mercX}/${mercY} — full coverage, ${fetchCount} sub-tiles, ${dt}ms`,
        'background:#9C27B0;color:#fff;padding:2px 4px;border-radius:2px', ''
      );
    }
    despikeElevations(elevations, coverage, DEM_TILE_SIZE);
    return { blob: null, elevations, coverage, source, pendingFetches };
  }

  // Mapbox prefill for uncovered pixels (same as MNS path)
  if (coveredCount < totalPixels && mercZ <= MAPBOX_DEM_MAXZOOM) {
    try {
      const mbBlob = await fetchMapboxTile(mercZ, mercX, mercY);
      if (mbBlob) {
        const mbElev = await decodeTerrainRGBBlob(mbBlob);
        if (mbElev && mbElev.length > 0) {
          const mbSize = Math.round(Math.sqrt(mbElev.length));
          const mbScale = mbSize / DEM_TILE_SIZE;
          for (let i = 0; i < totalPixels; i++) {
            if (!coverage[i]) {
              if (mbScale === 1) {
                elevations[i] = mbElev[i];
              } else {
                const py2 = (i / DEM_TILE_SIZE) | 0;
                const px2 = i % DEM_TILE_SIZE;
                const mx = Math.min((px2 * mbScale) | 0, mbSize - 1);
                const my = Math.min((py2 * mbScale) | 0, mbSize - 1);
                elevations[i] = mbElev[my * mbSize + mx];
              }
            }
          }
        }
      }
    } catch { /* best-effort */ }
  }

  // Dilation with recycled ping-pong buffers
  const coverageRatio = coveredCount / totalPixels;
  const dilationPasses = coverageRatio > 0.9 ? 2 : 4;
  const scratchElev = new Float32Array(totalPixels);
  const scratchCov = new Uint8Array(totalPixels);

  for (let pass = 0; pass < dilationPasses; pass++) {
    scratchElev.set(elevations);
    scratchCov.set(coverage);
    for (let py = 0; py < DEM_TILE_SIZE; py++) {
      const row = py * DEM_TILE_SIZE;
      for (let px = 0; px < DEM_TILE_SIZE; px++) {
        const idx = row + px;
        if (coverage[idx]) continue;
        let sum = 0, count = 0;
        if (py > 0 && coverage[idx - DEM_TILE_SIZE]) { sum += elevations[idx - DEM_TILE_SIZE]; count++; }
        if (py < DEM_TILE_SIZE - 1 && coverage[idx + DEM_TILE_SIZE]) { sum += elevations[idx + DEM_TILE_SIZE]; count++; }
        if (px > 0 && coverage[idx - 1]) { sum += elevations[idx - 1]; count++; }
        if (px < DEM_TILE_SIZE - 1 && coverage[idx + 1]) { sum += elevations[idx + 1]; count++; }
        if (py > 0 && px > 0 && coverage[idx - DEM_TILE_SIZE - 1]) { sum += elevations[idx - DEM_TILE_SIZE - 1]; count++; }
        if (py > 0 && px < DEM_TILE_SIZE - 1 && coverage[idx - DEM_TILE_SIZE + 1]) { sum += elevations[idx - DEM_TILE_SIZE + 1]; count++; }
        if (py < DEM_TILE_SIZE - 1 && px > 0 && coverage[idx + DEM_TILE_SIZE - 1]) { sum += elevations[idx + DEM_TILE_SIZE - 1]; count++; }
        if (py < DEM_TILE_SIZE - 1 && px < DEM_TILE_SIZE - 1 && coverage[idx + DEM_TILE_SIZE + 1]) { sum += elevations[idx + DEM_TILE_SIZE + 1]; count++; }
        if (count > 0) { scratchElev[idx] = sum / count; scratchCov[idx] = 1; coveredCount++; }
      }
    }
    elevations.set(scratchElev);
    coverage.set(scratchCov);
  }

  if (coveredCount >= totalPixels) {
    const dt = (performance.now() - t0).toFixed(1);
    if (typeof swLog !== 'undefined') {
      swLog.debug('build-hr', `${mercZ}/${mercX}/${mercY} — dilated to full, ${dt}ms`);
    }
    despikeElevations(elevations, coverage, DEM_TILE_SIZE);
    return { blob: await encodeTerrainRGBPng(elevations), elevations, coverage, source, pendingFetches };
  }

  const dt = (performance.now() - t0).toFixed(1);
  const covPct = (coveredCount / totalPixels * 100).toFixed(1);
  if (typeof swLog !== 'undefined') {
    swLog.debug('build-hr', `${mercZ}/${mercX}/${mercY} — partial ${covPct}%, ${dt}ms`);
  }
  despikeElevations(elevations, coverage, DEM_TILE_SIZE);
  return { blob: null, elevations, coverage, source, pendingFetches };
}
