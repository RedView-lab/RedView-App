// ---------------------------------------------------------------------------
// Altitude tile handler — /altitude-tiles/{z}/{x}/{y}.
//
// Pipeline mirrors the slope handler:
//   Strictly reuses the 3D terrain DEM tile (getExistingTerrainDemResponse).
//   NEVER initiates independent remote network downloads of DEM tiles.
//   Fast-path: when no analysis-zone masking is needed, directly serves
//   the 3D DEM Terrain-RGB blob (zero worker decode/encode CPU overhead).
//   When zone-masked, applies polygon mask via worker pool / in-process builder.
//
// A hot tier (ALTITUDE_HOT_CACHE) sits in FRONT of CacheStorage so a toggle
// off/on, pan-back or Mapbox repaint returns a previously served tile in
// <1 ms instead of paying the 5-25 ms caches.match round-trip.
// ---------------------------------------------------------------------------

function isAltitudeWorkCancelled(generation) {
  if (generation === null || generation === undefined) return false;
  return generation !== altitudeCancelGeneration;
}

async function handleAltitudeRequest(z, x, y, zoneHash = '') {
  // ── Analysis-zone cache key ──────────────────────────────────────────
  // `?zone=<hash>` isolates masked from unmasked tiles in CacheStorage and
  // the hot tier (same convention as the slope handler), so a zone edit can
  // never serve a stale unmasked tile under the new key.
  const hotKey = `/altitude-tiles/${z}/${x}/${y}${zoneHash ? `?zone=${zoneHash}` : ''}`;
  const hot = (typeof altitudeHotGet === 'function') ? altitudeHotGet(hotKey) : null;
  if (hot) return altitudeHotResponse(hot);

  const altitudeCache = await caches.open(ALTITUDE_CACHE_NAME);
  const cacheKey = new Request(hotKey);
  const cached = await altitudeCache.match(cacheKey);
  if (cached) {
    // Promote a fresh CacheStorage hit to the hot tier so the next request
    // skips CacheStorage entirely. Cheap (Blob is refcounted).
    try {
      if (typeof altitudeHotPut === 'function') {
        altitudeHotPut(hotKey, await cached.clone().blob(), Array.from(cached.headers.entries()));
      }
    } catch { /* ignore */ }
    return cached;
  }

  // ── Analysis-zone early rejection ────────────────────────────────────
  const { entry: zoneEntry, ring: zoneRing } = resolveAnalysisZoneForTile(zoneHash);
  if (zoneHash) {
    if (!zoneEntry || !tileIntersectsAnalysisZone(zoneEntry, z, x, y)) {
      return transparentTileResponse();
    }
  }

  const inflightKey = `${z}/${x}/${y}${zoneHash ? `?z=${zoneHash}` : ''}`;
  const existing = ALTITUDE_INFLIGHT.get(inflightKey);
  if (existing) {
    try { return (await existing).clone(); }
    catch { /* fall through and recompute */ }
  }

  const generation = zoneHash ? null : altitudeCancelGeneration;
  const work = (async () => {
    const demCache = await caches.open(CACHE_NAME);

    // 1. Get existing DEM tile from the 3D terrain cache / in-flight requests (NEVER download DEM for altitude)
    const demResponse = (typeof getExistingTerrainDemResponse === 'function')
      ? await getExistingTerrainDemResponse(z, x, y, 'default', demCache)
      : null;

    if (isAltitudeWorkCancelled(generation) || !demResponse || demResponse.status !== 200) {
      return transparentTileResponse();
    }

    try {
      const demBlob = await demResponse.clone().blob();
      if (isAltitudeWorkCancelled(generation)) {
        return transparentTileResponse();
      }

      // Fast-path: When there is no polygon analysis zone masking required,
      // the 3D terrain DEM blob is ALREADY bit-exact Terrain-RGB! Mapbox's
      // raster-color-mix directly decodes Terrain-RGB meters on the GPU.
      // We directly wrap and serve demBlob, avoiding CPU decodes, Float32Array allocations,
      // and PNG deflate recompression entirely.
      let altitudeBlob = null;
      if (!zoneRing) {
        altitudeBlob = demBlob;
      } else {
        // ── Zone-masked build path: worker pool first, in-process fallback ──
        let usedPool = false;
        if (typeof computeAltitudeViaPool === 'function') {
          try {
            const poolResult = await computeAltitudeViaPool(demBlob, z, x, y, generation, zoneRing);
            if (poolResult) {
              altitudeBlob = poolResult.blob;
              usedPool = true;
            }
          } catch {
            /* fall through to in-process */
          }
        }

        if (!usedPool) {
          altitudeBlob = await scheduleAltitudeBuild(
            () => buildAltitudeTile(
              demBlob,
              z,
              x,
              y,
              () => isAltitudeWorkCancelled(generation),
              zoneRing,
            ),
            generation,
          );
        }
      }

      if (!altitudeBlob || isAltitudeWorkCancelled(generation)) {
        return transparentTileResponse();
      }
      const response = new Response(altitudeBlob, {
        status: 200,
        headers: {
          'Content-Type': 'image/png',
          'Cache-Control': 'public, max-age=604800',
          'X-Tile-Type': 'altitude',
        },
      });
      if (!isAltitudeWorkCancelled(generation)) {
        altitudeCache.put(cacheKey, response.clone());
        // Promote the freshly built tile into the altitude hot tier so an
        // immediate re-request (Mapbox repaint, toggle off/on a moment
        // later) returns in <1 ms.
        try {
          if (typeof altitudeHotPut === 'function') {
            altitudeHotPut(hotKey, altitudeBlob, Array.from(response.headers.entries()));
          }
        } catch { /* ignore */ }
      }
      return response;
    } catch (err) {
      console.error('[altitude]', z, x, y, err);
      return transparentTileResponse();
    }
  })();

  ALTITUDE_INFLIGHT.set(inflightKey, work);
  try {
    const response = await work;
    return response.clone();
  } finally {
    if (ALTITUDE_INFLIGHT.get(inflightKey) === work) {
      ALTITUDE_INFLIGHT.delete(inflightKey);
    }
  }
}
