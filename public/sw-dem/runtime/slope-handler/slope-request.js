// ---------------------------------------------------------------------------
// Slope Tile Processing — HTTP Request Handler (/slope-tiles/{z}/{x}/{y})
// ---------------------------------------------------------------------------

async function handleSlopeRequest(z, x, y, resParam, demProfile = 'default', zoneHash = '', options = {}) {
  const slopeCache = await caches.open(SLOPE_CACHE_NAME);
  const resFactor = (() => {
    const n = parseInt(resParam, 10);
    return Number.isFinite(n) && n > 1 ? Math.min(n, 64) : 1;
  })();
  const sourceDem = options?.sourceDem || (demProfile === 'fast-30m' ? 'fast-30m' : '');
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

  // ── Standard 3D-Linked Slope: Uses the EXACT SAME 3D DEM tile as the 3D terrain mesh ──
  const generation = zoneHash ? null : slopeCancelGeneration;
  const work = (async () => {
    const demCache = await caches.open(CACHE_NAME);

    // 1. Get existing DEM tile from the 3D terrain cache / in-flight requests (NEVER download DEM for slope)
    const demResponse = await getExistingTerrainDemResponse(z, x, y, demProfile, demCache);

    if (isSlopeWorkCancelled(generation) || !demResponse || demResponse.status !== 200) {
      return transparentTileResponse();
    }

    try {
      const demBlob = await demResponse.clone().blob();
      if (isSlopeWorkCancelled(generation)) {
        return transparentTileResponse();
      }

      const slopeResult = await buildSlopeBlobFromDem(demBlob, z, x, y, demCache, resFactor, demProfile, generation, zoneRing);
      if (!slopeResult || !slopeResult.blob || isSlopeWorkCancelled(generation)) {
        return transparentTileResponse();
      }

      const slopeBlob = slopeResult.blob;
      const response = new Response(slopeBlob, {
        status: 200,
        headers: {
          'Content-Type': 'image/png',
          'Cache-Control': 'public, max-age=604800',
          'X-Tile-Type': 'slope',
          'X-Slope-Quality': 'hd',
          'X-DEM-Profile': demProfile,
        },
      });

      if (!isSlopeWorkCancelled(generation)) {
        slopeCache.put(cacheKey, response.clone());
        try {
          if (typeof slopeHotPut === 'function') {
            slopeHotPut(hotKey, slopeBlob, Array.from(response.headers.entries()));
          }
        } catch { /* ignore */ }
      }

      return response;
    } catch (err) {
      console.error('[slope]', z, x, y, err);
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
