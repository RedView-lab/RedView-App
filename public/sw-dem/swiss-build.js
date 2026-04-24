// ---------------------------------------------------------------------------
// Build a Mercator DEM tile from swissSURFACE3D Raster (COG-backed)
// ---------------------------------------------------------------------------
// Mirrors buildIGNTile() so handleDemRequest can dispatch France vs CH using
// the same downstream contract:
//   { blob, elevations, coverage, source, allPermanentMissing, pendingFetches }
//
// Strategy:
//   1. Resolve the LV95 km-cells overlapping this Mercator tile (a few cells).
//   2. For each cell, resolve its STAC item → COG URL (cached).
//   3. For each output pixel, project to LV95 → sample COG (bilinear).
//   4. Despike + return (composite.js will handle MNS↔MNT seam alignment vs
//      Mapbox Terrain-RGB the same way it does for IGN).
//
// All COG header parses + tile range fetches are cached, so the second
// Mercator tile in the same area reuses everything.
// ---------------------------------------------------------------------------

// Area-level negative cache — when every km-cell in a Mercator tile maps to
// "no published COG", every adjacent tile in the same area will yield the
// same outcome. Skip the per-pixel work.
const swissAreaNegCache = new Map();
const SWISS_AREA_NEG_TTL = 30 * 60_000; // 30 min

function swissAreaNegKey(z, x, y) {
  return `${z}/${x >> 1}/${y >> 1}`; // group 2×2 sibling tiles
}
function swissAreaNegGet(z, x, y) {
  const e = swissAreaNegCache.get(swissAreaNegKey(z, x, y));
  if (!e) return false;
  if (Date.now() - e.ts < SWISS_AREA_NEG_TTL) return true;
  swissAreaNegCache.delete(swissAreaNegKey(z, x, y));
  return false;
}
function swissAreaNegSet(z, x, y) {
  swissAreaNegCache.set(swissAreaNegKey(z, x, y), { ts: Date.now() });
  if (swissAreaNegCache.size > 500) {
    const iter = swissAreaNegCache.keys();
    for (let i = 0; i < 200; i++) {
      const k = iter.next().value;
      if (k !== undefined) swissAreaNegCache.delete(k);
    }
  }
}

async function buildSwissTile(mercZ, mercX, mercY) {
  const t0 = performance.now();

  if (swissAreaNegGet(mercZ, mercX, mercY)) {
    return {
      blob: null, elevations: null, coverage: null,
      source: 'swiss-empty-cached',
      allPermanentMissing: true, pendingFetches: null,
    };
  }

  // Step 1 — discover which COGs cover this tile
  const cells = mercTileToLV95KmCells(mercZ, mercX, mercY);
  if (!cells) {
    return {
      blob: null, elevations: null, coverage: null,
      source: 'swiss-outside', allPermanentMissing: true, pendingFetches: null,
    };
  }

  // Resolve all overlapping cells in parallel — one STAC query covers
  // many cells thanks to the windowed bbox lookup in getCOGUrlForCell().
  const cellEntries = []; // { Ekm, Nkm, url, cog }
  const stacPromises = [];
  for (let Ekm = cells.EkmMin; Ekm <= cells.EkmMax; Ekm++) {
    for (let Nkm = cells.NkmMin; Nkm <= cells.NkmMax; Nkm++) {
      const entry = { Ekm, Nkm, url: null, cog: null };
      cellEntries.push(entry);
      stacPromises.push(
        getCOGUrlForCell(Ekm, Nkm).then((url) => { entry.url = url; }),
      );
    }
  }
  await Promise.all(stacPromises);

  // Open headers in parallel for cells that resolved
  const headerPromises = cellEntries
    .filter((c) => c.url)
    .map((c) => openSwissCOG(c.url).then((cog) => { c.cog = cog; }));
  await Promise.all(headerPromises);

  const resolvedUrlCount = cellEntries.filter((c) => c.url).length;
  const usableCells = cellEntries.filter((c) => c.cog);
  console.log(
    `[swiss][build] %c ${mercZ}/${mercX}/${mercY} %c cells queried=${cellEntries.length} resolved-url=${resolvedUrlCount} cog-open=${usableCells.length} (E:${cells.EkmMin}-${cells.EkmMax} N:${cells.NkmMin}-${cells.NkmMax})`,
    'background:#D52B1E;color:#fff;padding:1px 4px;border-radius:2px', '',
  );
  if (usableCells.length === 0) {
    if (resolvedUrlCount === 0) {
      swissAreaNegSet(mercZ, mercX, mercY);
      console.warn(`[swiss][build] ${mercZ}/${mercX}/${mercY} \u2192 no COG URLs, marking area-neg`);
      return {
        blob: null, elevations: null, coverage: null,
        source: 'swiss-empty', allPermanentMissing: true, pendingFetches: null,
      };
    }
    console.warn(`[swiss][build] ${mercZ}/${mercX}/${mercY} \u2192 COG headers unavailable, keeping area live for retry`);
    return {
      blob: null, elevations: null, coverage: null,
      source: 'swiss-unavailable', allPermanentMissing: false, pendingFetches: null,
    };
  }

  // Build a quick LV95-bounds index so we pick the right COG per pixel
  // without a linear scan.
  // Cells are 1 km × 1 km aligned on integer km — the lookup is trivial.
  const cellByKey = new Map();
  for (const c of usableCells) cellByKey.set(`${c.Ekm}/${c.Nkm}`, c);

  const n = 1 << mercZ;

  // ── LOD pick: choose the coarsest pyramid level whose pixelScale still
  // matches the output resolution. Mirrors what we already do in France
  // with shouldUseIGN(): don't spend bandwidth pulling 0.5 m native data
  // when the rendered Mercator pixel is e.g. 8 m wide. swisstopo COGs ship
  // 4-5 overview IFDs (1 m, 2 m, 4 m, 8 m, 16 m) so most dezooms can be
  // served by a single overview tile per cell instead of dozens of native
  // tiles. The chosen level is consistent across all cells of a Mercator
  // tile (they share latitude → same mpp).
  const tileCenterLat = mercatorYToLat((mercY + 0.5) / n);
  const mppOut = (40075016.686 * Math.cos((tileCenterLat * Math.PI) / 180)) / (256 * n);
  // Aim for a source pixel ~half the output pixel so bilinear keeps detail.
  // Clamp to native (0.5 m) on the low end.
  const mppTarget = Math.max(0.5, mppOut * 0.6);
  // pickSwissCOGLevel is defined in swiss-cog.js; all cells share the same
  // pyramid layout (swisstopo COGs are uniform).
  const pickedLevels = new Map(); // cellKey → level descriptor
  for (const c of usableCells) {
    const lvlIdx = pickSwissCOGLevel(c.cog, mppTarget);
    pickedLevels.set(`${c.Ekm}/${c.Nkm}`, { idx: lvlIdx, level: c.cog.levels[lvlIdx] });
  }

  // Step 2 — resample
  const totalPixels = DEM_TILE_SIZE * DEM_TILE_SIZE;
  const elevations = new Float32Array(totalPixels);
  const coverage = new Uint8Array(totalPixels);

  // Pre-pass: compute LV95 (E, N) for every output pixel. Convert in row-major
  // order; per-pixel reprojection is ~50 ns (closed-form polynomial).
  // We then group pixel sample requests by *internal COG tile* so we batch
  // tile-decompression rather than re-decompressing the same tile per pixel.
  //
  // pixelsByTile: Map<`${cellKey}#L${levelIdx}#${tileIndex}`, { cell, levelIdx, level, tileIndex, pts }>
  const pixelsByTile = new Map();
  let droppedOutside = 0;

  for (let py = 0; py < DEM_TILE_SIZE; py++) {
    const yFrac = (mercY + (py + 0.5) / DEM_TILE_SIZE) / n;
    const lat = mercatorYToLat(yFrac);
    for (let px = 0; px < DEM_TILE_SIZE; px++) {
      const xFrac = (mercX + (px + 0.5) / DEM_TILE_SIZE) / n;
      const lng = xFrac * 360 - 180;
      const { E, N } = wgs84ToLV95(lng, lat);
      const Ekm = Math.floor(E / 1000);
      const Nkm = Math.floor(N / 1000);
      const cellKey = `${Ekm}/${Nkm}`;
      const cell = cellByKey.get(cellKey);
      if (!cell) { droppedOutside++; continue; }

      // Map pixel to internal COG tile of the chosen pyramid LEVEL
      const cog = cell.cog;
      const picked = pickedLevels.get(cellKey);
      const level = picked.level;
      const ipx = (E - cog.originE) / level.pixelScaleX;
      const ipy = (cog.originN - N) / level.pixelScaleY;
      const x0 = Math.max(0, Math.min(Math.floor(ipx), level.width - 1));
      const y0 = Math.max(0, Math.min(Math.floor(ipy), level.height - 1));
      const tx = (x0 / level.tileW) | 0;
      const ty = (y0 / level.tileH) | 0;
      const tileIndex = ty * level.tilesAcross + tx;
      const groupKey = `${cellKey}#L${picked.idx}#${tileIndex}`;
      let bucket = pixelsByTile.get(groupKey);
      if (!bucket) {
        bucket = { cell, levelIdx: picked.idx, level, tileIndex, pts: [] };
        pixelsByTile.set(groupKey, bucket);
      }
      bucket.pts.push({ outIdx: py * DEM_TILE_SIZE + px, E, N });
    }
  }

  if (pixelsByTile.size === 0) {
    swissAreaNegSet(mercZ, mercX, mercY);
    return {
      blob: null, elevations: null, coverage: null,
      source: 'swiss-empty', allPermanentMissing: true, pendingFetches: null,
    };
  }

  // Compute the EXACT set of internal tiles needed for bilinear sampling at
  // the chosen pyramid level. The bilinear sampler in sampleSwissCOG() only
  // ever reads pixels (x0,y0) (x0+1,y0) (x0,y1) (x0+1,y1).
  const tilePrefetchSet = new Set();
  for (const { cell, levelIdx, level, pts } of pixelsByTile.values()) {
    const cog = cell.cog;
    const tilesAcross = level.tilesAcross;
    const tileW = level.tileW;
    const tileH = level.tileH;
    const widthM1 = level.width - 1;
    const heightM1 = level.height - 1;
    for (const { E, N } of pts) {
      const ipxF = (E - cog.originE) / level.pixelScaleX;
      const ipyF = (cog.originN - N) / level.pixelScaleY;
      const x0 = Math.max(0, Math.min(Math.floor(ipxF), widthM1));
      const y0 = Math.max(0, Math.min(Math.floor(ipyF), heightM1));
      const x1 = Math.min(x0 + 1, widthM1);
      const y1 = Math.min(y0 + 1, heightM1);
      const tx0 = (x0 / tileW) | 0;
      const tx1 = (x1 / tileW) | 0;
      const ty0 = (y0 / tileH) | 0;
      const ty1 = (y1 / tileH) | 0;
      tilePrefetchSet.add(`${cog.url}|${levelIdx}|${ty0 * tilesAcross + tx0}`);
      if (tx1 !== tx0) tilePrefetchSet.add(`${cog.url}|${levelIdx}|${ty0 * tilesAcross + tx1}`);
      if (ty1 !== ty0) tilePrefetchSet.add(`${cog.url}|${levelIdx}|${ty1 * tilesAcross + tx0}`);
      if (tx1 !== tx0 && ty1 !== ty0) tilePrefetchSet.add(`${cog.url}|${levelIdx}|${ty1 * tilesAcross + tx1}`);
    }
  }
  // Fan out tile fetches with Promise.all — they share swiss-fetcher's
  // concurrency limiter so this never exceeds SWISS_CONCURRENCY in flight.
  const prefetchCount = tilePrefetchSet.size;
  await Promise.all(Array.from(tilePrefetchSet).map((k) => {
    const parts = k.split('|');
    const url = parts[0];
    const levelIdx = parseInt(parts[1], 10);
    const tileIndex = parseInt(parts[2], 10);
    const cog = usableCells.find((c) => c.cog.url === url)?.cog;
    if (!cog) return null;
    return getCOGInternalTile(cog, levelIdx, tileIndex);
  }));

  // Step 3 — sample every pixel (now using cached internal tiles)
  let coveredCount = 0;
  const samplers = [];
  for (const { cell, levelIdx, pts } of pixelsByTile.values()) {
    const cog = cell.cog;
    samplers.push((async () => {
      for (const { outIdx, E, N } of pts) {
        const v = await sampleSwissCOG(cog, levelIdx, E, N, (lvl, idx) => getCOGInternalTile(cog, lvl, idx));
        if (Number.isFinite(v)) {
          elevations[outIdx] = v;
          coverage[outIdx] = 1;
          coveredCount++;
        }
      }
    })());
  }
  await Promise.all(samplers);

  if (coveredCount === 0) {
    swissAreaNegSet(mercZ, mercX, mercY);
    console.warn(
      `[swiss][build] ${mercZ}/${mercX}/${mercY} \u2192 0 covered px (cells=${usableCells.length} tiles=${pixelsByTile.size} dropped=${droppedOutside}) ${(performance.now() - t0).toFixed(0)}ms`,
    );
    return {
      blob: null, elevations: null, coverage: null,
      source: 'swiss-empty', allPermanentMissing: true, pendingFetches: null,
    };
  }

  // Despike LiDAR hot pixels (vegetation tops, scanner artefacts)
  despikeElevations(elevations, coverage, DEM_TILE_SIZE);

  {
    const dt = (performance.now() - t0).toFixed(0);
    const covPct = (coveredCount / totalPixels * 100).toFixed(1);
    // Summarise picked levels for diagnostics
    const lvlSet = new Set();
    for (const v of pickedLevels.values()) lvlSet.add(v.idx);
    const lvlSummary = Array.from(lvlSet).sort().map((i) => `L${i}@${usableCells[0].cog.levels[i].pixelScaleX.toFixed(1)}m`).join(',');
    console.log(
      `[swiss][build] %c \u2713 swiss %c ${mercZ}/${mercX}/${mercY} \u2014 cov ${covPct}%, cells=${usableCells.length}, tiles=${pixelsByTile.size}, prefetched=${prefetchCount}, levels=${lvlSummary} (out=${mppOut.toFixed(1)}m), ${dt}ms`,
      'background:#4CAF50;color:#fff;padding:2px 4px;border-radius:2px', '',
    );
  }

  // Source label encodes the dominant year for diagnostics. We don't
  // attempt to do partial-coverage Mapbox prefill here — composite.js
  // already handles the MNS↔Mapbox blend via the shared partial-coverage
  // path used by IGN. coverage[] tells it which pixels are real.
  return {
    blob: null,
    elevations,
    coverage,
    source: 'swiss',
    allPermanentMissing: false,
    pendingFetches: null,
  };
}
