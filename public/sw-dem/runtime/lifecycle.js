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
//
// May 19 perf pass: CPU-adaptive — on machines with hardwareConcurrency≥8
// the composite stage is the next bottleneck after IGN sub-tile fetches
// land in bursts. Each composite call peaks at ~12 MB; ~10 concurrent on
// an 8-core box still keeps peak ≤120 MB while letting a 20-tile zoom-in
// land in one composite wave instead of two. Floor stays at 6 for low-end
// devices to preserve the original memory envelope.
const COMPOSITE_MAX_CONCURRENT = (() => {
  const hc = Number(globalThis.navigator?.hardwareConcurrency || 0);
  if (!Number.isFinite(hc) || hc <= 4) return 6;
  if (hc >= 12) return 10;
  if (hc >= 8) return 8;
  return 6;
})();

// ──────────────────────────────────────────────────────────────────────────
// DEM_HOT_CACHE — in-memory LRU of recently served DEM tile blobs.
//
// Motivation: every cache hit currently pays for `caches.open(CACHE_NAME)`
// (~1-5 ms) + `cache.match(key)` (~5-25 ms on disk-backed CacheStorage).
// On a single zoom-out a 60° pitched viewport at z14 needs ~25-50 tiles,
// and a satellite/topo style switch re-asks for ~150 tiles within a few
// hundred ms. Even when every tile is already cached on disk, the
// cumulative CacheStorage round-trip latency stacks into 0.5–2.5 s of
// pure I/O overhead on the SW thread — exactly the kind of stall that
// makes the user perceive "the map is dragging".
//
// This hot tier sits in FRONT of CacheStorage and returns a fresh Response
// (clone of the blob) in <1 ms. Hit ratios above 80 % are routine on a
// session where the user is zooming/panning inside the same region.
//
// Size budget: 192 entries × ~120 KB average terrain-RGB PNG ≈ 23 MB peak
// — trivial vs the 1 GB+ working set Mapbox itself keeps in WebGL textures.
//
// Eviction: classic Map-as-LRU. We re-insert on every get so the iteration
// order matches recency, then drop the oldest keys when the size cap is
// exceeded. No expiry — entries are invalidated by epoch bump (cache name
// changes → activate purges everything → hot cache survives but is just
// stale references that never get queried again because the cacheKey URL
// embeds the epoch via demProfile and PURGE messages call demHotClear).
// ──────────────────────────────────────────────────────────────────────────
const DEM_HOT_CACHE_MAX = 192;
const DEM_HOT_CACHE = new Map();

function demHotGet(keyStr) {
  const entry = DEM_HOT_CACHE.get(keyStr);
  if (!entry) return null;
  // Refresh LRU position
  DEM_HOT_CACHE.delete(keyStr);
  DEM_HOT_CACHE.set(keyStr, entry);
  return entry;
}

function demHotPut(keyStr, blob, headerInit) {
  if (!blob) return;
  if (DEM_HOT_CACHE.has(keyStr)) DEM_HOT_CACHE.delete(keyStr);
  DEM_HOT_CACHE.set(keyStr, { blob, headers: headerInit });
  if (DEM_HOT_CACHE.size > DEM_HOT_CACHE_MAX) {
    const drop = DEM_HOT_CACHE.size - Math.floor(DEM_HOT_CACHE_MAX * 0.85);
    const iter = DEM_HOT_CACHE.keys();
    for (let i = 0; i < drop; i++) {
      const k = iter.next().value;
      if (k === undefined) break;
      DEM_HOT_CACHE.delete(k);
    }
  }
}

function demHotClear() {
  DEM_HOT_CACHE.clear();
}

// Reconstruct a fresh Response from a hot-cache entry. Each call gets its
// own Response wrapper (cheap) backed by the SAME Blob (zero-copy on
// most engines — the renderer just bumps an internal ref count).
function demHotResponse(entry) {
  return new Response(entry.blob, { status: 200, headers: entry.headers });
}
let _compositeActive = 0;
const _compositeQueue = [];
const SLOPE_BUILD_BUSY_CONCURRENT = 2;
const SLOPE_BUILD_WARM_CONCURRENT = 4;
let _slopeBuildActive = 0;
const _slopeBuildQueue = [];
const ALTITUDE_BUILD_MAX_CONCURRENT = 2;
let _altitudeBuildActive = 0;
const _altitudeBuildQueue = [];

// In-flight slope tile dedup: key = `${profile}:${z}/${x}/${y}?${resFactor}` →
// Promise<Response>. Lets concurrent requests for the same tile share
// the single ongoing computation instead of duplicating the Horn pipeline.
const SLOPE_INFLIGHT = new Map();
const ALTITUDE_INFLIGHT = new Map();
let slopeCancelGeneration = 0;
let altitudeCancelGeneration = 0;

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

function detectSlopeBuildIdleConcurrency() {
  const hc = Number(globalThis.navigator?.hardwareConcurrency || 0);
  if (!Number.isFinite(hc) || hc <= 0) return 6;
  return Math.max(4, Math.min(12, Math.round(hc * 0.75)));
}

const SLOPE_BUILD_IDLE_CONCURRENT = detectSlopeBuildIdleConcurrency();

function currentSlopeBuildConcurrency() {
  const demPressure = DEM_INFLIGHT.size;
  if (demPressure >= 24) return SLOPE_BUILD_BUSY_CONCURRENT;
  if (demPressure >= 8) return Math.min(SLOPE_BUILD_IDLE_CONCURRENT, SLOPE_BUILD_WARM_CONCURRENT);
  return SLOPE_BUILD_IDLE_CONCURRENT;
}

function cancelSlopeWork() {
  slopeCancelGeneration += 1;
  const slopeCount = SLOPE_INFLIGHT.size;
  SLOPE_INFLIGHT.clear();
  while (_slopeBuildQueue.length > 0) {
    const queued = _slopeBuildQueue.shift();
    try { queued?.resolve(null); } catch { /* ignore */ }
  }
  try { if (typeof clearSlopeProcessingCaches === 'function') clearSlopeProcessingCaches(); } catch { /* ignore */ }
  return { slopeCount };
}

function cancelAltitudeWork() {
  altitudeCancelGeneration += 1;
  const altitudeCount = ALTITUDE_INFLIGHT.size;
  ALTITUDE_INFLIGHT.clear();
  while (_altitudeBuildQueue.length > 0) {
    const queued = _altitudeBuildQueue.shift();
    try { queued?.resolve(null); } catch { /* ignore */ }
  }
  return { altitudeCount };
}

function pumpAltitudeBuildQueue() {
  while (_altitudeBuildActive < ALTITUDE_BUILD_MAX_CONCURRENT && _altitudeBuildQueue.length > 0) {
    const entry = _altitudeBuildQueue.shift();
    if (!entry) break;
    if (entry.generation !== altitudeCancelGeneration) {
      entry.resolve(null);
      continue;
    }
    _altitudeBuildActive += 1;
    Promise.resolve()
      .then(() => entry.run())
      .then((result) => entry.resolve(result))
      .catch((error) => entry.reject(error))
      .finally(() => {
        _altitudeBuildActive = Math.max(0, _altitudeBuildActive - 1);
        pumpAltitudeBuildQueue();
      });
  }
}

function pumpSlopeBuildQueue() {
  while (_slopeBuildActive < currentSlopeBuildConcurrency() && _slopeBuildQueue.length > 0) {
    const entry = _slopeBuildQueue.shift();
    if (!entry) break;
    if (entry.generation !== slopeCancelGeneration) {
      entry.resolve(null);
      continue;
    }
    _slopeBuildActive += 1;
    Promise.resolve()
      .then(() => entry.run())
      .then((result) => entry.resolve(result))
      .catch((error) => entry.reject(error))
      .finally(() => {
        _slopeBuildActive = Math.max(0, _slopeBuildActive - 1);
        pumpSlopeBuildQueue();
      });
  }
}

function scheduleSlopeBuild(run, generation) {
  if (generation !== slopeCancelGeneration) return Promise.resolve(null);
  return new Promise((resolve, reject) => {
    _slopeBuildQueue.push({ run, generation, resolve, reject });
    pumpSlopeBuildQueue();
  });
}

function scheduleAltitudeBuild(run, generation) {
  if (generation !== altitudeCancelGeneration) return Promise.resolve(null);
  return new Promise((resolve, reject) => {
    _altitudeBuildQueue.push({ run, generation, resolve, reject });
    pumpAltitudeBuildQueue();
  });
}

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
    try { if (typeof clearSlopeProcessingCaches === 'function') clearSlopeProcessingCaches(); } catch { /* ignore */ }
    try { if (typeof clearAltitudeProcessingCaches === 'function') clearAltitudeProcessingCaches(); } catch { /* ignore */ }
    try { demHotClear(); } catch { /* ignore */ }
    purgeManagedMapCaches({ includeCurrent: true });
    return;
  }
  if (e.data?.type === 'CLEAR_DEM_CACHE') {
    try { if (typeof clearSlopeProcessingCaches === 'function') clearSlopeProcessingCaches(); } catch { /* ignore */ }
    try { if (typeof clearAltitudeProcessingCaches === 'function') clearAltitudeProcessingCaches(); } catch { /* ignore */ }
    try { demHotClear(); } catch { /* ignore */ }
    caches.delete(CACHE_NAME);
    return;
  }
  if (e.data?.type === 'CLEAR_SLOPE_CACHE') {
    try { if (typeof clearSlopeProcessingCaches === 'function') clearSlopeProcessingCaches(); } catch { /* ignore */ }
    caches.delete(SLOPE_CACHE_NAME);
    return;
  }
  if (e.data?.type === 'CANCEL_SLOPE_WORK') {
    const cancelled = cancelSlopeWork();
    // Free terrain-WMS IGN slots immediately so the basemap (default
    // DEM profile) doesn't have to wait up to IGN_FETCH_TIMEOUT_MS for
    // the slope-driven backlog to drain. Both purpose tags are exclusive
    // to the 1 m slope pipeline.
    let queuedTerrain = 0;
    let inflightTerrain = 0;
    try {
      queuedTerrain += typeof flushIGNQueueByPurpose === 'function' ? flushIGNQueueByPurpose('slope-visible') : 0;
      queuedTerrain += typeof flushIGNQueueByPurpose === 'function' ? flushIGNQueueByPurpose('slope-warm') : 0;
    } catch { /* ignore */ }
    try {
      inflightTerrain += typeof cancelInFlightIGNByPurpose === 'function' ? cancelInFlightIGNByPurpose('slope-visible') : 0;
      inflightTerrain += typeof cancelInFlightIGNByPurpose === 'function' ? cancelInFlightIGNByPurpose('slope-warm') : 0;
    } catch { /* ignore */ }
    // Drop in-flight DEM dedup entries scoped to the terrain profile.
    // Those entries are consumed exclusively by the slope pipeline (the
    // basemap uses demProfile='default'), so once the user disables
    // slope they're orphan promises holding ortho/composite resources
    // and blocking new basemap-profile DEM requests for the same tile
    // from re-entering the dispatcher cleanly. Removing them now lets
    // the next basemap fetch run unencumbered.
    let demDropped = 0;
    try {
      for (const key of Array.from(DEM_INFLIGHT.keys())) {
        if (typeof key === 'string' && key.indexOf('terrain:') === 0) {
          DEM_INFLIGHT.delete(key);
          demDropped++;
        }
      }
    } catch { /* ignore */ }
    if (DEBUG && (cancelled.slopeCount > 0 || queuedTerrain > 0 || inflightTerrain > 0 || demDropped > 0)) {
      console.warn(`[sw-dem][cancel-slope] slope=${cancelled.slopeCount} terrainQueued=${queuedTerrain} terrainInflight=${inflightTerrain} demInflightDropped=${demDropped}`);
    }
    return;
  }
  if (e.data?.type === 'CANCEL_ALTITUDE_WORK') {
    const cancelled = cancelAltitudeWork();
    if (DEBUG && cancelled.altitudeCount > 0) {
      console.warn(`[sw-dem][cancel-altitude] altitude=${cancelled.altitudeCount}`);
    }
    return;
  }
  if (e.data?.type === 'CLEAR_ALTITUDE_CACHE') {
    try { if (typeof clearAltitudeProcessingCaches === 'function') clearAltitudeProcessingCaches(); } catch { /* ignore */ }
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
});
