// ---------------------------------------------------------------------------
// SW Lifecycle + composite-pipeline concurrency limiter
//
// Split out of sw-dem.js (May 03) to keep the entry point a thin loader and
// give each pipeline concern its own debuggable file. Globals live here:
//   - OLD_CACHES               (legacy cache-name purge list)
//   - install/activate/message (skipWaiting, claim, manual cache busting)
//   - acquireComposite/release (memory cap on concurrent IGN/Mapbox blends)
//   - SLOPE_INFLIGHT / ALTITUDE_INFLIGHT  (per-tile request coalescing)
// ---------------------------------------------------------------------------

// Composite concurrency limiter — caps peak memory from simultaneous blends.
// Raised from 2 → 6: compositeIGNMapbox uses ≤2 MB per call (2× Float32(256²)
// + a 512² Mapbox elev array) so 6 concurrent ≈ 12 MB — trivial. With 2 we
// bottlenecked every zoom-in: a 20-tile viewport queued 10 composite cycles
// of 300–500 ms each = 5 s wall-clock of pipeline pressure, causing
// soft-deadline overflow downstream.
const COMPOSITE_MAX_CONCURRENT = 6;
let _compositeActive = 0;
const _compositeQueue = [];

// In-flight slope tile dedup: key = `${profile}:${z}/${x}/${y}?${resFactor}` →
// Promise<Response>. Lets concurrent requests for the same tile share
// the single ongoing computation instead of duplicating the Horn pipeline.
const SLOPE_INFLIGHT = new Map();
const ALTITUDE_INFLIGHT = new Map();

// In-flight DEM tile dedup. Same idea as SLOPE_INFLIGHT but applies to the
// raw `/dem-tiles/...` endpoint. Without this, every slope tile triggers
// 4 neighbour DEM rebuilds (see slope-handler.js) — for a 90-tile viewport
// that's ~450 concurrent handleDemRequest calls, many for the SAME tile.
// Each one of those duplicates runs the whole IGN/Swiss/Mapbox dispatcher
// (HTTP fetches, composite, health-guard) and then writes the same blob to
// the cache. The duplicate work is a major reason the Pentes pill stalled
// at ~85 % on cold viewport — the SW pipeline gets so saturated that some
// slope responses miss the Mapbox tile-load deadline and never fire
// `sourcedata`. Coalescing collapses the 5×-fan-out back to 1 per tile.
const DEM_INFLIGHT = new Map();

function acquireComposite() {
  if (_compositeActive < COMPOSITE_MAX_CONCURRENT) {
    _compositeActive++;
    return Promise.resolve();
  }
  return new Promise((resolve) => _compositeQueue.push(resolve));
}
function releaseComposite() {
  _compositeActive--;
  if (_compositeQueue.length > 0) {
    _compositeActive++;
    _compositeQueue.shift()();
  }
}

const MAP_CACHE_PREFIXES = [
  'dem-tiles-',
  'dem-negative-',
  'ortho-tiles-',
  'slope-tiles-',
  'altitude-tiles-',
  'shadow-tiles-',
  'dem-static-',
];

const CURRENT_MAP_CACHE_NAMES = new Set([
  CACHE_NAME,
  NEGATIVE_CACHE_NAME,
  ORTHO_CACHE_NAME,
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

self.addEventListener('install', (e) => {
  e.waitUntil(
    caches.open(STATIC_CACHE_NAME)
      .then((cache) => cache.add('/france-border.json'))
      .then(() => ensureFrancePoly())
      .then(() => self.skipWaiting())
  );
});

self.addEventListener('activate', (e) => {
  e.waitUntil(
    purgeManagedMapCaches()
      .then(() => self.clients.claim())
  );
});

self.addEventListener('message', (e) => {
  if (e.data?.type === 'PURGE_MAP_CACHES') {
    purgeManagedMapCaches({ includeCurrent: true });
    return;
  }
  if (e.data?.type === 'CLEAR_DEM_CACHE') {
    caches.delete(CACHE_NAME);
    return;
  }
  if (e.data?.type === 'CLEAR_SLOPE_CACHE') {
    caches.delete(SLOPE_CACHE_NAME);
    return;
  }
  if (e.data?.type === 'CLEAR_ALTITUDE_CACHE') {
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
  // Drain queued IGN + Ortho fetches AND abort their in-flight HTTP
  // requests on user gesture (zoomstart/movestart). Without aborting
  // in-flight, the new viewport's burst still waits up to 15 s for the
  // 40 IGN concurrency slots (occupied by previous viewport's pending
  // fetches) to free one-by-one — visible as "burst then nothing then
  // burst" loading after a dezoom. The abortable controllers carry
  // USER_CANCEL_REASON so the per-fetch catch handlers skip negative
  // caching for tiles WE just killed (a re-request issued moments
  // later for the new — often overlapping — viewport must hit the
  // network, not a transient null entry).
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
    const tilePath = `/${z}/${x}/${y}`;
    Promise.all([
      caches.open(SLOPE_CACHE_NAME).then((cache) => cache.keys().then((keys) => {
        return Promise.all(keys
          .filter((req) => {
            try { return new URL(req.url).pathname === `/slope-tiles${tilePath}`; }
            catch { return false; }
          })
          .map((req) => cache.delete(req)));
      })),
      caches.open(ALTITUDE_CACHE_NAME).then((cache) => cache.keys().then((keys) => {
        return Promise.all(keys
          .filter((req) => {
            try { return new URL(req.url).pathname === `/altitude-tiles${tilePath}`; }
            catch { return false; }
          })
          .map((req) => cache.delete(req)));
      })),
    ]).catch(() => { /* best-effort */ });
    return;
  }
});
