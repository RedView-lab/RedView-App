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

  const usableCells = cellEntries.filter((c) => c.cog);
  console.log(
    `[swiss][build] %c ${mercZ}/${mercX}/${mercY} %c cells queried=${cellEntries.length} resolved-url=${cellEntries.filter(c=>c.url).length} cog-open=${usableCells.length} (E:${cells.EkmMin}-${cells.EkmMax} N:${cells.NkmMin}-${cells.NkmMax})`,
    'background:#D52B1E;color:#fff;padding:1px 4px;border-radius:2px', '',
  );
  if (usableCells.length === 0) {
    swissAreaNegSet(mercZ, mercX, mercY);
    console.warn(`[swiss][build] ${mercZ}/${mercX}/${mercY} \u2192 no usable COGs, marking area-neg`);
    return {
      blob: null, elevations: null, coverage: null,
      source: 'swiss-empty', allPermanentMissing: true, pendingFetches: null,
    };
  }

  // Build a quick LV95-bounds index so we pick the right COG per pixel
  // without a linear scan.
  // Cells are 1 km × 1 km aligned on integer km — the lookup is trivial.
  const cellByKey = new Map();
  for (const c of usableCells) cellByKey.set(`${c.Ekm}/${c.Nkm}`, c);

  // Step 2 — resample
  const totalPixels = DEM_TILE_SIZE * DEM_TILE_SIZE;
  const elevations = new Float32Array(totalPixels);
  const coverage = new Uint8Array(totalPixels);
  const n = 1 << mercZ;

  // Pre-pass: compute LV95 (E, N) for every output pixel. Convert in row-major
  // order; per-pixel reprojection is ~50 ns (closed-form polynomial).
  // We then group pixel sample requests by *internal COG tile* so we batch
  // tile-decompression rather than re-decompressing the same tile per pixel.
  //
  // pixelsByTile: Map<`${cellKey}#${tileIndex}`, Array<{ outIdx, E, N }>>
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
      const cell = cellByKey.get(`${Ekm}/${Nkm}`);
      if (!cell) { droppedOutside++; continue; }

      // Map pixel to internal COG tile of the chosen COG
      const cog = cell.cog;
      const ipx = (E - cog.originE) / cog.pixelScaleX;
      const ipy = (cog.originN - N) / cog.pixelScaleY;
      const x0 = Math.max(0, Math.min(Math.floor(ipx), cog.width - 1));
      const y0 = Math.max(0, Math.min(Math.floor(ipy), cog.height - 1));
      const tx = (x0 / cog.tileW) | 0;
      const ty = (y0 / cog.tileH) | 0;
      const tileIndex = ty * cog.tilesAcross + tx;
      const groupKey = `${cell.Ekm}/${cell.Nkm}#${tileIndex}`;
      let bucket = pixelsByTile.get(groupKey);
      if (!bucket) {
        bucket = { cell, tileIndex, pts: [] };
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

  // Bilinear sampling can require neighbours from adjacent internal tiles —
  // we always prefetch the 3×3 cluster around the bucket's tile to cover the
  // edge case. Adjacent buckets re-request the same tiles → cache dedup.
  const tilePrefetchSet = new Set();
  for (const { cell, tileIndex } of pixelsByTile.values()) {
    const cog = cell.cog;
    const tx = tileIndex % cog.tilesAcross;
    const ty = (tileIndex / cog.tilesAcross) | 0;
    for (let dy = -1; dy <= 1; dy++) {
      for (let dx = -1; dx <= 1; dx++) {
        const ntx = tx + dx, nty = ty + dy;
        if (ntx < 0 || nty < 0 || ntx >= cog.tilesAcross || nty >= cog.tilesDown) continue;
        tilePrefetchSet.add(`${cog.url}|${nty * cog.tilesAcross + ntx}`);
      }
    }
  }
  // Fan out tile fetches with Promise.all — they share swiss-fetcher's
  // concurrency limiter so this never exceeds SWISS_CONCURRENCY in flight.
  await Promise.all(Array.from(tilePrefetchSet).map((k) => {
    const sep = k.indexOf('|');
    const url = k.substring(0, sep);
    const tileIndex = parseInt(k.substring(sep + 1), 10);
    // Find a COG with this URL in usableCells
    const cog = usableCells.find((c) => c.cog.url === url)?.cog;
    if (!cog) return null;
    return getCOGInternalTile(cog, tileIndex);
  }));

  // Step 3 — sample every pixel (now using cached internal tiles)
  let coveredCount = 0;
  const samplers = [];
  for (const { cell, pts } of pixelsByTile.values()) {
    const cog = cell.cog;
    samplers.push((async () => {
      for (const { outIdx, E, N } of pts) {
        const v = await sampleSwissCOG(cog, E, N, (idx) => getCOGInternalTile(cog, idx));
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
    console.log(
      `[swiss][build] %c \u2713 swiss %c ${mercZ}/${mercX}/${mercY} \u2014 cov ${covPct}%, cells=${usableCells.length}, tiles=${pixelsByTile.size}, ${dt}ms`,
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
