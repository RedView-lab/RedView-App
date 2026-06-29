// ---------------------------------------------------------------------------
// Altitude tile handler — /altitude-tiles/{z}/{x}/{y}.
//
// Pipeline mirrors the slope handler:
//   own DEM tile (handleDemRequest, deduped by DEM_INFLIGHT)
//     → computeAltitudeViaPool()  (worker pool, OFF the SW thread)
//       fallback → scheduleAltitudeBuild(buildAltitudeTile)  (in-process)
//     → altitude PNG (Terrain-RGB compatible, NoData transparent)
//
// Build path selection: the worker pool runs the dominant CPU work
// (decodeTerrainRGBBlob + altitude encode + PNG encode) on dedicated workers
// so the SW thread stays free for the basemap/IGN/CacheStorage work the next
// tile needs. If the pool isn't available (older browser, Worker spawn
// failure) OR the pool job was cancelled, we fall through to the in-process
// buildAltitudeTile() — byte-identical because both share altitude.js.
//
// A hot tier (ALTITUDE_HOT_CACHE) sits in FRONT of CacheStorage so a toggle
// off/on, pan-back or Mapbox repaint returns a previously served tile in
// <1 ms instead of paying the 5-25 ms caches.match round-trip. Mirrors
// SLOPE_HOT_CACHE exactly.
//
// Split out of sw-dem.js (May 03). Pool + hot tier added 2026-06-29
// (altitude-decode-in-worker).
// ---------------------------------------------------------------------------

function isAltitudeWorkCancelled(generation) {
  return generation !== altitudeCancelGeneration;
}

async function handleAltitudeRequest(z, x, y) {
  // ── Hot tier (ALTITUDE_HOT_CACHE) ────────────────────────────────────
  // Sits in FRONT of CacheStorage exactly like SLOPE_HOT_CACHE. A toggle
  // off/on or a Mapbox repaint re-asks for tiles served a moment ago; this
  // returns them in <1 ms instead of paying 5-25 ms for caches.match.
  const hotKey = `/altitude-tiles/${z}/${x}/${y}`;
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

  const inflightKey = `${z}/${x}/${y}`;
  const existing = ALTITUDE_INFLIGHT.get(inflightKey);
  if (existing) {
    try { return (await existing).clone(); }
    catch { /* fall through and recompute */ }
  }

  const generation = altitudeCancelGeneration;
  const work = (async () => {
    const demCache = await caches.open(CACHE_NAME);
    const demKey = new Request(`/dem-tiles/${z}/${x}/${y}`);
    // Hot-tier shortcut — see slope-handler for rationale. Altitude is
    // typically activated alongside slope, so the DEM blob is freshly
    // hot from the slope path.
    let demResponse = null;
    const demHotEntry = (typeof demHotGet === 'function') ? demHotGet(demKey.url) : null;
    if (demHotEntry) {
      demResponse = demHotResponse(demHotEntry);
    } else {
      demResponse = await demCache.match(demKey);
    }
    if (!demResponse || demResponse.status !== 200) {
      demResponse = await handleDemRequest(demKey, z, x, y);
    }
    if (isAltitudeWorkCancelled(generation)) {
      return transparentTileResponse();
    }
    if (!demResponse || demResponse.status !== 200) {
      return transparentTileResponse();
    }

    try {
      const demBlob = await demResponse.clone().blob();
      if (isAltitudeWorkCancelled(generation)) {
        return transparentTileResponse();
      }

      // ── Build path selection: worker pool first, in-process fallback ──
      // Mirrors slope-handler.js. The pool offloads the decode + altitude
      // encode + PNG encode to dedicated workers. If the pool isn't
      // available or the job was cancelled, fall through to the in-process
      // buildAltitudeTile() — byte-identical because both share altitude.js.
      let altitudeBlob = null;
      let usedPool = false;
      if (typeof computeAltitudeViaPool === 'function') {
        try {
          const poolResult = await computeAltitudeViaPool(demBlob, z, x, y, generation);
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
          ),
          generation,
        );
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
