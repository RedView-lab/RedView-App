// ---------------------------------------------------------------------------
// Fetch intercept — routes /dem-tiles, /ortho-tiles, /slope-tiles,
// /altitude-tiles to the corresponding handler module. Legacy
// /shadow-tiles is hard-410'd (handler retired Apr 29).
//
// Split out of sw-dem.js (May 03).
// ---------------------------------------------------------------------------

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
    event.respondWith(handleOrthoRequest(
      parseInt(orthoMatch[1], 10),
      parseInt(orthoMatch[2], 10),
      parseInt(orthoMatch[3], 10),
    ));
    return;
  }

  const slopeMatch = url.pathname.match(/^\/slope-tiles\/(\d+)\/(\d+)\/(\d+)$/);
  if (slopeMatch) {
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
