// ---------------------------------------------------------------------------
// Slope worker POOL — SW-side manager for the dedicated slope build workers.
//
// Spawns `min(hardwareConcurrency-1, SLOPE_POOL_MAX_WORKERS)` dedicated
// Workers (each runs slope-pool.worker.js). Exposes a single async entry
// point `computeSlopeViaPool(...)` that:
//   1. decodes the own DEM blob + the 4 cached neighbour DEM blobs on the
//      SW thread (these reads are needed to assemble the transferable
//      buffers anyway, and decodeTerrainRGBBlob is already memoised),
//   2. posts the job to a free worker (round-robin + backpressure),
//   3. awaits the transferable PNG ArrayBuffer,
//   4. cancels pending jobs when slopeCancelGeneration bumps.
//
// Returns `null` if the pool is unavailable or the job was cancelled —
// callers (slope-handler.js) fall back to the in-process path.
//
// The pool is created lazily on first use and re-created on demand if any
// worker errors out (workers are cheap, ~5 ms spawn). If the browser does
// not support `Worker` from a ServiceWorker context (rare, Firefox <105),
// every call transparently returns `null` and the in-process path runs.
//
// SLOPE_POOL_MAX_WORKERS / SLOPE_POOL_MIN_WORKERS are defined in
// /sw-dem/core/config.js (loaded earlier in sw-dem.js's importScripts
// chain). We reference them by global name here rather than redeclaring.
// ---------------------------------------------------------------------------

// Internal pool state. Lives in module scope so the SW reuses one pool
// across all slope requests.
let _slopeWorkers = null;            // Worker[]
let _slopeWorkerReady = null;        // boolean[] — worker accepted at least one job
let _slopeWorkerMonotonic = 0;       // round-robin counter
let _slopePoolDisabled = false;      // set true after a structural failure
const _slopeJobCallbacks = new Map(); // id → { resolve, reject }
let _slopeJobMonotonic = 0;

// ── Pre-work concurrency gate ─────────────────────────────────────────
// Before a job reaches a worker it must do SW-thread work: decode the own
// DEM + read/decode up to 4 neighbour DEMs from CacheStorage. Without a
// gate, a 90-tile viewport fires 90 handleSlopeRequest() events at once,
// each running its own decode burst in parallel — the SW event loop
// saturates and the basemap DEM/ortho fetch pipeline stalls for the
// first second+ of every zoom ("map freezes when slope is on"). Since
// the worker pool only has `poolSize` cores anyway, anything beyond
// `poolSize + 2` in-flight pre-work just queues in the decode cache
// without reaching a worker sooner. This semaphore caps the concurrent
// SW-side decode bursts so the SW thread stays responsive for basemap
// fetches in between.
let _slopePreWorkActive = 0;
const _slopePreWorkQueue = [];

function slopePreWorkConcurrency() {
  // Match the worker count (one pre-work burst per available worker,
  // plus a small buffer so a worker never sits idle waiting for the next
  // decode to finish). Falls back to 4 when the pool isn't sized yet.
  if (_slopeWorkers && _slopeWorkers.length > 0) return _slopeWorkers.length + 2;
  return 4;
}

function acquireSlopePreWork() {
  if (_slopePreWorkActive < slopePreWorkConcurrency()) {
    _slopePreWorkActive++;
    return Promise.resolve();
  }
  return new Promise((resolve) => _slopePreWorkQueue.push(resolve));
}

function releaseSlopePreWork() {
  _slopePreWorkActive = Math.max(0, _slopePreWorkActive - 1);
  if (_slopePreWorkQueue.length > 0 && _slopePreWorkActive < slopePreWorkConcurrency()) {
    _slopePreWorkActive++;
    _slopePreWorkQueue.shift()();
  }
}

function detectSlopePoolSize() {
  const hc = Number(globalThis.navigator?.hardwareConcurrency || 0);
  if (!Number.isFinite(hc) || hc <= 0) return SLOPE_POOL_MIN_WORKERS;
  // Reserve one core for the SW thread (network + cache + IGN scheduler).
  const target = Math.max(SLOPE_POOL_MIN_WORKERS, Math.min(SLOPE_POOL_MAX_WORKERS, hc - 1));
  return target;
}

function slopePoolWorkerURL() {
  const epoch = (typeof swModuleEpoch !== 'undefined' && swModuleEpoch)
    ? swModuleEpoch
    : (new URL(self.location.href).searchParams.get('rv-map-cache-epoch') || 'base');
  return `/sw-dem/workers/slope-pool.worker.js?rv-map-cache-epoch=${encodeURIComponent(epoch)}`;
}

function spawnSlopeWorker() {
  try {
    const worker = new Worker(slopePoolWorkerURL());
    worker.onmessage = (event) => {
      const msg = event.data;
      if (!msg || typeof msg !== 'object') return;
      const cb = _slopeJobCallbacks.get(msg.id);
      if (!cb) return;
      _slopeJobCallbacks.delete(msg.id);
      if (msg.ok) {
        cb.resolve({ png: msg.png, missingDirections: msg.missingDirections || [] });
      } else {
        cb.reject(new Error(`slope-worker: ${msg.error || 'unknown'}`));
      }
    };
    worker.onerror = (err) => {
      if (typeof DEBUG !== 'undefined' && DEBUG) console.warn('[slope-pool] worker error', err?.message || err);
      // Fail all in-flight jobs on this worker — they cannot complete.
      // (Each job id maps 1:1 to a worker in our round-robin, so we just
      // reject every pending callback; the SW caller falls back to inline.)
      for (const [id, cb] of _slopeJobCallbacks) {
        _slopeJobCallbacks.delete(id);
        cb.reject(new Error('slope-worker-died'));
      }
    };
    return worker;
  } catch (err) {
    if (typeof DEBUG !== 'undefined' && DEBUG) console.warn('[slope-pool] spawn failed, pool disabled', err?.message || err);
    return null;
  }
}

function ensureSlopePool() {
  if (_slopePoolDisabled) return null;
  if (_slopeWorkers && _slopeWorkers.length > 0) return _slopeWorkers;

  if (typeof Worker === 'undefined') {
    _slopePoolDisabled = true;
    return null;
  }

  const size = detectSlopePoolSize();
  const workers = [];
  for (let i = 0; i < size; i++) {
    const w = spawnSlopeWorker();
    if (!w) {
      _slopePoolDisabled = true;
      // Tear down any partially-spawned workers.
      for (const partial of workers) {
        try { partial.terminate(); } catch { /* ignore */ }
      }
      return null;
    }
    workers.push(w);
  }
  _slopeWorkers = workers;
  _slopeWorkerReady = workers.map(() => false);
  _slopeWorkerMonotonic = 0;
  return workers;
}

function pickSlopeWorker() {
  if (!_slopeWorkers || _slopeWorkers.length === 0) return -1;
  // Round-robin — each worker is stateless so any assignment is fine; we
  // just want to spread the CPU work evenly across cores.
  const n = _slopeWorkers.length;
  _slopeWorkerMonotonic = (_slopeWorkerMonotonic + 1) % n;
  return _slopeWorkerMonotonic;
}

function terminateSlopePool() {
  if (!_slopeWorkers) return;
  for (const w of _slopeWorkers) {
    try { w.terminate(); } catch { /* ignore */ }
  }
  _slopeWorkers = null;
  _slopeWorkerReady = null;
  for (const [, cb] of _slopeJobCallbacks) cb.reject(new Error('slope-pool-terminated'));
  _slopeJobCallbacks.clear();
}

// ── Cancel handling ───────────────────────────────────────────────────
// Called from lifecycle.js when slopeCancelGeneration bumps. We cannot
// interrupt a worker mid-job, but we CAN drop every pending callback so
// the SW caller sees the cancellation and returns a transparent tile.
// The worker finishes its current job in the background; the result is
// simply ignored (its callback is gone). This matches the in-process
// queue behaviour where cancelSlopeWork() resolves pending entries with
// null.
function cancelAllSlopePoolJobs() {
  let n = 0;
  for (const [, cb] of _slopeJobCallbacks) {
    cb.resolve(null); // null == "cancelled" — caller treats as transparent
    n++;
  }
  _slopeJobCallbacks.clear();
  return n;
}

// ── Decode neighbours using the SW's memoised decoder ─────────────────
// Resolves the 4 cardinal neighbour DEM blobs from demCache and decodes
// them via the tile-coord-keyed LRU (decodeSlopeDemBlob from slope.js),
// so adjacent slope tiles share decoded elevations instead of each
// re-decoding the same neighbour. Returns a {north,east,south,west} map
// of Float32Array (or null where missing).
//
// Mirrors slope.js > cachedElev but kept here so the pool module owns the
// full "assemble transferable inputs" step.
function buildSlopePoolCachePath(z, x, y, demProfile) {
  return demProfile === 'terrain'
    ? `/dem-tiles/${z}/${x}/${y}?rv-dem-profile=terrain`
    : `/dem-tiles/${z}/${x}/${y}`;
}

function shouldUseSlopeNeighbourDem(resp, demProfile) {
  if (!resp || resp.status !== 200) return false;
  const health = (resp.headers.get('X-DEM-Health') || 'ok').toLowerCase();
  if (health !== 'ok') return false;
  const source = (resp.headers.get('X-DEM-Source') || '').toLowerCase();
  if (!source) return true;
  if (
    source.startsWith('aws-emergency')
    || source.startsWith('mapbox')
    || source.startsWith('overzoom')
  ) {
    return false;
  }
  if (demProfile === 'terrain' && source.startsWith('aws-terrarium')) return false;
  return true;
}

function isValidSlopeTileCoord(z, x, y) {
  const n = 1 << z;
  return x >= 0 && y >= 0 && x < n && y < n;
}

async function resolveAndDecodeNeighbours(z, x, y, demCache, demProfile) {
  const out = { north: null, east: null, south: null, west: null };
  const missing = [];
  if (!demCache) {
    return { neighbours: out, missing: ['north', 'east', 'south', 'west'] };
  }

  const fetchOne = async (direction, nx, ny) => {
    if (!isValidSlopeTileCoord(z, nx, ny)) {
      missing.push(direction);
      return;
    }
    try {
      const resp = await demCache.match(new Request(buildSlopePoolCachePath(z, nx, ny, demProfile)));
      if (!shouldUseSlopeNeighbourDem(resp, demProfile)) {
        missing.push(direction);
        return;
      }
      const blob = await resp.clone().blob();
      // Use the tile-coord-keyed LRU (decodeSlopeDemBlob from slope.js),
      // NOT the blob-identity WeakMap (decodeTerrainRGBBlob). The LRU is
      // shared across the whole slope pipeline: tile B's "north" neighbour
      // is tile A's own DEM, and it was already decoded when A built — so
      // the decode is a free LRU hit instead of a fresh 8-20 ms decode on
      // the SW thread. On a 90-tile viewport this collapses ~360 redundant
      // neighbour decodes back to ~90 unique ones.
      out[direction] = await decodeSlopeDemBlob(blob, z, nx, ny, demProfile);
    } catch {
      missing.push(direction);
    }
  };

  await Promise.all([
    fetchOne('north', x, y - 1),
    fetchOne('east',  x + 1, y),
    fetchOne('south', x, y + 1),
    fetchOne('west',  x - 1, y),
  ]);

  return { neighbours: out, missing };
}

// ── Public entry: compute one slope tile via the pool ─────────────────
//
//   demBlob        own DEM tile blob (the one already fetched + cached)
//   demCache       caches.open(CACHE_NAME) — borrowed for neighbour reads
//   z, x, y        tile coords
//   resFactor      1 = fast path, >1 = legacy downsample
//   demProfile     'default' | 'terrain'
//   generation     slopeCancelGeneration snapshot — job auto-cancels if it
//                  no longer matches by the time the worker replies.
//
// Returns:
//   { blob: Blob, missingDirections: string[] } — ready to wrap into a Response
//   null — cancelled (generation mismatch) or pool unavailable; caller
//          MUST fall back to the in-process buildSlopeTile() path.
async function computeSlopeViaPool(demBlob, demCache, z, x, y, resFactor, demProfile, generation) {
  const workers = ensureSlopePool();
  if (!workers) return null;

  // Cancel check BEFORE expensive decode work.
  if (typeof slopeCancelGeneration !== 'undefined' && generation !== slopeCancelGeneration) {
    return null;
  }

  // Acquire a pre-work slot so we don't run 90 SW-thread decode bursts in
  // parallel (one per slope tile in the viewport). This is what keeps the
  // basemap DEM/ortho pipeline responsive while slope builds. Re-check the
  // cancel generation after acquiring — a queued job whose viewport moved
  // should bail without doing the work.
  await acquireSlopePreWork();
  try {
    if (typeof slopeCancelGeneration !== 'undefined' && generation !== slopeCancelGeneration) {
      return null;
    }

    // Decode own elevations on the SW thread. Use the tile-coord-keyed LRU
    // (decodeSlopeDemBlob) so the decoded array is shared with the neighbour
    // lookups of the adjacent slope tiles — every tile is someone's
    // neighbour, and a 90-tile viewport becomes ~90 unique decodes instead
    // of ~450.
    let ownElev;
    try {
      ownElev = await decodeSlopeDemBlob(demBlob, z, x, y, demProfile);
    } catch {
      return null;
    }
    if (typeof slopeCancelGeneration !== 'undefined' && generation !== slopeCancelGeneration) {
      return null;
    }

    // Resolve + decode the 4 cardinal neighbours from the DEM cache.
    const { neighbours, missing } = await resolveAndDecodeNeighbours(z, x, y, demCache, demProfile);
    if (typeof slopeCancelGeneration !== 'undefined' && generation !== slopeCancelGeneration) {
      return null;
    }

    // Build transferable buffers. Each Float32Array.buffer is transferred
    // (zero copy) — the SW no longer owns them after postMessage. Since the
    // own/decoded-elev caches share these underlying buffers, we MUST copy
    // before transfer so the SW's caches stay valid for the next tile.
    // (decodeSlopeDemBlob returns a SHARED Float32Array per tile coord; if
    // we transferred the underlying buffer, the next consumer of the same
    // tile would see a detached array. Copy is 256 KB → ~0.1 ms.)
    const ownCopy = ownElev.slice().buffer;
    const neighbourCopies = {};
    const transferList = [ownCopy];
    for (const dir of ['north', 'east', 'south', 'west']) {
      if (neighbours[dir]) {
        const c = neighbours[dir].slice().buffer;
        neighbourCopies[dir] = c;
        transferList.push(c);
      }
    }

    const workerIdx = pickSlopeWorker();
    if (workerIdx < 0) return null;
    const worker = workers[workerIdx];

    const id = ++_slopeJobMonotonic;
    const jobPromise = new Promise((resolve, reject) => {
      _slopeJobCallbacks.set(id, { resolve, reject });
    });

    worker.postMessage(
      {
        id, z, x, y,
        resFactor: Number(resFactor) > 1 ? Number(resFactor) : 1,
        ownElev: ownCopy,
        neighbours: neighbourCopies,
      },
      transferList,
    );
    let result;
    try {
      result = await jobPromise;
    } catch {
      return null;
    }
    if (!result) return null; // cancelled

    // Generation check on the way out — if the viewport moved while we were
    // waiting, drop the result.
    if (typeof slopeCancelGeneration !== 'undefined' && generation !== slopeCancelGeneration) {
      return null;
    }

    // Wrap the returned ArrayBuffer into a PNG Blob.
    const blob = new Blob([result.png], { type: 'image/png' });

    // Merge missing-direction reports: directions missing from the cache
    // are always reported; the worker may also report its own (should be
    // identical because we pre-decoded, but be defensive).
    const seen = new Set(missing);
    for (const d of result.missingDirections || []) seen.add(d);

    return { blob, missingDirections: Array.from(seen) };
  } finally {
    releaseSlopePreWork();
  }
}

// Expose hooks for lifecycle.js to call on cancel / teardown.
// (Plain function declarations — these files are importScripts'd into the
// SW global scope, so they're already global; the references below just
// make the intent explicit for readers.)
