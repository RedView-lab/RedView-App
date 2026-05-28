// ---------------------------------------------------------------------------
// Build IGN Terrain-RGB tile (Mercator ← WGS84G resampling + border dilation)
// Returns { blob, elevations, coverage, source } or null
// Uses zoom-level fallback: if tile missing at demZ, tries lower zoom levels
// ---------------------------------------------------------------------------

// Area-level MNS negative cache — remembers Mercator tile regions where MNS
// returned 0 coverage with all permanent 404s. Adjacent tiles share the same
// IGN sub-tiles, so skipping MNS for known-empty areas saves 4-8 s per tile.
// TTL: 30 min. Map key: "z/x/y" at the demZ level (clamped zoom), which
// groups nearby Mercator tiles that map to the same IGN sub-tile grid.
const mnsAreaNegCache = new Map();
const MNS_AREA_NEG_TTL = 30 * 60_000; // 30 min

function mnsAreaNegKey(z, x, y) {
  // Group at z14 granularity (IGN_DEM_MAXZOOM clamp point) so adjacent
  // Mercator tiles at z15-17 that map to the same z14 IGN sub-tiles share
  // one negative cache entry.
  const groupZ = Math.min(z, IGN_DEM_MAXZOOM);
  const shift = z - groupZ;
  return `${groupZ}/${x >> shift}/${y >> shift}`;
}

function mnsAreaNegGet(z, x, y) {
  const key = mnsAreaNegKey(z, x, y);
  const entry = mnsAreaNegCache.get(key);
  if (!entry) return false;
  if (Date.now() - entry.ts < MNS_AREA_NEG_TTL) return true;
  mnsAreaNegCache.delete(key);
  return false;
}

function mnsAreaNegSet(z, x, y) {
  const key = mnsAreaNegKey(z, x, y);
  mnsAreaNegCache.set(key, { ts: Date.now() });
  // Evict if too large
  if (mnsAreaNegCache.size > 500) {
    const iter = mnsAreaNegCache.keys();
    for (let i = 0; i < 200; i++) {
      const k = iter.next().value;
      if (k !== undefined) mnsAreaNegCache.delete(k);
    }
  }
}

function postProcessFranceMnsTile(elevations, coverage, mercZ) {
  despikeElevations(elevations, coverage, DEM_TILE_SIZE);
  if (mercZ <= IGN_MNS_MIDZOOM_SMOOTH_MAXZOOM) {
    smoothSurfaceMicroUndulations(
      elevations,
      coverage,
      DEM_TILE_SIZE,
      IGN_MNS_MIDZOOM_SMOOTH_VARIANCE_M,
    );
  }
}

async function buildIGNTile(mercZ, mercX, mercY, tileClass) {
  const t0 = performance.now();
  const isBorder = tileClass === 'border';
  const demZ = Math.max(
    IGN_DEM_MINZOOM,
    Math.min(mercZ + IGN_MNS_SOURCE_ZOOM_BIAS, IGN_DEM_MAXZOOM),
  );

  // Fast skip: if this area is known to have no MNS data, return immediately
  // instead of enqueuing 6-9 sub-tile fetches that will all 404.
  if (mnsAreaNegGet(mercZ, mercX, mercY)) {
    return {
      blob: null, elevations: null, coverage: null,
      source: 'ign-empty-cached', allPermanent404: true, pendingFetches: null,
    };
  }

  const bounds = mercatorTileBounds(mercZ, mercX, mercY);
  const tl = lngLatToWGS84GTile(bounds.west, bounds.north, demZ);
  const br = lngLatToWGS84GTile(bounds.east, bounds.south, demZ);

  // Log source zoom remapping — useful when diagnosing why surface detail is
  // missing (too coarse demZ) or why a close view hits the max zoom clamp.
  if (demZ !== mercZ) {
    console.log(
      `[sw-dem][build] %c SOURCE ZOOM %c ${mercZ}/${mercX}/${mercY} — requested z${mercZ}, using demZ=${demZ} (Δ=${demZ - mercZ})`,
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
  //
  // Compute the absolute soft-deadline timestamp BEFORE launching fetches
  // so it can be passed into each `getIGNTileWithFallback` call. Without
  // this, a sub-tile that 404s at native zoom would hold an IGN slot for
  // up to IGN_FALLBACK_MAX_DEPTH × IGN_FETCH_TIMEOUT_MS ≈ 45 s while
  // sequentially probing z-1, z-2, z-3 — saturating the 40-slot queue and
  // producing the 17–71 s per-build wall-clock the user reported.
  const softDeadlineMs = typeof ignSoftDeadlineMs === 'function'
    ? ignSoftDeadlineMs(mercZ)
    : IGN_SUBTILE_SOFT_DEADLINE_MS;
  const deadlineAt = t0 + softDeadlineMs;

  const tileMap = new Map();
  const fetches = [];
  const keys = [];
  let fetchCount = 0;
  let settledCount = 0;
  let anySuccess = false;
  const allSettled = new Promise((resolveAll) => {
    // checkDone is invoked from EVERY sub-tile fetch resolution microtask.
    // We piggyback the deadline check on it instead of relying on a
    // standalone `setTimeout(softDeadlineMs)`: the macrotask `setTimeout`
    // gets starved for tens of seconds when 200+ fetches are resolving in
    // parallel (each microtask chain runs arrayBuffer → decodeBIL32 →
    // cache write), which is exactly when we need the deadline to fire.
    // checkDone runs in the same microtask graph as the fetch resolutions
    // so it ALWAYS gets scheduling parity with them.
    const checkDone = () => {
      if (settledCount >= fetchCount) { resolveAll(); return; }
      if (performance.now() >= deadlineAt) { resolveAll(); return; }
    };
    for (let row = tl.row; row <= br.row; row++) {
      for (let col = tl.col; col <= br.col; col++) {
        fetchCount++;
        const key = `${col}/${row}`;
        keys.push(key);
        tileMap.set(key, undefined); // placeholder — "pending"
        fetches.push(
          getIGNTileWithFallback(demZ, col, row, deadlineAt).then((result) => {
            tileMap.set(key, result);
            settledCount++;
            if (result && result.data) anySuccess = true;
            checkDone();
          }),
        );
      }
    }
    // Edge case: 0 sub-tiles (shouldn't happen but be safe)
    if (fetchCount === 0) resolveAll();
  });

  // Macrotask deadline fallback — fires the race resolver in the rare case
  // where the SW thread genuinely goes idle (no fetches arriving) AND we're
  // still past the deadline. Normally checkDone already fired this above.
  await Promise.race([
    allSettled,
    new Promise((resolve) => setTimeout(resolve, softDeadlineMs)),
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
  let ignOk = 0, ignFallback = 0, ignMissing = 0, ignPermanent404 = 0;
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
    // Return a structured result so the caller can:
    //   1. Schedule a background upgrade when pending sub-tile fetches settle
    //   2. Know whether all failures were permanent 404s (→ skip HIGHRES fallback faster)
    return {
      blob: null, elevations: null, coverage: null,
      source: 'ign-empty',
      allPermanent404: ignMissing === fetchCount && ignMissing > 0,
      pendingFetches,
    };
  }

  // Determine source label for diagnostics
  const source = usedFallback ? `ign-fallback-z${minFallbackZ}` : 'ign';

  // NOTE: the former "full-coverage fast path" that encoded the raw IGN
  // elevations directly (bypassing compositeIGNMapbox) has been removed.
  // Even on full-coverage tiles, neighbour tiles can be pure-Mapbox or
  // partial-composite, and encoding the raw bare-earth values without any
  // reference to the Mapbox datum produces C0-discontinuous meshes at every
  // IGN↔Mapbox seam. compositeIGNMapbox() now handles full-coverage inputs
  // via a fast ring-only offset-alignment path — see composite.js.
  if (coveredCount === totalPixels) {
    const dt = (performance.now() - t0).toFixed(1);
    let eMin = Infinity, eMax = -Infinity;
    for (let i = 0; i < totalPixels; i++) {
      if (elevations[i] < eMin) eMin = elevations[i];
      if (elevations[i] > eMax) eMax = elevations[i];
    }
    const eRange = eMax - eMin;
    if (DEBUG) {
      const rangeColor = eRange < 5 ? '#f44336' : eRange < 50 ? '#FF9800' : '#4CAF50';
      console.log(
        `[sw-dem][build] %c ${source} %c ${mercZ}/${mercX}/${mercY} — full coverage, elev=[${eMin.toFixed(1)}..${eMax.toFixed(1)}] range=${eRange.toFixed(1)}m, ${fetchCount} sub-tiles, ${dt}ms`,
        `background:${rangeColor};color:#fff;padding:2px 4px;border-radius:2px`, ''
      );
    }
    if (eRange < 5) {
      console.warn(
        `[sw-dem][build] %c ⚠ FLAT OUTPUT %c ${mercZ}/${mercX}/${mercY} — elevation range ${eRange.toFixed(1)}m → terrain will be flat! demZ=${demZ} mercZ=${mercZ}`,
        'background:#f44336;color:#fff;padding:2px 6px;border-radius:3px;font-weight:bold', ''
      );
    }
    postProcessFranceMnsTile(elevations, coverage, mercZ);
    // Return elevations without blob → composite.js applies the border-ring
    // offset alignment so the output mesh is watertight with neighbour tiles.
    return { blob: null, elevations, coverage, source, pendingFetches };
  }

  // --- Pre-fill uncovered pixels with Mapbox elevation ---
  // Prevents 0 m sea-level default from creating km-high vertical cliffs
  // anywhere IGN has NODATA holes (sensor gaps, water bodies, NaN pixels),
  // not only at France borders. Composite.js handles the smooth blend for
  // border tiles; this prefill is the raw-elevation safety net for the
  // *inside* path where the dilation stage would otherwise propagate 0 m.
  //
  // GUARD: at mercZ > MAPBOX_DEM_MAXZOOM (=14) any Mapbox tile we fetch is
  // server-side overzoomed — i.e. visually flat 30 m. Prefilling IGN holes
  // with that coarse data is exactly what the user described as "qualité
  // LiDAR qui disparaît quand je zoome in": even tiny sensor gaps in the
  // LiDAR HD grid got filled with 30 m Mapbox blur, turning crisp rock
  // detail into a smeared surface. At high zoom we rely solely on IGN
  // dilation below (cardinal + diagonal neighbours from LiDAR-covered
  // pixels), keeping the tile 100 % LiDAR-sourced.
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
    } catch {
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
    postProcessFranceMnsTile(elevations, coverage, mercZ);
    return { blob: await encodeTerrainRGBPng(elevations), elevations, coverage, source, pendingFetches };
  }

  const dt = (performance.now() - t0).toFixed(1);
  const covPct = (coveredCount / totalPixels * 100).toFixed(1);
  console.log(`[sw-dem][build] ${mercZ}/${mercX}/${mercY} — partial ${covPct}%, src=${source}, ${dilationPasses} passes, ${dt}ms`);
  postProcessFranceMnsTile(elevations, coverage, mercZ);
  return { blob: null, elevations, coverage, source, pendingFetches };
}

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

  const tileMap = new Map();
  const fetches = [];
  const keys = [];
  let fetchCount = 0;
  for (let row = tl.row; row <= br.row; row++) {
    for (let col = tl.col; col <= br.col; col++) {
      fetchCount++;
      const key = `${col}/${row}`;
      keys.push(key);
      tileMap.set(key, undefined);
      fetches.push(
        getHighresTileWithFallback(demZ, col, row).then((result) => {
          tileMap.set(key, result);
        }),
      );
    }
  }

  // Shorter deadline for HIGHRES — it's the fallback layer, so we want to
  // fail fast to Mapbox rather than block the viewport for 8 s.
  const softDeadlineMs = Math.min(3000, typeof ignSoftDeadlineMs === 'function'
    ? ignSoftDeadlineMs(mercZ) : IGN_SUBTILE_SOFT_DEADLINE_MS);
  await Promise.race([
    Promise.all(fetches),
    new Promise((resolve) => setTimeout(resolve, softDeadlineMs)),
  ]);

  let pendingCount = 0;
  for (const k of keys) {
    if (tileMap.get(k) === undefined) { tileMap.set(k, null); pendingCount++; }
  }
  const hasPending = pendingCount > 0;

  let hrOk = 0, hrMissing = 0;
  for (const [, result] of tileMap) {
    if (result && result.data) hrOk++;
    else hrMissing++;
  }
  if (hrMissing > 0 || DEBUG) {
    console.log(
      `[sw-dem][build-hr] %c HIGHRES %c ${mercZ}/${mercX}/${mercY} — ${fetchCount} sub-tiles: ok=${hrOk} missing=${hrMissing} (demZ=${demZ})`,
      'background:#9C27B0;color:#fff;padding:2px 4px;border-radius:2px', ''
    );
  }

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

      const matrixWidth = 1 << (demZ + 1);
      const matrixHeight = 1 << demZ;
      const col = Math.max(0, Math.min(Math.floor(((lng + 180) / 360) * matrixWidth), matrixWidth - 1));
      const row = Math.max(0, Math.min(Math.floor(((90 - lat) / 180) * matrixHeight), matrixHeight - 1));

      const result = tileMap.get(`${col}/${row}`);
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

  tileMap.clear();
  const pendingFetches = hasPending ? fetches : null;

  if (coveredCount === 0) {
    const dt = (performance.now() - t0).toFixed(1);
    console.log(`[sw-dem][build-hr] ${mercZ}/${mercX}/${mercY} — 0 HIGHRES coverage, ${dt}ms`);
    return null;
  }

  const source = 'ign-highres';

  // Full coverage fast path
  if (coveredCount === totalPixels) {
    const dt = (performance.now() - t0).toFixed(1);
    console.log(
      `[sw-dem][build-hr] %c ${source} %c ${mercZ}/${mercX}/${mercY} — full coverage, ${fetchCount} sub-tiles, ${dt}ms`,
      'background:#9C27B0;color:#fff;padding:2px 4px;border-radius:2px', ''
    );
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

  // Dilation
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
        if (py > 0 && px > 0 && coverage[idx - DEM_TILE_SIZE - 1]) { sum += elevations[idx - DEM_TILE_SIZE - 1]; count++; }
        if (py > 0 && px < DEM_TILE_SIZE - 1 && coverage[idx - DEM_TILE_SIZE + 1]) { sum += elevations[idx - DEM_TILE_SIZE + 1]; count++; }
        if (py < DEM_TILE_SIZE - 1 && px > 0 && coverage[idx + DEM_TILE_SIZE - 1]) { sum += elevations[idx + DEM_TILE_SIZE - 1]; count++; }
        if (py < DEM_TILE_SIZE - 1 && px < DEM_TILE_SIZE - 1 && coverage[idx + DEM_TILE_SIZE + 1]) { sum += elevations[idx + DEM_TILE_SIZE + 1]; count++; }
        if (count > 0) { newElevations[idx] = sum / count; newCoverage[idx] = 1; coveredCount++; }
      }
    }
    elevations.set(newElevations);
    coverage.set(newCoverage);
  }

  if (coveredCount >= totalPixels) {
    const dt = (performance.now() - t0).toFixed(1);
    console.log(`[sw-dem][build-hr] ${mercZ}/${mercX}/${mercY} — dilated to full, ${dt}ms`);
    despikeElevations(elevations, coverage, DEM_TILE_SIZE);
    return { blob: await encodeTerrainRGBPng(elevations), elevations, coverage, source, pendingFetches };
  }

  const dt = (performance.now() - t0).toFixed(1);
  const covPct = (coveredCount / totalPixels * 100).toFixed(1);
  console.log(`[sw-dem][build-hr] ${mercZ}/${mercX}/${mercY} — partial ${covPct}%, ${dt}ms`);
  despikeElevations(elevations, coverage, DEM_TILE_SIZE);
  return { blob: null, elevations, coverage, source, pendingFetches };
}

// ---------------------------------------------------------------------------
// Build direct RGE ALTI terrain tile from the official WMS endpoint.
// This is the verified bare-earth source used by slope calculations in
// `demProfile=terrain` mode. It returns a 256x256 BIL32 raster for the exact
// Mercator tile bbox, avoiding the WMTS z14 clamp of the legacy HIGHRES path.
// ---------------------------------------------------------------------------
async function buildIGNTerrainTile(mercZ, mercX, mercY, options) {
  const t0 = performance.now();
  const terrainPurpose = options?.purpose;
  const rawElevations = await getTerrainWmsTile(mercZ, mercX, mercY, terrainPurpose);
  if (!rawElevations || rawElevations.length !== DEM_TILE_SIZE * DEM_TILE_SIZE) {
    return null;
  }

  const totalPixels = DEM_TILE_SIZE * DEM_TILE_SIZE;
  const elevations = new Float32Array(totalPixels);
  const coverage = new Uint8Array(totalPixels);
  let coveredCount = 0;

  for (let i = 0; i < totalPixels; i++) {
    const value = rawElevations[i];
    if (!Number.isNaN(value) && value >= MIN_VALID_ELEVATION_M && value <= MAX_VALID_ELEVATION_M) {
      elevations[i] = value;
      coverage[i] = 1;
      coveredCount++;
    }
  }

  if (coveredCount === 0) {
    const dt = (performance.now() - t0).toFixed(1);
    console.log(`[sw-dem][build-terrain] ${mercZ}/${mercX}/${mercY} — 0 WMS coverage, ${dt}ms`);
    return null;
  }

  const source = 'ign-rgealti-wms';

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
    } catch {
      /* best-effort */
    }
  }

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

  const dt = (performance.now() - t0).toFixed(1);
  const covPct = (coveredCount / totalPixels * 100).toFixed(1);
  console.log(`[sw-dem][build-terrain] ${mercZ}/${mercX}/${mercY} — coverage ${covPct}%, ${dt}ms`);
  despikeElevations(elevations, coverage, DEM_TILE_SIZE);
  return { blob: null, elevations, coverage, source, pendingFetches: null };
}
