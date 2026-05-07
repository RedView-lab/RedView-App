// ---------------------------------------------------------------------------
// Fetch intercept — routes /dem-tiles, /ortho-tiles, /slope-tiles,
// /altitude-tiles to the corresponding handler module. Legacy
// /shadow-tiles is hard-410'd (handler retired Apr 29).
//
// Split out of sw-dem.js (May 03).
// ---------------------------------------------------------------------------

// Speculative-prefetch shedding. Requests carrying `?pf=1` are issued by
// `viewportPrefetch.ts` for tiles the user has not yet looked at. They are
// expendable: the next real Mapbox request for the same tile will run the
// pipeline normally. When the DEM dispatcher is already saturated (a real
// foreground burst is mid-flight), we drop incoming pf=1 ortho/slope/
// altitude requests at the router so they never reach the per-handler
// queue. This is the SW-side complement of the browser-side prewarm-abort
// on user gesture: if a stale prewarm slips past gesture cancellation,
// it cannot starve the foreground burst once the pipeline is already busy.
//
// Threshold uses DEM_INFLIGHT.size as a proxy for "system under load".
// All four families (DEM/ortho/slope/altitude) ultimately drive DEM
// pipeline pressure (slope/altitude pre-warm 4 neighbour DEMs, ortho
// shares the same geopf HTTP/2 connection pool).
const PREFETCH_SHED_THRESHOLD = 24;

function isPrefetchRequest(url) {
  return url.searchParams.get('pf') === '1';
}

function noTileResponseRouter(reason) {
  return new Response(null, {
    status: 204,
    headers: { 'X-DEM-Reason': reason },
  });
}

function shedPrefetchIfBusy(url) {
  if (!isPrefetchRequest(url)) return null;
  if (DEM_INFLIGHT.size < PREFETCH_SHED_THRESHOLD) return null;
  return noTileResponseRouter('prefetch-shed');
}

self.addEventListener('fetch', (event) => {
  const url = new URL(event.request.url);

  const demMatch = url.pathname.match(/^\/dem-tiles\/(\d+)\/(\d+)\/(\d+)$/);
  if (demMatch) {
    event.respondWith(handleDemRequest(
      event.request,
      parseInt(demMatch[1], 10),
      parseInt(demMatch[2], 10),
      parseInt(demMatch[3], 10),
      undefined,
      resolveDemProfile(url),
    ));
    return;
  }

  const orthoMatch = url.pathname.match(/^\/ortho-tiles\/(\d+)\/(\d+)\/(\d+)$/);
  if (orthoMatch) {
    const shed = shedPrefetchIfBusy(url);
    if (shed) { event.respondWith(shed); return; }
    event.respondWith(handleOrthoRequest(
      parseInt(orthoMatch[1], 10),
      parseInt(orthoMatch[2], 10),
      parseInt(orthoMatch[3], 10),
    ));
    return;
  }

  const slopeMatch = url.pathname.match(/^\/slope-tiles\/(\d+)\/(\d+)\/(\d+)$/);
  if (slopeMatch) {
    const shed = shedPrefetchIfBusy(url);
    if (shed) { event.respondWith(shed); return; }
    const slopeRes = url.searchParams.get('res') || '';
    const slopeDemProfile = resolveDemProfile(url);
    event.respondWith(handleSlopeRequest(
      parseInt(slopeMatch[1], 10),
      parseInt(slopeMatch[2], 10),
      parseInt(slopeMatch[3], 10),
      slopeRes,
      slopeDemProfile,
    ));
    return;
  }

  const altitudeMatch = url.pathname.match(/^\/altitude-tiles\/(\d+)\/(\d+)\/(\d+)$/);
  if (altitudeMatch) {
    const shed = shedPrefetchIfBusy(url);
    if (shed) { event.respondWith(shed); return; }
    event.respondWith(handleAltitudeRequest(
      parseInt(altitudeMatch[1], 10),
      parseInt(altitudeMatch[2], 10),
      parseInt(altitudeMatch[3], 10),
    ));
    return;
  }

  const shadowMatch = url.pathname.match(/^\/shadow-tiles\/(\d+)\/(\d+)\/(\d+)$/);
  if (shadowMatch) {
    // Legacy per-tile shadow endpoint — retired in favour of the in-page
    // ImageSource pipeline (src/features/sunlight). Return 410 so any stale
    // SW client requesting it doesn't trigger a build.
    event.respondWith(new Response(null, { status: 410, headers: { 'X-DEM-Reason': 'shadow-retired' } }));
    return;
  }
});
