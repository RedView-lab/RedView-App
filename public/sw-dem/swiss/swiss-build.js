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
  // Pipeline: kick off the COG header fetch as soon as a URL resolves,
  // instead of waiting for the slowest STAC query before any header
  // request is issued. Saves ~1 RTT per Mercator tile in the cold case.
  const cellEntries = []; // { Ekm, Nkm, url, cog, stacTransient }
  const cellReady = []; // promises that resolve once {url, cog?} are filled
  for (let Ekm = cells.EkmMin; Ekm <= cells.EkmMax; Ekm++) {
    for (let Nkm = cells.NkmMin; Nkm <= cells.NkmMax; Nkm++) {
      const entry = { Ekm, Nkm, url: null, cog: null, stacTransient: false };
      cellEntries.push(entry);
      cellReady.push(
        getCOGUrlForCell(Ekm, Nkm).then(async (url) => {
          if (url === SWISS_STAC_TRANSIENT) {
            entry.stacTransient = true;
            return;
          }
          entry.url = url;
          if (url) {
            entry.cog = await openSwissCOG(url);
          }
        }),
      );
    }
  }
  await Promise.all(cellReady);
  const stacHadTransientFailure = cellEntries.some((c) => c.stacTransient);

  const resolvedUrlCount = cellEntries.filter((c) => c.url).length;
  const usableCells = cellEntries.filter((c) => c.cog);
  console.log(
    `[swiss][build] %c ${mercZ}/${mercX}/${mercY} %c cells queried=${cellEntries.length} resolved-url=${resolvedUrlCount} cog-open=${usableCells.length} stac-transient=${stacHadTransientFailure} (E:${cells.EkmMin}-${cells.EkmMax} N:${cells.NkmMin}-${cells.NkmMax})`,
    'background:#D52B1E;color:#fff;padding:1px 4px;border-radius:2px', '',
  );
  if (usableCells.length === 0) {
    // Critical: only mark area-neg when STAC SUCCEEDED with zero data
    // (catalogue truly says no published COG here). When STAC failed
    // transiently we'd otherwise blackout a 2×2 Mercator block for 30
    // min from a single timeout → visible as flat tiles next to raised
    // Swiss LiDAR neighbours.
    if (resolvedUrlCount === 0 && !stacHadTransientFailure) {
      swissAreaNegSet(mercZ, mercX, mercY);
      console.warn(`[swiss][build] ${mercZ}/${mercX}/${mercY} \u2192 STAC OK with 0 cells, marking area-neg`);
      return {
        blob: null, elevations: null, coverage: null,
        source: 'swiss-empty', allPermanentMissing: true, pendingFetches: null,
      };
    }
    if (stacHadTransientFailure) {
      console.warn(`[swiss][build] ${mercZ}/${mercX}/${mercY} \u2192 STAC transient failure, keeping area live for retry`);
    } else {
      console.warn(`[swiss][build] ${mercZ}/${mercX}/${mercY} \u2192 COG headers unavailable, keeping area live for retry`);
    }
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
  // url → cog index so the prefetch grouping / snapshot avoids O(cells) finds.
  const cogByUrl = new Map();
  for (const c of usableCells) cogByUrl.set(c.cog.url, c.cog);

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

  // ── Single 256×256 pre-pass. For every output pixel: reproject to LV95,
  // assign it to its COG cell + chosen pyramid level, bucket it by primary
  // internal tile (so the sampler iterates locally), AND accumulate the exact
  // set of internal tiles the bilinear sampler will read — all in one sweep.
  // The previous code ran TWO full-resolution loops (one to bucket, one to
  // recompute the bilinear corner tiles); merging them halves the per-pixel
  // CPU and avoids a redundant reprojection-free recompute.
  //
  // pixelsByTile: Map<groupKey, { cog, levelIdx, pts:[{outIdx,E,N}] }>
  // tilePrefetchSet: Set<`${url}|${levelIdx}|${tileIndex}`>
  const pixelsByTile = new Map();
  const tilePrefetchSet = new Set();
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

      const cog = cell.cog;
      const picked = pickedLevels.get(cellKey);
      const level = picked.level;
      const lvl = picked.idx;
      const tileW = level.tileW;
      const tileH = level.tileH;
      const across = level.tilesAcross;
      const widthM1 = level.width - 1;
      const heightM1 = level.height - 1;

      // Bilinear footprint of this pixel at the chosen pyramid level.
      const ipx = (E - cog.originE) / level.pixelScaleX;
      const ipy = (cog.originN - N) / level.pixelScaleY;
      const x0 = Math.max(0, Math.min(Math.floor(ipx), widthM1));
      const y0 = Math.max(0, Math.min(Math.floor(ipy), heightM1));
      const x1 = Math.min(x0 + 1, widthM1);
      const y1 = Math.min(y0 + 1, heightM1);
      const tx0 = (x0 / tileW) | 0;
      const tx1 = (x1 / tileW) | 0;
      const ty0 = (y0 / tileH) | 0;
      const ty1 = (y1 / tileH) | 0;
      const primaryTile = ty0 * across + tx0;

      const groupKey = `${cellKey}#L${lvl}#${primaryTile}`;
      let bucket = pixelsByTile.get(groupKey);
      if (!bucket) {
        bucket = { cog, levelIdx: lvl, pts: [] };
        pixelsByTile.set(groupKey, bucket);
      }
      bucket.pts.push({ outIdx: py * DEM_TILE_SIZE + px, E, N });

      // Exact internal tiles the bilinear sampler reads: (x0,y0)(x1,y0)
      // (x0,y1)(x1,y1). Most interior pixels resolve to a single tile.
      const url = cog.url;
      tilePrefetchSet.add(`${url}|${lvl}|${primaryTile}`);
      if (tx1 !== tx0) tilePrefetchSet.add(`${url}|${lvl}|${ty0 * across + tx1}`);
      if (ty1 !== ty0) tilePrefetchSet.add(`${url}|${lvl}|${ty1 * across + tx0}`);
      if (tx1 !== tx0 && ty1 !== ty0) tilePrefetchSet.add(`${url}|${lvl}|${ty1 * across + tx1}`);
    }
  }

  if (pixelsByTile.size === 0) {
    // Same logic as above: if STAC was transient we may have missed the
    // cells covering this tile — don't poison.
    if (!stacHadTransientFailure) swissAreaNegSet(mercZ, mercX, mercY);
    return {
      blob: null, elevations: null, coverage: null,
      source: stacHadTransientFailure ? 'swiss-unavailable' : 'swiss-empty',
      allPermanentMissing: !stacHadTransientFailure,
      pendingFetches: null,
    };
  }

  // Step 2b — coalesced range prefetch. Group the needed internal tiles per
  // (COG, level) and let swiss-fetcher merge contiguous byte ranges into a
  // single HTTP request each (swisstopo stores a level's tiles contiguously,
  // so most multi-tile cells collapse to ONE fetch instead of N). All fetches
  // share the SWISS_CONCURRENCY limiter so this never floods the queue.
  const prefetchByCog = new Map(); // `${url}|${lvl}` → { cog, levelIdx, tiles:[] }
  for (const k of tilePrefetchSet) {
    const bar1 = k.indexOf('|');
    const bar2 = k.indexOf('|', bar1 + 1);
    const url = k.slice(0, bar1);
    const lvl = parseInt(k.slice(bar1 + 1, bar2), 10);
    const tileIndex = parseInt(k.slice(bar2 + 1), 10);
    const gk = `${url}|${lvl}`;
    let g = prefetchByCog.get(gk);
    if (!g) {
      const cog = cogByUrl.get(url);
      if (!cog) continue;
      g = { cog, levelIdx: lvl, tiles: [] };
      prefetchByCog.set(gk, g);
    }
    g.tiles.push(tileIndex);
  }
  const prefetchCount = tilePrefetchSet.size;
  await Promise.all(
    Array.from(prefetchByCog.values()).map((g) =>
      prefetchCOGTilesCoalesced(g.cog, g.levelIdx, g.tiles),
    ),
  );

  // Snapshot the decoded tiles into a local map (strong references) so that
  // LRU eviction triggered by concurrent Mercator-tile builds cannot drop a
  // tile out from under the synchronous sampler mid-pass.
  const tileMap = new Map(); // `${url}#L${lvl}#${tileIndex}` → Float32Array
  for (const k of tilePrefetchSet) {
    const bar1 = k.indexOf('|');
    const bar2 = k.indexOf('|', bar1 + 1);
    const url = k.slice(0, bar1);
    const lvl = parseInt(k.slice(bar1 + 1, bar2), 10);
    const tileIndex = parseInt(k.slice(bar2 + 1), 10);
    const cog = cogByUrl.get(url);
    if (!cog) continue;
    const t = getCOGInternalTileCached(cog, lvl, tileIndex);
    if (t) tileMap.set(`${url}#L${lvl}#${tileIndex}`, t);
  }
  const getTileSync = (cog, levelIdx, tileIndex) =>
    tileMap.get(`${cog.url}#L${levelIdx}#${tileIndex}`) || null;

  // Step 3 — sample every pixel SYNCHRONOUSLY from the decoded tiles. The old
  // path awaited 4 cache lookups per pixel (~260 k microtasks per tile); this
  // reads straight from the Float32Arrays and is an order of magnitude faster.
  let coveredCount = 0;
  for (const { cog, levelIdx, pts } of pixelsByTile.values()) {
    for (const { outIdx, E, N } of pts) {
      const v = sampleSwissCOGSync(cog, levelIdx, E, N, getTileSync);
      if (Number.isFinite(v)) {
        elevations[outIdx] = v;
        coverage[outIdx] = 1;
        coveredCount++;
      }
    }
  }

  if (coveredCount === 0) {
    // 0 covered pixels can also be a symptom of range-fetch timeouts
    // (no decoded internal tiles → sampleSwissCOG returns NaN). Don't
    // permanently poison a 2×2 block from a transient AWS hiccup.
    const rangeLikelyTransient = prefetchCount > 0; // we tried but got nothing
    if (!stacHadTransientFailure && !rangeLikelyTransient) {
      swissAreaNegSet(mercZ, mercX, mercY);
    }
    console.warn(
      `[swiss][build] ${mercZ}/${mercX}/${mercY} \u2192 0 covered px (cells=${usableCells.length} tiles=${pixelsByTile.size} dropped=${droppedOutside} stacTransient=${stacHadTransientFailure} prefetch=${prefetchCount}) ${(performance.now() - t0).toFixed(0)}ms`,
    );
    return {
      blob: null, elevations: null, coverage: null,
      source: (stacHadTransientFailure || rangeLikelyTransient) ? 'swiss-unavailable' : 'swiss-empty',
      allPermanentMissing: !(stacHadTransientFailure || rangeLikelyTransient),
      pendingFetches: null,
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
