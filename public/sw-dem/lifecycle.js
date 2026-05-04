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

// Cache versions we want to purge on activation. Any old/stale name lands here.
const OLD_CACHES = [
  'dem-tiles-v1', 'dem-tiles-v2', 'dem-tiles-v3', 'dem-tiles-v4',
  'dem-tiles-v5', 'dem-tiles-v6', 'dem-tiles-v7', 'dem-tiles-v8',
  'dem-tiles-v9', 'dem-tiles-v10', 'dem-tiles-v11', 'dem-tiles-v12',
  'dem-tiles-v13', 'dem-tiles-v14', 'dem-tiles-v15', 'dem-tiles-v16',
  'dem-tiles-v17', 'dem-tiles-v18', 'dem-tiles-v19', 'dem-tiles-v20',
  'dem-tiles-v21', 'dem-tiles-v22', 'dem-tiles-v23', 'dem-tiles-v24',
  'dem-tiles-v25', 'dem-tiles-v26', 'dem-tiles-v27', 'dem-tiles-v28',
  'dem-tiles-v29',
  'dem-tiles-v30',
  'dem-tiles-v31',
  'dem-tiles-v32',
  'dem-tiles-v33',
  'dem-tiles-v34',
  'dem-tiles-v35',
  'dem-tiles-v36',
  'dem-tiles-v37',
  'dem-tiles-v38',
  'dem-tiles-v39',
  'dem-tiles-v40',
  'dem-tiles-v41',
  'dem-tiles-v42',
  'dem-tiles-v43',
  'dem-negative-v1', 'dem-negative-v2', 'dem-negative-v3',
  'dem-negative-v4', 'dem-negative-v5', 'dem-negative-v6',
  'dem-negative-v7', 'dem-negative-v8', 'dem-negative-v9',
  'dem-negative-v10', 'dem-negative-v11', 'dem-negative-v12',
  'dem-negative-v13', 'dem-negative-v14', 'dem-negative-v15',
  'dem-negative-v16',
  'dem-negative-v17',
  'dem-negative-v18',
  'dem-negative-v19',
  'dem-negative-v20',
  'dem-negative-v21',
  'dem-negative-v22',
  'dem-negative-v23',
  'dem-negative-v24',
  'dem-negative-v25',
  'ortho-tiles-v1', 'ortho-tiles-v2', 'ortho-tiles-v3', 'ortho-tiles-v4',
  'ortho-tiles-v5', 'ortho-tiles-v6', 'ortho-tiles-v7', 'ortho-tiles-v8',
  'slope-tiles-v1', 'slope-tiles-v2', 'slope-tiles-v3', 'slope-tiles-v4', 'slope-tiles-v5', 'slope-tiles-v6', 'slope-tiles-v7', 'slope-tiles-v8',
  'slope-tiles-v9', 'slope-tiles-v10', 'slope-tiles-v11', 'slope-tiles-v12',
  'shadow-tiles-v1',
];

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
    caches.keys()
      .then((keys) => Promise.all(
        keys.filter((k) => OLD_CACHES.includes(k)).map((k) => caches.delete(k))
      ))
      .then(() => self.clients.claim())
  );
});

self.addEventListener('message', (e) => {
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
});
