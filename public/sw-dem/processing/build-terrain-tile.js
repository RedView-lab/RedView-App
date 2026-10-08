// ---------------------------------------------------------------------------
// Construction directe de la tuile terrain RGE ALTI depuis le WMS officiel.
// C'est la source sol nu vérifiée qu'utilisent les calculs de pente en mode
// `demProfile=terrain`. Elle renvoie un raster BIL32 de 256x256 pour la bbox
// exacte de la tuile Mercator, sans le plafond z14 du WMTS de l'ancien chemin
// HIGHRES.
// ---------------------------------------------------------------------------
async function buildIGNTerrainTile(mercZ, mercX, mercY, options) {
  const t0 = performance.now();
  const terrainPurpose = options?.purpose;
  const mapTile = options?.mapTile || null;
  const rawElevations = await fetchIgnRasterThroughCancels(
    () => getTerrainWmsTile(mercZ, mercX, mercY, terrainPurpose, mapTile),
    terrainPurpose,
    mapTile,
  );
  if (rawElevations === IGN_FETCH_CANCELLED) return cancelledIgnBuild();
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
    if (typeof swLog !== 'undefined') {
      swLog.debug('build-terrain', `${mercZ}/${mercX}/${mercY} — 0 WMS coverage, ${dt}ms`);
    }
    return null;
  }

  const source = 'ign-rgealti-wms';

  if (coveredCount < totalPixels) {
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
    } catch {
      /* au mieux */
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
  if (typeof swLog !== 'undefined') {
    swLog.debug('build-terrain', `${mercZ}/${mercX}/${mercY} — coverage ${covPct}%, ${dt}ms`);
  }
  despikeElevations(elevations, coverage, DEM_TILE_SIZE);
  if (typeof smoothSurfaceMicroUndulations === 'function') {
    smoothSurfaceMicroUndulations(elevations, coverage, DEM_TILE_SIZE, 6);
  }
  return { blob: null, elevations, coverage, source, pendingFetches: null };
}
