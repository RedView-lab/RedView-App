// ---------------------------------------------------------------------------
// DEM tile handler entry point — top-level dispatcher for
// /dem-tiles/{z}/{x}/{y}.
//
// Split out of runtime/dem-handler.js into runtime/dem-handler/ (May 15).
// `computeDemRequest()` now lives in ./compute-request.js; this file keeps the
// stable global `handleDemRequest()` surface consumed by router.js,
// slope-handler.js, altitude-handler.js and dem-helpers.js.
// ---------------------------------------------------------------------------

async function handleDemRequest(_request, z, x, y, _depth, demProfile) {
  if (_depth === undefined) _depth = 0;
  if (!demProfile) demProfile = resolveDemProfileFromRequest(_request);

  // World-zoom short-circuit: no visible terrain relief below z4, and at that
  // zoom Mapbox tiles are tiny fractions of the globe. Returning 204 instantly
  // lets Mapbox GL reuse parent/empty meshes and prevents the SW from ever
  // blocking the Standard-Satellite base-map fetches on origin contention
  // during fast pinch-zoom-out (root cause of the "white earth" symptom).
  if (z < 4) return noTileResponse('world-zoom');

  // ── Speculative-prefetch shedding under load ─────────────────────────
  //
  // Prefetch requests carry `?pf=1` (set by viewportPrefetch.ts). They are
  // SPECULATIVE — failing them silently is harmless: the next real Mapbox
  // request for the same tile will run the full pipeline normally.
  //
  // When the dispatcher is already saturated (DEM_INFLIGHT.size above the
  // soft cap), we drop incoming pf=1 immediately rather than enqueueing
  // them behind ~50 IGN sub-tile fetches. This is the SW-side defence
  // matching the browser-side prewarm-abort on user gesture: even if a
  // prewarm batch slips past gesture cancellation, it cannot starve the
  // foreground burst once the pipeline is already busy.
  //
  // Threshold rationale: a typical search-bar prewarm fires ≤14 tiles +
  // child/parent (~20 max). Mapbox's visible viewport at z14 60° pitch
  // peaks around 24 tiles. Setting the cap at 24 means: if real foreground
  // is actively flowing, prefetch yields. Below 24 (cold cache, idle map),
  // prefetch runs normally.
  if (_depth === 0 && _request) {
    let isPrefetch = false;
    try {
      isPrefetch = new URL(_request.url).searchParams.get('pf') === '1';
    } catch { /* ignore */ }
    if (isPrefetch && DEM_INFLIGHT.size >= 24) {
      return noTileResponse('prefetch-shed');
    }
  }

  // ── In-flight coalescing — only at the top level. We deliberately skip
  // dedup for recursive overzoom calls (depth>0) because those carry their
  // own internal child requests and we don't want to deadlock by awaiting
  // ourselves through a Promise chain.
  if (_depth === 0) {
    const inflightKey = `${demProfile}:${z}/${x}/${y}`;
    const existing = DEM_INFLIGHT.get(inflightKey);
    if (existing) {
      try { return (await existing).clone(); }
      catch { /* fall through and recompute */ }
    }

    const work = computeDemRequest(_request, z, x, y, _depth, demProfile);
    DEM_INFLIGHT.set(inflightKey, work);
    try {
      const response = await work;
      return response.clone();
    } finally {
      DEM_INFLIGHT.delete(inflightKey);
    }
  }

  return computeDemRequest(_request, z, x, y, _depth, demProfile);
}
