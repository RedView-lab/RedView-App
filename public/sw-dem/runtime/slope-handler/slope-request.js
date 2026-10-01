// ---------------------------------------------------------------------------
// Slope Tile Processing — HTTP Request Handler (/slope-tiles/{z}/{x}/{y})
//
// Terrain-aligned tiles (no zone): the page requests exactly the tiles of the
// 3D terrain's DEM pyramid (slope-source.ts), so slope tile z/x/y is Horn on
// DEM tile z/x/y — the tile the terrain mesh shows — stitched to its four
// neighbours and upsampled 2×. Requests are never cancelled by a gesture:
// the work is bounded by the DEM the terrain needs anyway, and a cancelled
// request used to answer a transparent placeholder that Mapbox kept as the
// final tile (holes in the overlay until a reload).
// ---------------------------------------------------------------------------

function provisionalSlopeResponse(blob, quality, demProfile) {
  return new Response(blob, {
    status: 200,
    headers: {
      'Content-Type': 'image/png',
      'Cache-Control': 'no-cache',
      'X-Tile-Type': 'slope',
      'X-Slope-Quality': quality,
      'X-Slope-Seam': 'provisional',
      'X-DEM-Profile': demProfile,
    },
  });
}

// options.sourceDem          'hd' | 'fast-30m' (legacy '' = HD without coverage check)
// options.noAncestorFallback internal: no parent-slope fallback (recursion guard)
async function handleSlopeRequest(z, x, y, resParam, demProfile = 'default', zoneHash = '', options = {}) {
  const resFactor = (() => {
    const n = parseInt(resParam, 10);
    return Number.isFinite(n) && n > 1 ? Math.min(n, 64) : 1;
  })();
  const sourceDem = options?.sourceDem || (demProfile === 'fast-30m' ? 'fast-30m' : '');

  // ── HD requested outside every high-resolution DEM footprint ─────────
  // Italy, Germany, Belgium… only have the global AWS 30 m DEM. Serve
  // exactly what the 30 m mode serves (shared cache entries), with z>13
  // tiles upsampled from the native z13 slope.
  if (sourceDem === 'hd' && !zoneHash && !(await slopeTileHasHdCoverage(z, x, y))) {
    return handleSlopeRequest(z, x, y, resParam, 'default', '', { ...options, sourceDem: 'fast-30m' });
  }

  const slopeCache = await caches.open(SLOPE_CACHE_NAME);
  const params = new URLSearchParams();
  if (resFactor > 1) params.set('res', String(resFactor));
  if (demProfile === 'terrain') params.set('rv-dem-profile', 'terrain');
  if (sourceDem) params.set('source-dem', sourceDem);
  if (zoneHash) params.set('zone', zoneHash);
  const cacheKeyUrl = `/slope-tiles/${z}/${x}/${y}${params.size ? `?${params.toString()}` : ''}`;
  const hotKey = `${sourceDem ? `${sourceDem}:` : ''}${demProfile}:${cacheKeyUrl}`;

  // ── Hot tier (SLOPE_HOT_CACHE) ──────────────────────────────────────
  const hot = (typeof slopeHotGet === 'function') ? slopeHotGet(hotKey) : null;
  if (hot) {
    return slopeHotResponse(hot);
  }

  const cacheKey = new Request(cacheKeyUrl);
  const cached = await slopeCache.match(cacheKey);
  if (cached) {
    try {
      if (typeof slopeHotPut === 'function') {
        slopeHotPut(hotKey, await cached.clone().blob(), Array.from(cached.headers.entries()));
      }
    } catch { /* ignore */ }
    return cached;
  }

  // ── Analysis-zone early rejection ───────────────────────────────────
  const { entry: zoneEntry, ring: zoneRing } = resolveAnalysisZoneForTile(zoneHash);
  if (zoneHash) {
    if (!zoneEntry || !tileIntersectsAnalysisZone(zoneEntry, z, x, y)) {
      return transparentTileResponse();
    }
  }

  // ── In-flight coalescing ────────────────────────────────────────────
  const inflightKey = `${sourceDem ? `${sourceDem}:` : ''}${demProfile}:${z}/${x}/${y}?${resFactor}${zoneHash ? `&z=${zoneHash}` : ''}`;
  const existing = SLOPE_INFLIGHT.get(inflightKey);
  if (existing) {
    try { return (await existing).clone(); }
    catch { /* fall through and recompute */ }
  }

  // Zone tiles keep the z14 pipeline's native resolution and its own reload
  // messages; terrain-aligned tiles report every provisional answer.
  const outputScale = zoneHash ? 1 : SLOPE_OUTPUT_SCALE;
  const is30m = sourceDem === 'fast-30m' || sourceDem === '30m' || demProfile === 'fast-30m';
  // A provisional tile is rebuilt when the DEM tiles it lacks land (HD), or
  // by a capped blind retry (30 m: AWS neighbours are fetched inline, so a
  // miss there is a network failure, not a tile still to come).
  const reloadWhenReady = (pendingDemTiles) => {
    if (zoneHash) return;
    if (is30m || pendingDemTiles.length === 0) {
      noteSlopeTileStale(hotKey);
      return;
    }
    waitSlopeTileOnDem(hotKey, demProfile, z, pendingDemTiles);
  };

  const work = (async () => {
    // Native zoom caps (slope-source.ts resolveSlopeMaxZoom): 30 m stops at
    // z13 (AWS z14 is server-upsampled), HD at z16.
    const maxAllowedZ = is30m ? GLOBAL_SLOPE_NATIVE_MAX_Z : HD_SLOPE_MAX_Z;
    if (z > maxAllowedZ) {
      if (is30m && !zoneHash && z <= HD_SLOPE_MAX_Z) {
        return buildUpsampledGlobalSlopeResponse(z, x, y, resParam, cacheKey, hotKey, slopeCache);
      }
      return transparentTileResponse();
    }

    const demCache = await caches.open(CACHE_NAME);
    const demResponse = await getExistingTerrainDemResponse(z, x, y, demProfile, demCache, sourceDem);
    const ownDemSource = (demResponse?.headers.get('X-DEM-Source') || '').toLowerCase();

    // ── No DEM tile, or only a parent overzoom of one ─────────────────
    // The terrain renders its parent mesh there: show the parent's slope
    // (cropped + upsampled) rather than a hole, and never run Horn on a
    // Catmull-Rom overzoomed DEM (ripples). Provisional until the real DEM.
    if (!demResponse || demResponse.status !== 200 || ownDemSource.startsWith('overzoom')) {
      if (!zoneHash) {
        // Capped blind retry (a 204 may be transient) + rebuild as soon as
        // a background upgrade commits the real tile.
        noteSlopeTileStale(hotKey);
        if (!is30m) waitSlopeTileOnDem(hotKey, demProfile, z, [[x, y]]);
      }
      if (!zoneHash && !options.noAncestorFallback) {
        const blob = await buildSlopeFromAncestorDem(
          z, x, y, resParam, demProfile, sourceDem, demCache, DEM_TILE_SIZE * outputScale,
        );
        if (blob) return provisionalSlopeResponse(blob, 'ancestor', demProfile);
      }
      return transparentTileResponse();
    }

    // Neighbours are only stitched when they come from the same DEM class
    // as this tile (AWS 30 m vs high-resolution national DEM).
    const ownSourceClass = slopeDemSourceClass(ownDemSource);
    // Emergency / short-TTL DEM is a stand-in for a tile still being built:
    // serve the slope, but never lock it into a cache tier.
    const ownDemIsFinal = (demResponse.headers.get('X-DEM-Health') || 'ok').toLowerCase() === 'ok'
      && !demResponse.headers.get('x-cache-ttl-ms')
      && !/parent|overzoom|emergency/.test(ownDemSource);

    try {
      const demBlob = await demResponse.blob();
      const slopeResult = await buildSlopeBlobFromDem(
        demBlob, z, x, y, demCache, resFactor, demProfile, null, zoneRing, sourceDem, ownSourceClass, outputScale,
      );
      if (!slopeResult?.blob) {
        reloadWhenReady([]);
        return transparentTileResponse();
      }

      const pendingDemTiles = [...slopeResult.missingNeighbours, ...slopeResult.standInNeighbours];
      if (!ownDemIsFinal) pendingDemTiles.push([x, y]);
      const isSeamComplete = slopeResult.missingNeighbours.length === 0;
      const isPersistable = pendingDemTiles.length === 0;
      const response = new Response(slopeResult.blob, {
        status: 200,
        headers: {
          'Content-Type': 'image/png',
          'Cache-Control': isPersistable ? 'public, max-age=604800' : 'no-cache',
          'X-Tile-Type': 'slope',
          'X-Slope-Quality': 'hd',
          'X-Slope-Seam': isSeamComplete ? 'complete' : 'provisional',
          'X-DEM-Profile': demProfile,
        },
      });

      // Only final tiles enter CacheStorage and the hot tier: a provisional
      // hot entry would be served back instead of the rebuild.
      if (isPersistable) {
        slopeCache.put(cacheKey, response.clone());
        try {
          if (typeof slopeHotPut === 'function') {
            slopeHotPut(hotKey, slopeResult.blob, Array.from(response.headers.entries()));
          }
        } catch { /* ignore */ }
        if (!zoneHash) noteSlopeTileFinal(hotKey);
      } else {
        reloadWhenReady(pendingDemTiles);
      }
      return response;
    } catch (err) {
      console.error('[slope]', z, x, y, err);
      reloadWhenReady([]);
      return transparentTileResponse();
    }
  })();

  SLOPE_INFLIGHT.set(inflightKey, work);
  try {
    const response = await work;
    return response.clone();
  } finally {
    if (SLOPE_INFLIGHT.get(inflightKey) === work) {
      SLOPE_INFLIGHT.delete(inflightKey);
    }
  }
}
