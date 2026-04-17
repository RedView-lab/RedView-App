// ---------------------------------------------------------------------------
// Build IGN Terrain-RGB tile (Mercator ← WGS84G resampling + border dilation)
// Returns { blob, elevations, coverage, source } or null
// Uses zoom-level fallback: if tile missing at demZ, tries lower zoom levels
// ---------------------------------------------------------------------------

async function buildIGNTile(mercZ, mercX, mercY, tileClass) {
  const t0 = performance.now();
  const isBorder = tileClass === 'border';
  const demZ = Math.max(IGN_DEM_MINZOOM, Math.min(mercZ, IGN_DEM_MAXZOOM));
  const bounds = mercatorTileBounds(mercZ, mercX, mercY);
  const tl = lngLatToWGS84GTile(bounds.west, bounds.north, demZ);
  const br = lngLatToWGS84GTile(bounds.east, bounds.south, demZ);

  // Log zoom clamping — key indicator of overzoom-induced flattening
  if (demZ < mercZ) {
    console.log(
      `[sw-dem][build] %c ZOOM CLAMP %c ${mercZ}/${mercX}/${mercY} — requested z${mercZ} but IGN maxzoom=${IGN_DEM_MAXZOOM}, using demZ=${demZ} (Δ=${mercZ - demZ})`,
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
  const tileMap = new Map();
  const fetches = [];
  const keys = [];
  let fetchCount = 0;
  for (let row = tl.row; row <= br.row; row++) {
    for (let col = tl.col; col <= br.col; col++) {
      fetchCount++;
      const key = `${col}/${row}`;
      keys.push(key);
      tileMap.set(key, undefined); // placeholder — "pending"
      fetches.push(
        getIGNTileWithFallback(demZ, col, row).then((result) => {
          tileMap.set(key, result);
        }),
      );
    }
  }

  // Soft per-build deadline — serve best available result ASAP, let stragglers
  // finish in the background (see `pendingFetches` in return value).
  await Promise.race([
    Promise.all(fetches),
    new Promise((resolve) => setTimeout(resolve, IGN_SUBTILE_SOFT_DEADLINE_MS)),
  ]);

  // Count / clear still-pending entries so the resampling loop below sees null.
  let pendingCount = 0;
  for (const k of keys) {
    if (tileMap.get(k) === undefined) {
      tileMap.set(k, null);
      pendingCount++;
    }
  }
  const hasPending = pendingCount > 0;
  if (hasPending && DEBUG) {
    console.log(
      `[sw-dem][build] soft-deadline ${mercZ}/${mercX}/${mercY} — ${fetchCount - pendingCount}/${fetchCount} settled, ${pendingCount} continuing in background`,
    );
  }

  // Log IGN sub-tile fetch results
  let ignOk = 0, ignFallback = 0, ignMissing = 0;
  for (const [key, result] of tileMap) {
    if (result && result.data) {
      if (result.actualZ < demZ) ignFallback++;
      else ignOk++;
    } else {
      ignMissing++;
    }
  }
  if (ignMissing > 0 || ignFallback > 0) {
    console.log(
      `[sw-dem][build] %c IGN FETCH %c ${mercZ}/${mercX}/${mercY} — ${fetchCount} sub-tiles: ok=${ignOk} fallback=${ignFallback} missing=${ignMissing} (demZ=${demZ})`,
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

  for (let py = 0; py < DEM_TILE_SIZE; py++) {
    const yFrac = (mercY + (py + 0.5) / DEM_TILE_SIZE) / n;
    const lat = mercatorYToLat(yFrac);

    for (let px = 0; px < DEM_TILE_SIZE; px++) {
      const xFrac = (mercX + (px + 0.5) / DEM_TILE_SIZE) / n;
      const lng = xFrac * 360 - 180;

      // Compute which tile at demZ this pixel maps to
      const matrixWidth = 1 << (demZ + 1);
      const matrixHeight = 1 << demZ;
      const col = Math.max(0, Math.min(Math.floor(((lng + 180) / 360) * matrixWidth), matrixWidth - 1));
      const row = Math.max(0, Math.min(Math.floor(((90 - lat) / 180) * matrixHeight), matrixHeight - 1));

      // For border tiles, skip pixels outside France polygon
      if (isBorder && francePoly && !pointInFrance(lng, lat)) continue;

      const result = tileMap.get(`${col}/${row}`);
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
  tileMap.clear();

  // Expose in-flight promises to the caller so it can schedule a background
  // cache upgrade once slow stragglers eventually settle.
  const pendingFetches = hasPending ? fetches : null;

  if (coveredCount === 0) {
    const dt = (performance.now() - t0).toFixed(1);
    console.log(`[sw-dem][build] ${mercZ}/${mercX}/${mercY} — 0 coverage, ${fetchCount} sub-tiles, ${dt}ms`);
    return null;
  }

  // Determine source label for diagnostics
  const source = usedFallback ? `ign-fallback-z${minFallbackZ}` : 'ign';

  if (coveredCount === totalPixels) {
    const dt = (performance.now() - t0).toFixed(1);
    // Log elevation range for full-coverage tiles
    let eMin = Infinity, eMax = -Infinity;
    for (let i = 0; i < totalPixels; i++) {
      if (elevations[i] < eMin) eMin = elevations[i];
      if (elevations[i] > eMax) eMax = elevations[i];
    }
    const eRange = eMax - eMin;
    const rangeColor = eRange < 5 ? '#f44336' : eRange < 50 ? '#FF9800' : '#4CAF50';
    console.log(
      `[sw-dem][build] %c ${source} %c ${mercZ}/${mercX}/${mercY} — full coverage, elev=[${eMin.toFixed(1)}..${eMax.toFixed(1)}] range=${eRange.toFixed(1)}m, ${fetchCount} sub-tiles, ${dt}ms`,
      `background:${rangeColor};color:#fff;padding:2px 4px;border-radius:2px`, ''
    );
    if (eRange < 5) {
      console.warn(
        `[sw-dem][build] %c ⚠ FLAT OUTPUT %c ${mercZ}/${mercX}/${mercY} — elevation range ${eRange.toFixed(1)}m → terrain will be flat! demZ=${demZ} mercZ=${mercZ}`,
        'background:#f44336;color:#fff;padding:2px 6px;border-radius:3px;font-weight:bold', ''
      );
    }
    return { blob: await encodeTerrainRGBPng(elevations), elevations, coverage, source, pendingFetches };
  }

  // --- Pre-fill uncovered border pixels with Mapbox elevation ---
  // Prevents 0m sea-level default from creating km-high vertical cliffs
  // at France borders where IGN stops and uncovered pixels remain.
  if (isBorder && coveredCount < totalPixels) {
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
    } catch (e) {
      // Mapbox prefill is best-effort; continue with dilation if it fails
    }
  }

  // --- Adaptive border pixel dilation (8-connected) ---
  // Capped at 4 passes max to limit memory pressure in the SW.
  // Mapbox prefill already covers uncovered pixels, so fewer passes suffice.
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
    const dt = (performance.now() - t0).toFixed(1);
    console.log(`[sw-dem][build] ${mercZ}/${mercX}/${mercY} — dilated to full, src=${source}, ${dilationPasses} passes, ${dt}ms`);
    return { blob: await encodeTerrainRGBPng(elevations), elevations, coverage, source, pendingFetches };
  }

  const dt = (performance.now() - t0).toFixed(1);
  const covPct = (coveredCount / totalPixels * 100).toFixed(1);
  console.log(`[sw-dem][build] ${mercZ}/${mercX}/${mercY} — partial ${covPct}%, src=${source}, ${dilationPasses} passes, ${dt}ms`);
  return { blob: null, elevations, coverage, source, pendingFetches };
}
