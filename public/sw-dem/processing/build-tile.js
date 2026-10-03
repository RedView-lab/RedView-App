// ---------------------------------------------------------------------------
// Build IGN Terrain-RGB tile (Mercator ← WGS84G resampling + border dilation)
// Returns { blob, elevations, coverage, source } or null
// Uses zoom-level fallback: if tile missing at demZ, tries lower zoom levels
// ---------------------------------------------------------------------------
// Helpers: build-tile-support.js. HIGHRES 5 m fallback: build-fallback-tile.js.
// RGE ALTI terrain (WMS): build-terrain-tile.js.

// tile (see scheduleIGN in sources/ign-scheduler.js, isMapDemTileWanted in sources/ign-cancel.js).
async function buildIGNTile(mercZ, mercX, mercY, tileClass, tilePurpose = null, mapTile = null) {
  const t0 = performance.now();
  const isBorder = tileClass === 'border';

  // ── High-Performance WMS LiDAR HD Path (1 single HTTP request per Mercator tile) ──
  if (typeof getMnsWmsTile === 'function') {
    const rawElevations = await fetchIgnRasterThroughCancels(
      () => getMnsWmsTile(mercZ, mercX, mercY, tilePurpose, mapTile),
      tilePurpose,
      mapTile,
    );
    if (rawElevations === IGN_FETCH_CANCELLED) return cancelledIgnBuild();
    if (rawElevations && rawElevations.length === DEM_TILE_SIZE * DEM_TILE_SIZE) {
      const totalPixels = DEM_TILE_SIZE * DEM_TILE_SIZE;
      const elevations = new Float32Array(totalPixels);
      const coverage = new Uint8Array(totalPixels);
      let coveredCount = 0;

      for (let i = 0; i < totalPixels; i++) {
        const v = rawElevations[i];
        if (!Number.isNaN(v) && v >= MIN_VALID_ELEVATION_M && v <= MAX_VALID_ELEVATION_M) {
          elevations[i] = v;
          coverage[i] = 1;
          coveredCount++;
        }
      }

      if (coveredCount > 0) {
        despikeElevations(elevations, coverage, DEM_TILE_SIZE);
        const source = 'ign-lidar-hd-wms';

        // Full coverage: return immediately without low-pass blur to preserve true 0.40m LiDAR detail
        if (coveredCount === totalPixels) {
          const dt = (performance.now() - t0).toFixed(1);
          if (typeof swLog !== 'undefined' && swLog.isDebug()) {
            swLog.debug(
              'build',
              `%c ${source} %c ${mercZ}/${mercX}/${mercY} — full coverage, ${dt}ms`,
              'background:#4CAF50;color:#fff;padding:2px 4px;border-radius:2px', '',
            );
          }
          return { blob: null, elevations, coverage, source, pendingFetches: null };
        }

        // Partial coverage (border tiles): fill uncovered border pixels with AWS/Mapbox
        try {
          let bgBlob = null;
          if (typeof fetchAWSTerrainTile === 'function') {
            bgBlob = await fetchAWSTerrainTile(mercZ, mercX, mercY);
          }
          if (!bgBlob && mercZ <= MAPBOX_DEM_MAXZOOM && typeof fetchMapboxTile === 'function') {
            bgBlob = await fetchMapboxTile(mercZ, mercX, mercY);
          }
          if (bgBlob) {
            const bgElev = await decodeTerrainRGBBlob(bgBlob);
            if (bgElev && bgElev.length > 0) {
              const bgSize = Math.round(Math.sqrt(bgElev.length));
              const bgScale = bgSize / DEM_TILE_SIZE;
              for (let i = 0; i < totalPixels; i++) {
                if (!coverage[i]) {
                  const py = (i / DEM_TILE_SIZE) | 0;
                  const px = i % DEM_TILE_SIZE;
                  const mx = Math.min((px * bgScale) | 0, bgSize - 1);
                  const my = Math.min((py * bgScale) | 0, bgSize - 1);
                  const val = bgElev[my * bgSize + mx];
                  if (!Number.isNaN(val) && val >= MIN_VALID_ELEVATION_M && val <= MAX_VALID_ELEVATION_M) {
                    elevations[i] = val;
                    coverage[i] = 1;
                    coveredCount++;
                  }
                }
              }
            }
          }
        } catch { /* best-effort */ }

        // Adaptive border dilation
        const coverageRatio = coveredCount / totalPixels;
        const dilationPasses = coverageRatio > 0.9 ? 2 : 4;
        for (let pass = 0; pass < dilationPasses; pass++) {
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

        return { blob: null, elevations, coverage, source, pendingFetches: null };
      }
    }
  }

  // Only a WMS that answered "no LiDAR here" lets this build report a genuine
  // coverage gap. A timed-out / aborted WMS request plus a legacy fallback
  // that also fails is a transient miss: reporting it as allPermanent404 made
  // the dispatcher negative-cache the area and commit bare earth for good.
  const mnsWmsConfirmedEmpty = typeof getMnsWmsTile !== 'function'
    || isMnsWmsConfirmedEmpty(mercZ, mercX, mercY);

  // ── Legacy Multi-Subtile WMTS Fallback ──
  // Zoom-aware MNS source bias (see ignMnsSourceZoomBias in config.js).
  // Avoids the 63-sub-tile fan-out that wedged the SW thread at z14.
  const mnsBias = (typeof ignMnsSourceZoomBias === 'function')
    ? ignMnsSourceZoomBias(mercZ)
    : 2;
  let demZ = Math.max(
    IGN_DEM_MINZOOM,
    Math.min(mercZ + mnsBias, IGN_DEM_MAXZOOM),
  );

  // Fast skip: if this area is known to have no MNS data, return immediately
  // instead of enqueuing 6-9 sub-tile fetches that will all 404.
  if (mnsAreaNegGet(mercZ, mercX, mercY)) {
    return {
      blob: null, elevations: null, coverage: null,
      source: 'ign-empty-cached', allPermanent404: mnsWmsConfirmedEmpty, pendingFetches: null,
    };
  }

  const bounds = mercatorTileBounds(mercZ, mercX, mercY);
  let tl = lngLatToWGS84GTile(bounds.west, bounds.north, demZ);
  let br = lngLatToWGS84GTile(bounds.east, bounds.south, demZ);
  let gridCols = br.col - tl.col + 1;
  let gridRows = br.row - tl.row + 1;

  // Dynamic cap: if sub-tile fan-out exceeds 12, step demZ down by 1 so no
  // single Mercator tile ever explodes into 20-40 HTTP fetches.
  if (gridCols * gridRows > 12 && demZ > IGN_DEM_MINZOOM) {
    demZ -= 1;
    tl = lngLatToWGS84GTile(bounds.west, bounds.north, demZ);
    br = lngLatToWGS84GTile(bounds.east, bounds.south, demZ);
    gridCols = br.col - tl.col + 1;
    gridRows = br.row - tl.row + 1;
  }

  // Log source zoom remapping — useful when diagnosing why surface detail is
  // missing (too coarse demZ) or why a close view hits the max zoom clamp.
  if (demZ !== mercZ && typeof swLog !== 'undefined' && swLog.isDebug()) {
    swLog.debug(
      'build',
      `%c SOURCE ZOOM %c ${mercZ}/${mercX}/${mercY} — requested z${mercZ}, using demZ=${demZ} (Δ=${demZ - mercZ}, ${gridCols * gridRows} sub-tiles)`,
      'background:#FF9800;color:#fff;padding:2px 4px;border-radius:2px', ''
    );
  }

  // Fetch all needed IGN tiles — with zoom-level fallback.
  // tileMap stores: { data, actualZ, actualCol, actualRow } or null.
  // Each fetch writes its result into tileMap on completion; entries that
  // haven't settled by the soft deadline remain `undefined` and are treated
  // as null for the immediate build. The original promises are kept alive
  // (`fetches`) so the caller can await them in background and trigger a
  // cache-upgrade once the tail stragglers arrive.
  const softDeadlineMs = typeof ignSoftDeadlineMs === 'function'
    ? ignSoftDeadlineMs(mercZ)
    : IGN_SUBTILE_SOFT_DEADLINE_MS;
  const deadlineAt = t0 + softDeadlineMs;

  const totalSubTiles = Math.max(0, gridCols * gridRows);
  const subTileGrid = new Array(totalSubTiles).fill(null);

  // Center-first sub-tile order: fetch the central sub-tiles before the perimeter
  const midRow = (tl.row + br.row) / 2;
  const midCol = (tl.col + br.col) / 2;
  const subTileOrder = [];
  for (let row = tl.row; row <= br.row; row++) {
    const rowOffset = (row - tl.row) * gridCols;
    for (let col = tl.col; col <= br.col; col++) {
      const gridIdx = rowOffset + (col - tl.col);
      const dRow = row - midRow;
      const dCol = col - midCol;
      subTileOrder.push({ row, col, gridIdx, dist: dRow * dRow + dCol * dCol });
    }
  }
  subTileOrder.sort((a, b) => a.dist - b.dist);

  const fetches = [];
  let fetchCount = 0;
  let settledCount = 0;
  let anySuccess = false;
  const allSettled = new Promise((resolveAll) => {
    let settledMisses = 0;
    let settledHits = 0;
    const checkDone = () => {
      if (settledCount >= fetchCount) { resolveAll(); return; }
      if (performance.now() >= deadlineAt) { resolveAll(); return; }
      const earlyAbortThreshold = Math.max(3, Math.floor(fetchCount * 0.7));
      if (settledHits === 0 && settledMisses >= earlyAbortThreshold) {
        resolveAll(); return;
      }
    };

    for (let i = 0; i < subTileOrder.length; i++) {
      const { row, col, gridIdx } = subTileOrder[i];
      fetchCount++;
      subTileGrid[gridIdx] = undefined; // placeholder — "pending"
      fetches.push(
        getIGNTileWithFallback(demZ, col, row, deadlineAt, tilePurpose).then((result) => {
          subTileGrid[gridIdx] = result || null;
          settledCount++;
          if (result && result.data) {
            anySuccess = true;
            settledHits++;
          } else {
            settledMisses++;
          }
          checkDone();
        }),
      );
    }
    if (fetchCount === 0) resolveAll();
  });

  // Macrotask deadline fallback
  await Promise.race([
    allSettled,
    new Promise((resolve) => setTimeout(resolve, softDeadlineMs)),
  ]);

  let pendingCount = 0;
  for (let i = 0; i < totalSubTiles; i++) {
    if (subTileGrid[i] === undefined) {
      subTileGrid[i] = null;
      pendingCount++;
    }
  }
  const hasPending = pendingCount > 0;
  if (hasPending && typeof swLog !== 'undefined' && swLog.isDebug()) {
    swLog.debug(
      'build',
      `soft-deadline ${mercZ}/${mercX}/${mercY} — ${fetchCount - pendingCount}/${fetchCount} settled, ${pendingCount} continuing in background`,
    );
  }

  // Log IGN sub-tile fetch results
  let ignOk = 0, ignFallback = 0, ignMissing = 0, ignMissing404 = 0;
  for (let i = 0; i < totalSubTiles; i++) {
    const result = subTileGrid[i];
    if (result && result.data) {
      if (result.actualZ < demZ) ignFallback++;
      else ignOk++;
    } else {
      ignMissing++;
      const row = tl.row + Math.floor(i / gridCols);
      const col = tl.col + (i % gridCols);
      if (isCachedPermanent404(`${demZ}/${col}/${row}`)) ignMissing404++;
    }
  }
  if ((ignMissing > 0 || ignFallback > 0) && typeof swLog !== 'undefined' && swLog.isDebug()) {
    swLog.debug(
      'build',
      `%c IGN FETCH %c ${mercZ}/${mercX}/${mercY} — ${fetchCount} sub-tiles: ok=${ignOk} fallback=${ignFallback} missing=${ignMissing} (demZ=${demZ})`,
      'background:#2196F3;color:#fff;padding:2px 4px;border-radius:2px', ''
    );
  }

  // Track whether any fallback zoom was used (for diagnostics)
  let usedFallback = false;
  let minFallbackZ = demZ;

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

      // For border tiles, skip pixels outside France polygon
      if (isBorder && francePoly && !pointInFrance(lng, lat)) continue;

      if (!rowInGrid) continue;
      const col = Math.max(0, Math.min(Math.floor(((lng + 180) / 360) * matrixWidth), matrixWidth - 1));
      const relCol = col - tl.col;
      if (relCol < 0 || relCol >= gridCols) continue;

      const result = subTileGrid[rowOffset + relCol];
      if (result && result.data) {
        // Compute fractional pixel coords in the ACTUAL tile's coordinate space
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

            if (aZ < demZ) {
              usedFallback = true;
              minFallbackZ = Math.min(minFallbackZ, aZ);
            }
          }
        }
      }
    }
  }

  // Release IGN source tile references — no longer needed after resampling
  subTileGrid.fill(null);

  // Expose in-flight promises to the caller so it can schedule a background
  // cache upgrade once slow stragglers eventually settle.
  const pendingFetches = hasPending ? fetches : null;

  if (coveredCount === 0) {
    const dt = (performance.now() - t0).toFixed(1);
    if (typeof swLog !== 'undefined') {
      swLog.debug('build', `${mercZ}/${mercX}/${mercY} — 0 coverage, ${fetchCount} sub-tiles, ${dt}ms`);
    }
    return {
      blob: null, elevations: null, coverage: null,
      source: 'ign-empty',
      // Sub-tiles still in flight after the early abort are presumed empty
      // like their settled siblings; a settled miss that is not a cached 404
      // (timeout, abort, 5xx) makes the whole build transient.
      allPermanent404: mnsWmsConfirmedEmpty
        && ignMissing404 > 0
        && ignMissing404 === ignMissing - pendingCount,
      pendingFetches,
    };
  }

  // Determine source label for diagnostics
  const source = usedFallback ? `ign-fallback-z${minFallbackZ}` : 'ign';

  if (coveredCount === totalPixels) {
    const dt = (performance.now() - t0).toFixed(1);
    let eMin = Infinity, eMax = -Infinity;
    for (let i = 0; i < totalPixels; i++) {
      if (elevations[i] < eMin) eMin = elevations[i];
      if (elevations[i] > eMax) eMax = elevations[i];
    }
    const eRange = eMax - eMin;
    if (typeof swLog !== 'undefined' && swLog.isDebug()) {
      const rangeColor = eRange < 5 ? '#f44336' : eRange < 50 ? '#FF9800' : '#4CAF50';
      swLog.debug(
        'build',
        `%c ${source} %c ${mercZ}/${mercX}/${mercY} — full coverage, elev=[${eMin.toFixed(1)}..${eMax.toFixed(1)}] range=${eRange.toFixed(1)}m, ${fetchCount} sub-tiles, ${dt}ms`,
        `background:${rangeColor};color:#fff;padding:2px 4px;border-radius:2px`, ''
      );
    }
    if (eRange < 5 && typeof swLog !== 'undefined' && swLog.isDebug()) {
      swLog.warn(
        'build',
        `%c ⚠ FLAT OUTPUT %c ${mercZ}/${mercX}/${mercY} — elevation range ${eRange.toFixed(1)}m → terrain will be flat! demZ=${demZ} mercZ=${mercZ}`,
        'background:#f44336;color:#fff;padding:2px 6px;border-radius:3px;font-weight:bold', ''
      );
    }
    postProcessFranceMnsTile(elevations, coverage, mercZ);
    return { blob: null, elevations, coverage, source, pendingFetches };
  }

  // --- Pre-fill uncovered pixels with Mapbox elevation ---
  let prefilledMbElev = null;
  if (coveredCount < totalPixels && mercZ <= MAPBOX_DEM_MAXZOOM) {
    try {
      const mbBlob = await fetchMapboxTile(mercZ, mercX, mercY);
      if (mbBlob) {
        const mbElev = await decodeTerrainRGBBlob(mbBlob);
        if (mbElev && mbElev.length > 0) {
          prefilledMbElev = mbElev;
          const mbSize = Math.round(Math.sqrt(mbElev.length));
          const mbScale = mbSize / DEM_TILE_SIZE;
          for (let i = 0; i < totalPixels; i++) {
            if (!coverage[i]) {
              if (mbScale === 1) {
                elevations[i] = mbElev[i];
              } else {
                const py = (i / DEM_TILE_SIZE) | 0;
                const px = i % DEM_TILE_SIZE;
                const mx = Math.min((px * mbScale) | 0, mbSize - 1);
                const my = Math.min((py * mbScale) | 0, mbSize - 1);
                elevations[i] = mbElev[my * mbSize + mx];
              }
            }
          }
        }
      }
    } catch { /* best-effort */ }
  }

  // --- Adaptive border pixel dilation (8-connected) with recycled ping-pong buffers ---
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
        // Cardinal neighbors (4-connected)
        if (py > 0 && coverage[idx - DEM_TILE_SIZE]) { sum += elevations[idx - DEM_TILE_SIZE]; count++; }
        if (py < DEM_TILE_SIZE - 1 && coverage[idx + DEM_TILE_SIZE]) { sum += elevations[idx + DEM_TILE_SIZE]; count++; }
        if (px > 0 && coverage[idx - 1]) { sum += elevations[idx - 1]; count++; }
        if (px < DEM_TILE_SIZE - 1 && coverage[idx + 1]) { sum += elevations[idx + 1]; count++; }
        // Diagonal neighbors (8-connected)
        if (py > 0 && px > 0 && coverage[idx - DEM_TILE_SIZE - 1]) { sum += elevations[idx - DEM_TILE_SIZE - 1]; count++; }
        if (py > 0 && px < DEM_TILE_SIZE - 1 && coverage[idx - DEM_TILE_SIZE + 1]) { sum += elevations[idx - DEM_TILE_SIZE + 1]; count++; }
        if (py < DEM_TILE_SIZE - 1 && px > 0 && coverage[idx + DEM_TILE_SIZE - 1]) { sum += elevations[idx + DEM_TILE_SIZE - 1]; count++; }
        if (py < DEM_TILE_SIZE - 1 && px < DEM_TILE_SIZE - 1 && coverage[idx + DEM_TILE_SIZE + 1]) { sum += elevations[idx + DEM_TILE_SIZE + 1]; count++; }
        if (count > 0) {
          scratchElev[idx] = sum / count;
          scratchCov[idx] = 1;
          coveredCount++;
        }
      }
    }
    elevations.set(scratchElev);
    coverage.set(scratchCov);
  }

  if (coveredCount >= totalPixels) {
    const dt = (performance.now() - t0).toFixed(1);
    if (typeof swLog !== 'undefined') {
      swLog.debug('build', `${mercZ}/${mercX}/${mercY} — dilated to full, src=${source}, ${dilationPasses} passes, ${dt}ms`);
    }
    postProcessFranceMnsTile(elevations, coverage, mercZ);
    return { blob: await encodeTerrainRGBPng(elevations), elevations, coverage, source, pendingFetches, prefilledMbElev };
  }

  const dt = (performance.now() - t0).toFixed(1);
  const covPct = (coveredCount / totalPixels * 100).toFixed(1);
  if (typeof swLog !== 'undefined') {
    swLog.debug('build', `${mercZ}/${mercX}/${mercY} — partial ${covPct}%, src=${source}, ${dilationPasses} passes, ${dt}ms`);
  }
  postProcessFranceMnsTile(elevations, coverage, mercZ);
  return { blob: null, elevations, coverage, source, pendingFetches, prefilledMbElev };
}
