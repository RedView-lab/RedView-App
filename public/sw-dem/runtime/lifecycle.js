// ---------------------------------------------------------------------------
// SW Lifecycle
//
// Split out of sw-dem.js (May 03) to keep the entry point a thin loader and
// give each pipeline concern its own debuggable file. This file owns:
//   - managed map cache names (purge on activate / PURGE messages)
//   - static routing (fetch-event only for the tile families)
//   - install/activate/message (skipWaiting, claim, manual cache busting)
// Hot caches live in hot-caches.js; the composite limiter, build queues and
// SLOPE_INFLIGHT / ALTITUDE_INFLIGHT / DEM_INFLIGHT in build-queues.js.
// ---------------------------------------------------------------------------

const MAP_CACHE_PREFIXES = [
  'dem-tiles-',
  'dem-negative-',
  'ortho-tiles-',
  'vhr-tiles-',
  'slope-tiles-',
  'altitude-tiles-',
  'shadow-tiles-',
  'dem-static-',
];

const CURRENT_MAP_CACHE_NAMES = new Set([
  CACHE_NAME,
  NEGATIVE_CACHE_NAME,
  ORTHO_CACHE_NAME,
  VHR_CACHE_NAME,
  SLOPE_CACHE_NAME,
  ALTITUDE_CACHE_NAME,
  STATIC_CACHE_NAME,
]);

function isManagedMapCacheName(cacheName) {
  return MAP_CACHE_PREFIXES.some((prefix) => cacheName.startsWith(prefix));
}

function purgeManagedMapCaches({ includeCurrent = false } = {}) {
  return caches.keys().then((keys) => Promise.all(
    keys
      .filter((cacheName) => isManagedMapCacheName(cacheName))
      .filter((cacheName) => includeCurrent || !CURRENT_MAP_CACHE_NAMES.has(cacheName))
      .map((cacheName) => caches.delete(cacheName))
  ));
}

// ── Static routing (Service Worker Static Routing API, Chrome/Edge 123+) ──
// router.js only answers the six tile families below; every other request
// (Mapbox satellite/vector tiles, sprites, glyphs, API calls, app assets)
// falls through to the network. Without routes the browser still dispatches
// each of those to the SW thread first — so while the SW is busy building a
// 0.40 m DEM tile, or is being restarted after idle termination (~45
// importScripts), satellite imagery waits behind it. Declaring the same
// split as static routes lets the browser send them straight to the network.
// Same behaviour as today; browsers without the API (Safari, Firefox) ignore
// it. Must never fail the install (see comment below).
const SW_FETCH_EVENT_PATHS = [
  '/dem-tiles/*',
  '/ortho-tiles/*',
  '/vhr-tiles/*',
  '/slope-tiles/*',
  '/altitude-tiles/*',
  '/radar-tiles/*',
];

function registerStaticRoutes(e) {
  if (typeof e.addRoutes !== 'function' || typeof URLPattern !== 'function') {
    return Promise.resolve();
  }
  try {
    const routes = SW_FETCH_EVENT_PATHS.map((pathname) => ({
      condition: { urlPattern: new URLPattern({ pathname }) },
      source: 'fetch-event',
    }));
    routes.push({ condition: { urlPattern: new URLPattern({}) }, source: 'network' });
    return Promise.resolve(e.addRoutes(routes)).catch((err) => {
      console.warn('[sw-dem] install: static routes rejected (non-fatal):', err);
    });
  } catch (err) {
    console.warn('[sw-dem] install: static routes unavailable (non-fatal):', err);
    return Promise.resolve();
  }
}

self.addEventListener('install', (e) => {
  const staticRoutes = registerStaticRoutes(e);
  // CRITICAL: install must NEVER hinge on a network fetch. `cache.add()`
  // rejects on any transient hiccup (offline, 5xx, slow proxy) or non-ok
  // response for /france-border.json. If install rejects, the SW becomes
  // redundant → activate/clients.claim() never run → no controller for the
  // whole session → DEM, slope AND altitude overlays silently stall (they
  // all depend on the SW serving their tile endpoints). The France polygon
  // is only needed for ortho clipping and is loaded lazily by
  // ensureFrancePoly() on demand anyway, so prefetch failure is non-fatal.
  e.waitUntil(
    staticRoutes
      .then(() => caches.open(STATIC_CACHE_NAME))
      .then((cache) => cache.add('/france-border.json'))
      .then(() => ensureFrancePoly())
      .catch((err) => {
        console.warn('[sw-dem] install: france-border.json prefetch failed (non-fatal, loaded lazily later):', err);
      })
      .then(() => self.skipWaiting())
  );
});

self.addEventListener('activate', (e) => {
  // clients.claim() is what fires `controllerchange` on the page and lets the
  // DEM/slope/altitude pipeline come alive. It must run even if the cache
  // purge fails, otherwise a CacheStorage error would strand the page with no
  // controller (same failure mode as a rejecting install).
  e.waitUntil(
    purgeManagedMapCaches()
      .catch((err) => {
        console.warn('[sw-dem] activate: managed cache purge failed (non-fatal):', err);
      })
      .then(() => self.clients.claim())
  );
});

self.addEventListener('message', (e) => {
  // A force-reloaded page (Ctrl+Shift+R) is never controlled, even though
  // this worker is already active — activate (and its clients.claim()) will
  // not run again. The page asks explicitly instead of staying on the 30 m
  // fallback (and hitting the server for every tile) until a reinstall.
  if (e.data?.type === 'CLAIM_CLIENTS') {
    e.waitUntil(self.clients.claim());
    return;
  }
  if (e.data?.type === 'SET_VIEWPORT_CENTER') {
    try {
      if (typeof setIGNViewportCenter === 'function') {
        setIGNViewportCenter(e.data.center);
      }
    } catch { /* ignore */ }
    return;
  }
  // DEM ↔ Ortho pairing toggle. Set by listeners.ts when the satellite
  // basemap is mounted / removed. See router.js > maybeKickOrtho for
  // the rationale. Idempotent.
  if (e.data?.type === 'SET_PAIR_ORTHO_WITH_DEM') {
    try {
      if (typeof setPairOrthoWithDem === 'function') {
        setPairOrthoWithDem(Boolean(e.data.enabled));
      }
    } catch { /* ignore */ }
    return;
  }
  if (e.data?.type === 'PURGE_MAP_CACHES') {
    try { if (typeof clearSlopeProcessingCaches === 'function') clearSlopeProcessingCaches(); } catch { /* ignore */ }
    try { if (typeof clearAltitudeProcessingCaches === 'function') clearAltitudeProcessingCaches(); } catch { /* ignore */ }
    try { demHotClear(); } catch { /* ignore */ }
    try { slopeHotClear(); } catch { /* ignore */ }
    try { altitudeHotClear(); } catch { /* ignore */ }
    try { orthoHotClear(); } catch { /* ignore */ }
    try { vhrHotClear(); } catch { /* ignore */ }
    purgeManagedMapCaches({ includeCurrent: true });
    return;
  }
  if (e.data?.type === 'CLEAR_DEM_CACHE') {
    try { if (typeof clearSlopeProcessingCaches === 'function') clearSlopeProcessingCaches(); } catch { /* ignore */ }
    try { if (typeof clearAltitudeProcessingCaches === 'function') clearAltitudeProcessingCaches(); } catch { /* ignore */ }
    try { demHotClear(); } catch { /* ignore */ }
    try { slopeHotClear(); } catch { /* ignore */ }
    try { altitudeHotClear(); } catch { /* ignore */ }
    try { orthoHotClear(); } catch { /* ignore */ }
    caches.delete(CACHE_NAME);
    return;
  }
  if (e.data?.type === 'CLEAR_SLOPE_CACHE') {
    try { if (typeof clearSlopeProcessingCaches === 'function') clearSlopeProcessingCaches(); } catch { /* ignore */ }
    try { slopeHotClear(); } catch { /* ignore */ }
    caches.delete(SLOPE_CACHE_NAME);
    return;
  }
  // Slope / Altitude active state change — expands/shrinks the DEM hot tier so panning
  // with slope or altitude on (which reads more DEM tiles than the basemap) does not
  // evict basemap DEM tiles the user will re-ask for next frame. Sent by
  // useSlope / useAltitude on enable/disable. Idempotent.
  if (e.data?.type === 'SLOPE_ACTIVE_STATE') {
    try {
      _slopeActive = Boolean(e.data.active);
      syncDemHotCacheCapacity();
    } catch { /* ignore */ }
    return;
  }
  if (e.data?.type === 'ALTITUDE_ACTIVE_STATE') {
    try {
      _altitudeActive = Boolean(e.data.active);
      syncDemHotCacheCapacity();
    } catch { /* ignore */ }
    return;
  }
  if (e.data?.type === 'SET_SW_LOG_LEVEL') {
    if (typeof swLog !== 'undefined' && e.data.level) {
      swLog.setLevel(e.data.level);
      if (typeof DEBUG !== 'undefined') {
        DEBUG = swLog.isDebug();
      }
      swLog.info('lifecycle', `log level set to ${e.data.level} (numeric=${swLog.getLevel()})`);
    }
    return;
  }
  if (e.data?.type === 'CANCEL_SLOPE_WORK') {
    if (typeof activeZonePipeline !== 'undefined' && activeZonePipeline) {
      activeZonePipeline.cancelled = true;
    }
    const cancelled = cancelSlopeWork();
    if (DEBUG && cancelled.slopeCount > 0) {
      console.warn(`[sw-dem][cancel-slope] slopeCount=${cancelled.slopeCount}`);
    }
    return;
  }
  if (e.data?.type === 'START_ZONE_SLOPE_PIPELINE') {
    const tiles = Array.isArray(e.data.tiles) ? e.data.tiles : [];
    const profile = e.data.profile === 'terrain' ? 'terrain' : 'default';
    const zone = typeof e.data.zone === 'string' ? e.data.zone : '';
    if (zone && e.data.ring && typeof registerAnalysisZone === 'function') {
      try { registerAnalysisZone(zone, e.data.ring); } catch { /* ignore */ }
    }
    if (tiles.length === 0) return;
    try {
      if (typeof startZoneSlopeMultiFetch === 'function') {
        startZoneSlopeMultiFetch(tiles, profile, zone);
      }
    } catch { /* best-effort */ }
    return;
  }
  if (e.data?.type === 'PURGE_SLOPE_CACHE') {
    const zone = typeof e.data.zone === 'string' ? e.data.zone : '';
    if (typeof purgeSlopeCache === 'function') {
      purgeSlopeCache(zone).catch(() => {});
    }
    return;
  }
  if (e.data?.type === 'CANCEL_ALTITUDE_WORK') {
    const cancelled = cancelAltitudeWork();
    if (DEBUG && (cancelled.altitudeCount > 0 || cancelled.poolCancelled > 0)) {
      console.warn(`[sw-dem][cancel-altitude] altitude=${cancelled.altitudeCount} pool=${cancelled.poolCancelled}`);
    }
    return;
  }
  if (e.data?.type === 'CLEAR_ALTITUDE_CACHE') {
    try { if (typeof clearAltitudeProcessingCaches === 'function') clearAltitudeProcessingCaches(); } catch { /* ignore */ }
    try { altitudeHotClear(); } catch { /* ignore */ }
    caches.delete(ALTITUDE_CACHE_NAME);
    return;
  }
  if (e.data?.type === 'CLEAR_SHADOW_CACHE') {
    // Retired endpoint — kept for compatibility with any in-flight client
    // build that still posts the message.
    caches.delete('shadow-tiles-v1');
    return;
  }
  if (e.data?.type === 'CLEAR_NEGATIVE_CACHE') {
    caches.delete(NEGATIVE_CACHE_NAME);
    return;
  }
  // Drain queued speculative IGN fetches + Ortho fetches AND abort their
  // in-flight HTTP requests on user gesture (zoomstart/movestart), so the
  // new viewport's burst does not wait for the previous viewport's
  // speculative work to free the IGN slots. The abortable controllers carry
  // USER_CANCEL_REASON so the per-fetch catch handlers skip negative
  // caching for tiles WE just killed.
  //
  // The basemap DEM work is left alone (see flushIGNQueue): a gesture start
  // does not tell which terrain tiles the map still needs, and killing those
  // turned the tiles on screen into 30 m / correlation-MNS fallbacks. The
  // stale ones are dropped by DEM_WANTED_TILES below. DEM_INFLIGHT is kept
  // too: the builds in flight are now the real tiles, worth coalescing onto.
  if (e.data?.type === 'CANCEL_STALE_DEM') {
    let ignQ = 0, ignF = 0, orthoQ = 0, orthoF = 0;
    try { ignQ = typeof flushIGNQueue === 'function' ? flushIGNQueue() : 0; } catch { /* ignore */ }
    try { ignF = typeof cancelInFlightIGN === 'function' ? cancelInFlightIGN() : 0; } catch { /* ignore */ }
    try { orthoQ = typeof flushOrthoQueue === 'function' ? flushOrthoQueue() : 0; } catch { /* ignore */ }
    try { orthoF = typeof cancelInFlightOrtho === 'function' ? cancelInFlightOrtho() : 0; } catch { /* ignore */ }
    if (DEBUG && (ignQ + ignF + orthoQ + orthoF) > 0) {
      console.warn(
        `[sw-dem][cancel-stale] ign queued=${ignQ} inflight=${ignF}, ortho queued=${orthoQ} inflight=${orthoF}`,
      );
    }
    return;
  }
  // DEM tiles the map's terrain source is still waiting on, posted while the
  // camera moves (features/map3d/hooks/useMap/controller/demWantedTiles.ts).
  // Work for the map's other tiles is stale: drop it, and forget its builds
  // so a later request for one of those tiles starts afresh.
  if (e.data?.type === 'DEM_WANTED_TILES') {
    const keys = Array.isArray(e.data.keys)
      ? e.data.keys.filter((key) => typeof key === 'string')
      : null;
    const sentAt = Number(e.data.sentAt);
    if (!keys || !Number.isFinite(sentAt) || typeof pruneUnwantedMapDemWork !== 'function') return;
    try {
      const dropped = pruneUnwantedMapDemWork(new Set(keys), sentAt);
      for (const key of dropped) {
        DEM_INFLIGHT.delete(`default:${key}`);
        DEM_INFLIGHT.delete(`terrain:${key}`);
      }
    } catch { /* ignore */ }
    return;
  }
  // Per-tile invalidation of slope+altitude derived caches. Sent by the
  // map controller after the DEM service worker upgrades a DEM tile to
  // higher quality (e.g. France HIGHRES kicks in mid-session). Without
  // this the slope/altitude PNGs cached in the SW still encode the old
  // low-quality DEM, so the user sees stale slope/altitude even after
  // the DEM tile itself is upgraded — the "delais" the user reports.
  if (e.data?.type === 'INVALIDATE_DERIVED_TILE') {
    const z = e.data.z | 0;
    const x = e.data.x | 0;
    const y = e.data.y | 0;
    if (!Number.isFinite(z) || !Number.isFinite(x) || !Number.isFinite(y)) return;
    try { if (typeof invalidateSlopeProcessingTile === 'function') invalidateSlopeProcessingTile(z, x, y); } catch { /* ignore */ }
    try { if (typeof invalidateAltitudeProcessingTile === 'function') invalidateAltitudeProcessingTile(z, x, y); } catch { /* ignore */ }
    const max = (1 << z) - 1;
    const slopeTiles = [
      [x, y],
      [x, y - 1],
      [x + 1, y],
      [x, y + 1],
      [x - 1, y],
    ].filter(([tx, ty]) => tx >= 0 && ty >= 0 && tx <= max && ty <= max);
    // The hot tier sits in front of CacheStorage: without this the reload
    // that follows (listeners.ts) got the pre-upgrade slope tile back.
    for (const [tx, ty] of slopeTiles) slopeHotDeleteTile(z, tx, ty);
    const altitudeTilePath = `/altitude-tiles/${z}/${x}/${y}`;
    Promise.all([
      caches.open(SLOPE_CACHE_NAME).then((cache) => cache.keys().then((keys) => {
        return Promise.all(keys
          .filter((req) => {
            try {
              const path = new URL(req.url).pathname;
              return slopeTiles.some(([tx, ty]) => path === `/slope-tiles/${z}/${tx}/${ty}`);
            }
            catch { return false; }
          })
          .map((req) => cache.delete(req)));
      })),
      caches.open(ALTITUDE_CACHE_NAME).then((cache) => cache.keys().then((keys) => {
        return Promise.all(keys
          .filter((req) => {
            try { return new URL(req.url).pathname === altitudeTilePath; }
            catch { return false; }
          })
          .map((req) => cache.delete(req)));
      })),
    ]).catch(() => { /* best-effort */ });
    return;
  }
  // ── Cross-profile / viewport slope prewarm (2026-06-20 multicore) ────
  // The page posts this when (a) the user switches resolution (0.40m ↔
  // 1m) so the OTHER profile's slope tiles are built in the background
  // while the user is still looking at the current one, and (b) on idle
  // to opportunistically warm the visible slope ring. The work runs at
  // slope-warm priority (already isolated from basemap IGN traffic) and
  // is cancelled by the next CANCEL_SLOPE_WORK if the viewport moves.
  //
  // `profile`: 'default' | 'terrain' — which demProfile to build against.
  // `tiles`: [{z,x,y}, ...] — viewport tiles to warm.
  if (e.data?.type === 'PREWARM_SLOPE') {
    const tiles = Array.isArray(e.data.tiles) ? e.data.tiles : [];
    const profile = e.data.profile === 'terrain' ? 'terrain' : 'default';
    const zone = typeof e.data.zone === 'string' ? e.data.zone : '';
    if (tiles.length === 0) return;
    try {
      if (typeof prewarmSlopeTiles === 'function') prewarmSlopeTiles(tiles, profile, zone);
    } catch { /* best-effort */ }
    return;
  }
  // ── Analysis zone (zone-gated terrain overlays) ─────────────────────
  // The page registers the polygon behind `?zone=<hash>` tile requests.
  // Re-sent on controllerchange (the registry dies with the SW instance).
  // An unknown hash in a tile URL degrades to an unmasked build — never an
  // error — so a restart race only costs trim fidelity, not tiles.
  if (e.data?.type === 'SET_ANALYSIS_ZONE') {
    try {
      const registered = registerAnalysisZone(e.data.hash, e.data.ring);
      if (!registered && e.data.hash) {
        console.warn('[sw-dem] SET_ANALYSIS_ZONE: invalid ring ignored', e.data.hash);
      }
    } catch { /* ignore */ }
    return;
  }
  if (e.data?.type === 'CLEAR_ANALYSIS_ZONE') {
    try { clearAnalysisZones(); } catch { /* ignore */ }
    return;
  }
});
