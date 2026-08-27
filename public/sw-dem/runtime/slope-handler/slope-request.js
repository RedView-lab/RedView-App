// ---------------------------------------------------------------------------
// Slope Tile Processing — HTTP Request Handler (/slope-tiles/{z}/{x}/{y})
// ---------------------------------------------------------------------------

async function handleSlopeRequest(z, x, y, resParam, demProfile = 'default', zoneHash = '', options = {}) {
  const slopeCache = await caches.open(SLOPE_CACHE_NAME);
  const resFactor = (() => {
    const n = parseInt(resParam, 10);
    return Number.isFinite(n) && n > 1 ? Math.min(n, 64) : 1;
  })();
  const params = new URLSearchParams();
  if (resFactor > 1) params.set('res', String(resFactor));
  if (demProfile === 'terrain') params.set('rv-dem-profile', 'terrain');
  if (zoneHash) params.set('zone', zoneHash);
  const cacheKeyUrl = `/slope-tiles/${z}/${x}/${y}${params.size ? `?${params.toString()}` : ''}`;
  const hotKey = `${demProfile}:${cacheKeyUrl}`;

  // ── Analysis Zone in-progress (Phase 1 / Phase 2): Serve uniform 30m preview ──
  if (zoneHash) {
    const zState = zoneStateMap.get(zoneHash);
    const isZoneDone = zState?.phase === 'done';
    if (!isZoneDone) {
      const { entry: zoneEntry } = resolveAnalysisZoneForTile(zoneHash);
      if (!zoneEntry || !tileIntersectsAnalysisZone(zoneEntry, z, x, y)) {
        return transparentTileResponse();
      }
      const previewKey = `${zoneHash}:${demProfile}:${z}/${x}/${y}`;
      if (zonePreviewMap.has(previewKey)) {
        const blob = zonePreviewMap.get(previewKey);
        return new Response(blob, {
          status: 200,
          headers: {
            'Content-Type': 'image/png',
            'Cache-Control': 'public, max-age=15',
            'X-Tile-Type': 'slope',
            'X-Slope-Quality': 'low',
            'X-DEM-Profile': demProfile,
          },
        });
      }
      const lowResp = await buildAndCacheLowSlopeTile(z, x, y, resFactor, demProfile, zoneHash);
      if (lowResp) return lowResp;
      return transparentTileResponse();
    }
  }

  // ── Hot tier (SLOPE_HOT_CACHE) ──────────────────────────────────────
  const hot = (typeof slopeHotGet === 'function') ? slopeHotGet(hotKey) : null;
  if (hot) {
    return slopeHotResponse(hot);
  }

  const cacheKey = new Request(cacheKeyUrl);
  const cached = await slopeCache.match(cacheKey);
  if (cached) {
    const quality = (cached.headers.get('X-Slope-Quality') || '').toLowerCase();
    if (quality === 'hd' || !quality || zoneHash) {
      try {
        if (typeof slopeHotPut === 'function') {
          slopeHotPut(hotKey, await cached.clone().blob(), Array.from(cached.headers.entries()));
        }
      } catch { /* ignore */ }
      return cached;
    }
    // Low quality 30m cached tile (outside zone): serve immediately and trigger HD upgrade in background
    if (!options?.skipAutoHd) {
      buildAndCacheHdSlopeTile(z, x, y, resFactor, demProfile, zoneHash);
    }
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
  const inflightKey = `${demProfile}:${z}/${x}/${y}?${resFactor}${zoneHash ? `&z=${zoneHash}` : ''}`;
  const existing = SLOPE_INFLIGHT.get(inflightKey);
  if (existing) {
    try { return (await existing).clone(); }
    catch { /* fall through and recompute */ }
  }

  // ── Zoom-Invariant Resolution for Analysis Zones (z < 14) ────────────
  if (z < 14 && zoneHash) {
    const downsampledWork = buildDownsampledSlopeTile(z, x, y, resFactor, demProfile, zoneHash)
      .then(async (resp) => {
        if (resp && resp.status === 200) {
          slopeCache.put(cacheKey, resp.clone());
          try {
            if (typeof slopeHotPut === 'function') {
              slopeHotPut(hotKey, await resp.clone().blob(), Array.from(resp.headers.entries()));
            }
          } catch { /* ignore */ }
        }
        return resp;
      });
    SLOPE_INFLIGHT.set(inflightKey, downsampledWork);
    try {
      const response = await downsampledWork;
      return response.clone();
    } finally {
      if (SLOPE_INFLIGHT.get(inflightKey) === downsampledWork) {
        SLOPE_INFLIGHT.delete(inflightKey);
      }
    }
  }

  // ── Overzoomed Resolution for Analysis Zones (z > 14) ────────────
  if (z > 14 && zoneHash) {
    const overzoomedWork = buildOverzoomedSlopeTile(z, x, y, resFactor, demProfile, zoneHash)
      .then(async (resp) => {
        if (resp && resp.status === 200) {
          slopeCache.put(cacheKey, resp.clone());
          try {
            if (typeof slopeHotPut === 'function') {
              slopeHotPut(hotKey, await resp.clone().blob(), Array.from(resp.headers.entries()));
            }
          } catch { /* ignore */ }
        }
        return resp;
      });
    SLOPE_INFLIGHT.set(inflightKey, overzoomedWork);
    try {
      const response = await overzoomedWork;
      return response.clone();
    } finally {
      if (SLOPE_INFLIGHT.get(inflightKey) === overzoomedWork) {
        SLOPE_INFLIGHT.delete(inflightKey);
      }
    }
  }

  const generation = zoneHash ? null : slopeCancelGeneration;
  const work = (async () => {
    const demCache = await caches.open(CACHE_NAME);
    const demKey = buildDemCacheKey(z, x, y, demProfile);

    // 1. Check if HD DEM is already in cache
    let demResponse = null;
    const demHotEntry = (typeof demHotGet === 'function') ? demHotGet(demKey.url) : null;
    if (demHotEntry) {
      demResponse = demHotResponse(demHotEntry);
    } else {
      demResponse = await demCache.match(demKey);
    }

    // 2. PROGRESSIVE 2-PASS: If no cached HD DEM, try fast 30m DEM first (<150ms)
    if (!demResponse || demResponse.status !== 200) {
      let fast30mBlob = null;
      try {
        if (typeof fetchAWSTerrainTile === 'function') {
          fast30mBlob = await fetchAWSTerrainTile(z, x, y);
        }
      } catch { /* ignore */ }

      if (fast30mBlob && !isSlopeWorkCancelled(generation)) {
        const lowResResult = await buildSlopeBlobFromDem(fast30mBlob, z, x, y, demCache, resFactor, demProfile, generation, zoneRing);
        if (lowResResult && !isSlopeWorkCancelled(generation)) {
          const lowResponse = new Response(lowResResult.blob, {
            status: 200,
            headers: {
              'Content-Type': 'image/png',
              'Cache-Control': 'public, max-age=15',
              'X-Tile-Type': 'slope',
              'X-Slope-Quality': 'low',
              'X-DEM-Profile': demProfile,
            },
          });
          slopeCache.put(cacheKey, lowResponse.clone());
          try {
            if (typeof slopeHotPut === 'function') {
              slopeHotPut(hotKey, lowResResult.blob, Array.from(lowResponse.headers.entries()));
            }
          } catch { /* ignore */ }

          // Trigger HD LiDAR upgrade in background (unless skipAutoHd)
          if (!options?.skipAutoHd) {
            buildAndCacheHdSlopeTile(z, x, y, resFactor, demProfile, zoneHash);
          }
          return lowResponse;
        }
      }

      // If fast 30m was not available, fetch LiDAR DEM directly
      const hdBlob = await fetchLiDARDemTile(z, x, y, demProfile);
      if (hdBlob && !isSlopeWorkCancelled(generation)) {
        const hdResult = await buildSlopeBlobFromDem(hdBlob, z, x, y, demCache, resFactor, demProfile, generation, zoneRing);
        if (hdResult && !isSlopeWorkCancelled(generation)) {
          const hdResponse = new Response(hdResult.blob, {
            status: 200,
            headers: {
              'Content-Type': 'image/png',
              'Cache-Control': 'public, max-age=604800',
              'X-Tile-Type': 'slope',
              'X-Slope-Quality': 'hd',
              'X-DEM-Profile': demProfile,
            },
          });
          slopeCache.put(cacheKey, hdResponse.clone());
          try {
            if (typeof slopeHotPut === 'function') {
              slopeHotPut(hotKey, hdResult.blob, Array.from(hdResponse.headers.entries()));
            }
          } catch { /* ignore */ }
          scheduleSlopeNeighbourWarm(z, x, y, demProfile, demCache, hdResult.missingNeighbours, generation);
          return hdResponse;
        }
      }
    }

    if (isSlopeWorkCancelled(generation) || !demResponse || demResponse.status !== 200) {
      return transparentTileResponse();
    }

    try {
      const demBlob = await demResponse.clone().blob();
      if (isSlopeWorkCancelled(generation)) {
        return transparentTileResponse();
      }

      const slopeResult = await buildSlopeBlobFromDem(demBlob, z, x, y, demCache, resFactor, demProfile, generation, zoneRing);
      if (!slopeResult || isSlopeWorkCancelled(generation)) {
        return transparentTileResponse();
      }

      const slopeBlob = slopeResult.blob;
      const demSource = (demResponse.headers.get('X-DEM-Source') || '').toLowerCase();
      const isEmergency = demSource.startsWith('aws-emergency');
      const response = new Response(slopeBlob, {
        status: 200,
        headers: {
          'Content-Type': 'image/png',
          'Cache-Control': isEmergency ? 'public, max-age=15' : 'public, max-age=604800',
          'X-Tile-Type': 'slope',
          'X-Slope-Quality': isEmergency ? 'low' : 'hd',
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

      if (isEmergency) {
        if (!options?.skipAutoHd) {
          buildAndCacheHdSlopeTile(z, x, y, resFactor, demProfile, zoneHash);
        }
      } else {
        scheduleSlopeNeighbourWarm(z, x, y, demProfile, demCache, slopeResult.missingNeighbours, generation);
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
