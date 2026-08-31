// ---------------------------------------------------------------------------
// Slope Tile Processing — DEM Resolver from Existing 3D Terrain Cache
//
// Strictly reuses the DEM tiles already fetched and cached by the 3D map.
// NEVER initiates independent network downloads of DEM tiles for slope.
// ---------------------------------------------------------------------------

async function getExistingTerrainDemResponse(z, x, y, demProfile, demCache) {
  // 1. Check in-memory DEM Hot Cache for requested profile
  const specificKey = buildDemCacheKey(z, x, y, demProfile);
  let hotEntry = (typeof demHotGet === 'function') ? demHotGet(specificKey.url) : null;
  if (hotEntry) {
    return demHotResponse(hotEntry);
  }

  // 2. Check in-memory DEM Hot Cache for default terrain profile
  const defaultKey = buildDemCacheKey(z, x, y, 'default');
  if (defaultKey.url !== specificKey.url) {
    hotEntry = (typeof demHotGet === 'function') ? demHotGet(defaultKey.url) : null;
    if (hotEntry) {
      return demHotResponse(hotEntry);
    }
  }

  // 3. Check CacheStorage for requested profile
  if (demCache) {
    let cached = await demCache.match(specificKey);
    if (cached && cached.status === 200) {
      return cached;
    }

    // 4. Check CacheStorage for default terrain profile
    if (defaultKey.url !== specificKey.url) {
      cached = await demCache.match(defaultKey);
      if (cached && cached.status === 200) {
        return cached;
      }
    }
  }

  // 5. Coalesce with active in-flight 3D terrain fetches (if terrain is currently loading this tile)
  if (typeof DEM_INFLIGHT !== 'undefined' && DEM_INFLIGHT) {
    const specificInflightKey = `${demProfile}:${z}/${x}/${y}`;
    const defaultInflightKey = `default:${z}/${x}/${y}`;
    const inflight = DEM_INFLIGHT.get(specificInflightKey) || DEM_INFLIGHT.get(defaultInflightKey);
    if (inflight) {
      try {
        const resp = await inflight;
        if (resp && resp.status === 200) {
          return resp.clone();
        }
      } catch { /* ignore */ }
    }
  }

  // 6. Parent overzoom fallback (zero network): if parent tile is in cache, upsample it
  try {
    if (typeof tryParentOverzoom === 'function' && demCache) {
      const overzoomed = await tryParentOverzoom(demCache, z, x, y, 0, demProfile);
      if (overzoomed && overzoomed.blob) {
        return new Response(overzoomed.blob, {
          status: 200,
          headers: {
            'Content-Type': 'image/png',
            'X-DEM-Source': overzoomed.source || 'overzoom',
            'X-DEM-Health': 'ok',
          },
        });
      }
    }
  } catch { /* ignore */ }

  // 7. If not in cache, fetch via handleDemRequest so both 3D terrain and overlays receive elevation data
  try {
    if (typeof handleDemRequest === 'function') {
      const demResp = await handleDemRequest(specificKey, z, x, y, 0, demProfile);
      if (demResp && demResp.status === 200) {
        return demResp;
      }
    }
  } catch { /* ignore */ }

  return null;
}

async function fetchLiDARDemTile(z, x, y, demProfile, purpose = 'slope', zoneHash = '') {
  try {
    const demCache = await caches.open(CACHE_NAME);
    const resp = await getExistingTerrainDemResponse(z, x, y, demProfile, demCache);
    if (resp && resp.status === 200) {
      return await resp.clone().blob();
    }
  } catch { /* ignore */ }
  return null;
}
