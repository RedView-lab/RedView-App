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
    if (isVideoDemTileRequest(_request)) return handleVideoDemRequest(_request, z, x, y, demProfile);
    return coalesceDemRequest(_request, z, x, y, demProfile);
  }

  return computeDemRequest(_request, z, x, y, _depth, demProfile);
}

async function coalesceDemRequest(request, z, x, y, demProfile, options) {
  const inflightKey = `${demProfile}:${z}/${x}/${y}`;
  // A build cancelled for its original requester (the map dropped the tile,
  // then asked for it again) is no answer for this one: join the rebuild
  // another waiter may have started, else start it.
  const awaited = new Set();
  let existing = DEM_INFLIGHT.get(inflightKey);
  while (existing && !awaited.has(existing)) {
    awaited.add(existing);
    try {
      const shared = await existing;
      const cancelled = shared.status === 204
        && shared.headers.get('X-DEM-Reason') === DEM_CANCELLED_REASON;
      if (!cancelled) return shared.clone();
    } catch { /* fall through and recompute */ }
    existing = DEM_INFLIGHT.get(inflightKey);
  }

  const work = computeDemRequest(request, z, x, y, 0, demProfile, options);
  DEM_INFLIGHT.set(inflightKey, work);
  try {
    const response = await work;
    return response.clone();
  } finally {
    // A newer build may own the key (DEM_WANTED_TILES dropped this one).
    if (DEM_INFLIGHT.get(inflightKey) === work) DEM_INFLIGHT.delete(inflightKey);
  }
}

// ── Flyover video export (`rv-src=video`) ─────────────────────────────
// The export films a frame once every tile of it is loaded and never reloads
// a terrain tile in place (flyover/video/videoMap.ts): a stand-in answered
// now — parent overzoom, bare earth or AWS 30 m after a transient LiDAR
// failure, a partial build whose upgrade is still running — would stay in the
// video for as long as the tile is on screen. A video request therefore skips
// the stand-ins cached for the live map and, when the build still comes out
// provisional, retries it with the transient failures forgotten. Bounded: a
// retry only starts in the first VIDEO_DEM_RETRY_START_LIMIT_MS, so the
// answer (the stand-in, at worst) comes well within the export's per-frame
// wait (FRAME_SETTLE_TIMEOUT_MS, flyover/video/config.ts) and the browsers'
// fetch-event limits.
const VIDEO_DEM_RETRY_DELAYS_MS = [1_000, 2_500, 5_000, 8_000];
const VIDEO_DEM_RETRY_START_LIMIT_MS = 30_000;
// 204s that are the tile's answer (no relief there), not a failure to retry.
// A video build skips the short negative entries, so its `neg-cache` is a
// confirmed empty tile.
const VIDEO_DEM_FINAL_EMPTY_REASONS = new Set(['world-zoom', 'no-coverage', 'global-parent-mesh', 'neg-cache']);

function isProvisionalVideoDemAnswer(response, z, x, y, demProfile) {
  if (!response) return true;
  if (response.status === 204) {
    return !VIDEO_DEM_FINAL_EMPTY_REASONS.has(response.headers.get('X-DEM-Reason') || '');
  }
  if (response.status !== 200) return true;
  // Short-cached stand-in (finalize) or a tile the health guard replaced.
  if (response.headers.get('x-cache-ttl-ms')) return true;
  if ((response.headers.get('X-DEM-Health') || 'ok').toLowerCase() !== 'ok') return true;
  // Partial IGN build: its background upgrade (scheduleBackgroundUpgrade) is
  // still fetching the missing sub-tiles.
  const source = response.headers.get('X-DEM-Source') || '';
  const fullQuality = source.endsWith('+upgrade') || source === 'ign'
    || source.startsWith('ign-fallback-z') || source.startsWith('ign-highres');
  return !fullQuality && pendingUpgrades.has(`${demProfile}:${z}/${x}/${y}`);
}

async function handleVideoDemRequest(request, z, x, y, demProfile) {
  const startedAt = Date.now();
  let response = await coalesceDemRequest(request, z, x, y, demProfile, { finalOnly: true });
  for (const delayMs of VIDEO_DEM_RETRY_DELAYS_MS) {
    if (!isProvisionalVideoDemAnswer(response, z, x, y, demProfile)) return response;
    if (Date.now() - startedAt + delayMs > VIDEO_DEM_RETRY_START_LIMIT_MS) break;
    await new Promise((resolve) => setTimeout(resolve, delayMs));
    forgetTransientWmsFailures(z, x, y);
    response = await coalesceDemRequest(request, z, x, y, demProfile, { finalOnly: true });
  }
  if (isProvisionalVideoDemAnswer(response, z, x, y, demProfile) && typeof swLog !== 'undefined') {
    swLog.warn(
      'dispatch',
      `video ${z}/${x}/${y}: still provisional after ${((Date.now() - startedAt) / 1000).toFixed(1)} s (${response?.headers.get('X-DEM-Source') || response?.headers.get('X-DEM-Reason') || response?.status})`,
    );
  }
  return response;
}
