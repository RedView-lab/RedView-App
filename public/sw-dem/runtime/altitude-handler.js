// ---------------------------------------------------------------------------
// Altitude tile handler — /altitude-tiles/{z}/{x}/{y}[?rv-dem-profile=terrain][&zone=<hash>]
//
// Only reached in HD 3D quality (fast-30m streams AWS Terrarium straight to
// the GPU and never hits the SW — see features/altitude/lib/altitude-source.ts).
//
// No zone (the common case): a READ-THROUGH ALIAS of the DEM pipeline. The
// Terrain-RGB DEM blob is served verbatim — Mapbox decodes it on the GPU via
// raster-color-mix — so there is no decode/encode, and no altitude-specific
// CacheStorage / hot tier (they only duplicated the DEM bytes). DEM hot cache
// → CacheStorage → DEM_INFLIGHT coalescing answer almost every request because
// the page caps the source at ALTITUDE_MAX_BUILD_ZOOM, i.e. the zooms the 3D
// terrain loads itself. A genuine miss at those zooms joins the terrain's own
// build (same DEM_INFLIGHT key); above the cap we never build.
//
// Zone-masked: unchanged — polygon mask via worker pool / in-process builder,
// cached under the `?zone=` key.
// ---------------------------------------------------------------------------

const ALTITUDE_MAX_BUILD_ZOOM = 14;

function isAltitudeWorkCancelled(generation) {
  if (generation === null || generation === undefined) return false;
  return generation !== altitudeCancelGeneration;
}

async function handleAltitudeRequest(z, x, y, zoneHash = '', demProfile = 'default') {
  if (!zoneHash) return handleAltitudePassthrough(z, x, y, demProfile);

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

  const generation = null; // zone builds are uncancellable (same as before)
  const work = (async () => {
    const demCache = await caches.open(CACHE_NAME);

    // 1. Get existing DEM tile from the 3D terrain cache / in-flight requests (NEVER download DEM for altitude)
    const demResponse = (typeof getExistingTerrainDemResponse === 'function')
      ? await getExistingTerrainDemResponse(z, x, y, demProfile, demCache)
      : null;

    if (isAltitudeWorkCancelled(generation) || !demResponse || demResponse.status !== 200) {
      return transparentTileResponse();
    }

    try {
      const demBlob = await demResponse.clone().blob();
      if (isAltitudeWorkCancelled(generation)) {
        return transparentTileResponse();
      }

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

async function handleAltitudePassthrough(z, x, y, demProfile) {
  const generation = altitudeCancelGeneration;
  try {
    const demCache = await caches.open(CACHE_NAME);
    const demResponse = (typeof getExistingTerrainDemResponse === 'function')
      ? await getExistingTerrainDemResponse(z, x, y, demProfile, demCache, '', {
          allowBuild: z <= ALTITUDE_MAX_BUILD_ZOOM,
        })
      : null;
    if (generation !== altitudeCancelGeneration || !demResponse || demResponse.status !== 200) {
      return transparentTileResponse();
    }
    const headers = new Headers(demResponse.headers);
    headers.set('X-Tile-Type', 'altitude');
    return new Response(demResponse.body, { status: 200, headers });
  } catch (err) {
    console.error('[altitude]', z, x, y, err);
    return transparentTileResponse();
  }
}
