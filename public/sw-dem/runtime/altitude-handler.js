// ---------------------------------------------------------------------------
// Altitude tile handler — /altitude-tiles/{z}/{x}/{y}.
//
// Reuses the cached DEM tile (default profile) and runs buildAltitudeTile
// from altitude.js. Same in-flight dedup pattern as the slope handler.
//
// Split out of sw-dem.js (May 03).
// ---------------------------------------------------------------------------

function isAltitudeWorkCancelled(generation) {
  return generation !== altitudeCancelGeneration;
}

async function handleAltitudeRequest(z, x, y) {
  const altitudeCache = await caches.open(ALTITUDE_CACHE_NAME);
  const cacheKey = new Request(`/altitude-tiles/${z}/${x}/${y}`);
  const cached = await altitudeCache.match(cacheKey);
  if (cached) return cached;

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
      const altitudeBlob = await scheduleAltitudeBuild(
        () => buildAltitudeTile(
          demBlob,
          z,
          x,
          y,
          () => isAltitudeWorkCancelled(generation),
        ),
        generation,
      );
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
      if (!isAltitudeWorkCancelled(generation)) altitudeCache.put(cacheKey, response.clone());
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
