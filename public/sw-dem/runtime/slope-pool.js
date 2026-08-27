// ---------------------------------------------------------------------------
// Slope + Altitude worker POOL — SW-side manager for the dedicated build
// workers (a single shared pool serves BOTH overlays).
//
// Spawns `min(hardwareConcurrency-1, SLOPE_POOL_MAX_WORKERS)` dedicated
// Workers (each runs slope-pool.worker.js). A SHARED pool (rather than one
// pool per overlay) caps total worker count at the hardware budget — two
// independent pools of up to 8 each would oversubscribe an 8-core box and
// thrash when both overlays are active simultaneously. Each job is tagged
// `kind: 'slope' | 'altitude'` so a cancel on one overlay never kills the
// other's in-flight jobs.
//
// Exposes two async entry points:
//   * computeSlopeViaPool(...)  — own DEM + up to 4 neighbour DEMs → slope PNG
//   * computeAltitudeViaPool(...) — own DEM only → altitude PNG
// Both:
//   1. read the own (and for slope, neighbour) DEM blob(s) from CacheStorage
//      on the SW thread (cheap — the hot tier makes most of these <1 ms),
//   2. TRANSFER the raw PNG bytes to a free worker — the worker decodes
//      them itself, so the heavy createImageBitmap + getImageData + Float32
//      loop runs OFF the SW thread,
//   3. await the transferable PNG ArrayBuffer,
//   4. cancel pending jobs (per kind) when the matching cancelGeneration bumps.
//
// Returns `null` if the pool is unavailable or the job was cancelled —
// callers (slope-handler.js / altitude-handler.js) fall back to the
// in-process path.
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
// across all slope/altitude requests.
let _slopeWorkers = null;            // Worker[]
let _slopeWorkerReady = null;        // boolean[] — worker accepted at least one job
let _slopeWorkerMonotonic = 0;       // round-robin counter
let _slopePoolDisabled = false;      // set true after a structural failure
// id → { resolve, reject, kind } — `kind` lets cancel target one overlay only.
const _slopeJobCallbacks = new Map();
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
  // The SW-thread work per slot is now just CacheStorage matches + a
  // postMessage (no DEM decode — that moved into the worker). That's
  // mostly I/O-bound, so we can run more slots in parallel than we have
  // workers without saturating the SW event loop. 2× the worker count
  // keeps the workers fed while the SW pipelines the next batch of cache
  // reads. Falls back to 6 when the pool isn't sized yet.
  if (_slopeWorkers && _slopeWorkers.length > 0) return _slopeWorkers.length * 2;
  return 6;
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
        if (cb.kind === 'altitude') {
          // Altitude jobs return a single PNG ArrayBuffer + no neighbours.
          cb.resolve({ png: msg.png });
        } else {
          cb.resolve({ png: msg.png, missingDirections: msg.missingDirections || [] });
        }
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

// ── Cancel handling (per-kind) ────────────────────────────────────────
// Called from lifecycle.js when slopeCancelGeneration / altitudeCancelGeneration
// bumps. We cannot interrupt a worker mid-job, but we CAN drop every pending
// callback tagged to that kind so the SW caller sees the cancellation and
// returns a transparent tile. The worker finishes its current job in the
// background; the result is simply ignored (its callback is gone). The OTHER
// overlay's jobs are left untouched — a cancel must never cross overlays
// (disabling slope must not kill altitude builds the user still wants).
function cancelPoolJobsByKind(kind) {
  let n = 0;
  for (const [id, cb] of _slopeJobCallbacks) {
    if (cb.kind !== kind) continue;
    if (cb.uncancellable) continue;
    _slopeJobCallbacks.delete(id);
    cb.resolve(null); // null == "cancelled" — caller treats as transparent
    n++;
  }
  return n;
}

function cancelAllSlopePoolJobs() {
  return cancelPoolJobsByKind('slope');
}

function cancelAllAltitudePoolJobs() {
  return cancelPoolJobsByKind('altitude');
}

// ── Resolve neighbour DEM BLOBS (no decode) ───────────────────────────
// Returns the raw Terrain-RGB PNG bytes for each cardinal neighbour that's
// present in the DEM cache and passes the source/health gate. The actual
// decode (createImageBitmap + getImageData + Float32 loop, 8-20 ms each)
// happens IN THE WORKER, not here — that's the whole point of the pool.
// The SW only pays the CacheStorage match (5-25 ms, mostly I/O) per
// neighbour, which is unavoidable because we need the bytes to transfer.
function buildSlopePoolCachePath(z, x, y, demProfile) {
  return demProfile === 'terrain'
    ? `/dem-tiles/${z}/${x}/${y}?rv-dem-profile=terrain`
    : `/dem-tiles/${z}/${x}/${y}`;
}

function shouldUseSlopeNeighbourDem(resp, demProfile) {
  if (!resp) return false;
  if (typeof resp.status === 'number' && resp.status !== 200) return false;
  const getHeader = (name) => {
    if (typeof resp.headers?.get === 'function') return resp.headers.get(name);
    if (Array.isArray(resp.headers)) {
      const entry = resp.headers.find(([k]) => k.toLowerCase() === name.toLowerCase());
      return entry ? entry[1] : null;
    }
    return null;
  };
  const health = (getHeader('X-DEM-Health') || 'ok').toLowerCase();
  if (health !== 'ok') return false;
  const source = (getHeader('X-DEM-Source') || '').toLowerCase();
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

async function resolveNeighbourBlobs(z, x, y, demCache, demProfile) {
  const out = { north: null, east: null, south: null, west: null };
  const missing = [];
  if (!demCache) {
    return { blobs: out, missing: ['north', 'east', 'south', 'west'] };
  }

  const fetchOne = async (direction, nx, ny) => {
    if (!isValidSlopeTileCoord(z, nx, ny)) {
      missing.push(direction);
      return;
    }
    const path = buildSlopePoolCachePath(z, nx, ny, demProfile);
    // 1. Fast in-memory hit from DEM_HOT_CACHE (avoids disk CacheStorage round-trip)
    if (typeof demHotGet === 'function') {
      const hot = demHotGet(path);
      if (hot && hot.blob) {
        if (shouldUseSlopeNeighbourDem(hot, demProfile)) {
          try {
            out[direction] = await hot.blob.arrayBuffer();
            return;
          } catch {
            /* fall through to disk cache */
          }
        } else {
          missing.push(direction);
          return;
        }
      }
    }

    // 2. Disk CacheStorage match
    try {
      const resp = await demCache.match(new Request(path));
      if (!shouldUseSlopeNeighbourDem(resp, demProfile)) {
        missing.push(direction);
        return;
      }
      // Grab ArrayBuffer directly without redundant response.clone()
      out[direction] = await resp.arrayBuffer();
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

  return { blobs: out, missing };
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
//   zoneRing       optional [[lng, lat], …] analysis-zone ring — the worker
//                  rasterizes it into an alpha mask (see slope-math.js).
//
// Returns:
//   { blob: Blob, missingDirections: string[] } — ready to wrap into a Response
//   null — cancelled (generation mismatch) or pool unavailable; caller
//          MUST fall back to the in-process buildSlopeTile() path.
//
// SW-thread work done here: CacheStorage match for neighbours + 1
// arrayBuffer() on the own blob + postMessage. NO createImageBitmap, NO
// getImageData, NO Float32 decode loop — all of that moved into the worker.
async function computeSlopeViaPool(demBlob, demCache, z, x, y, resFactor, demProfile, generation, zoneRing) {
  const workers = ensureSlopePool();
  if (!workers) return null;

  const isCancelled = () => generation !== null && generation !== undefined && typeof slopeCancelGeneration !== 'undefined' && generation !== slopeCancelGeneration;

  // Cancel check BEFORE expensive work.
  if (isCancelled()) {
    return null;
  }

  // Acquire a pre-work slot. Even though we no longer decode on the SW
  // thread, the CacheStorage matches (5-25 ms each × 5 tiles = up to 125 ms)
  // still happen here and would saturate the SW event loop if 90 tiles did
  // them in parallel. The gate keeps the SW responsive for basemap fetches.
  await acquireSlopePreWork();
  try {
    if (isCancelled()) {
      return null;
    }

    // Grab the own DEM bytes (transferable). We do NOT decode here.
    let ownDemBuf;
    try {
      ownDemBuf = await demBlob.arrayBuffer();
    } catch {
      return null;
    }
    if (isCancelled()) {
      return null;
    }

    // Resolve neighbour DEM blobs from the cache. Each is a raw PNG
    // ArrayBuffer ready to transfer.
    const { blobs: neighbourBlobs, missing } = await resolveNeighbourBlobs(z, x, y, demCache, demProfile);
    if (isCancelled()) {
      return null;
    }

    // Build the transfer list: own + every present neighbour. All are
    // transferred (zero copy) — the SW loses ownership until the worker
    // returns. We hold no reference to these bytes after postMessage.
    const transferList = [ownDemBuf];
    const neighbourMsg = {};
    for (const dir of ['north', 'east', 'south', 'west']) {
      if (neighbourBlobs[dir]) {
        neighbourMsg[dir] = neighbourBlobs[dir];
        transferList.push(neighbourBlobs[dir]);
      }
    }

    const workerIdx = pickSlopeWorker();
    if (workerIdx < 0) return null;
    const worker = workers[workerIdx];

    const id = ++_slopeJobMonotonic;
    const jobPromise = new Promise((resolve, reject) => {
      _slopeJobCallbacks.set(id, {
        resolve,
        reject,
        kind: 'slope',
        uncancellable: generation === null || generation === undefined,
      });
    });

    worker.postMessage(
      {
        id, kind: 'slope', z, x, y,
        resFactor: Number(resFactor) > 1 ? Number(resFactor) : 1,
        ownDem: ownDemBuf,
        neighbours: neighbourMsg,
        zoneRing: zoneRing || null,
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
    if (isCancelled()) {
      return null;
    }

    // Wrap the returned ArrayBuffer into a PNG Blob.
    const blob = new Blob([result.png], { type: 'image/png' });

    // Merge missing-direction reports: directions missing from the cache
    // are always reported; the worker may also report its own (decode
    // failures).
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

// ── Altitude entry: compute one altitude tile via the pool ───────────────
//
//   demBlob        own DEM tile blob (already fetched + cached)
//   z, x, y        tile coords
//   generation     altitudeCancelGeneration snapshot — job auto-cancels if it
//                  no longer matches by the time the worker replies.
//   zoneRing       optional [[lng, lat], …] analysis-zone ring (alpha mask)
//
// Returns:
//   { blob: Blob } — altitude PNG ready to wrap into a Response
//   null — cancelled (generation mismatch) or pool unavailable; caller
//          MUST fall back to the in-process buildAltitudeTile() path.
//
// Altitude only needs its OWN DEM (no seam-padding neighbours), so the
// SW-thread work per job is minimal: one arrayBuffer() + one postMessage.
// We still gate it so a 90-tile viewport doesn't fire 90 arrayBuffer() calls
// in a single tick and starve the basemap pipeline — but the gate is wider
// than slope's (3× pool size) because each slot does ~1/5 the I/O of a
// slope slot (1 DEM read vs 5).
//
// Pre-work concurrency for altitude. Falls back to 9 when the pool isn't
// sized yet (3× the slope fallback of 6 ≈ same ratio).
function altitudePreWorkConcurrency() {
  if (_slopeWorkers && _slopeWorkers.length > 0) return _slopeWorkers.length * 3;
  return 9;
}

let _altitudePreWorkActive = 0;
const _altitudePreWorkQueue = [];

function acquireAltitudePreWork() {
  if (_altitudePreWorkActive < altitudePreWorkConcurrency()) {
    _altitudePreWorkActive++;
    return Promise.resolve();
  }
  return new Promise((resolve) => _altitudePreWorkQueue.push(resolve));
}

function releaseAltitudePreWork() {
  _altitudePreWorkActive = Math.max(0, _altitudePreWorkActive - 1);
  if (_altitudePreWorkQueue.length > 0 && _altitudePreWorkActive < altitudePreWorkConcurrency()) {
    _altitudePreWorkActive++;
    _altitudePreWorkQueue.shift()();
  }
}

async function computeAltitudeViaPool(demBlob, z, x, y, generation, zoneRing) {
  const workers = ensureSlopePool();
  if (!workers) return null;

  // Cancel check BEFORE expensive work.
  if (typeof altitudeCancelGeneration !== 'undefined' && generation !== altitudeCancelGeneration) {
    return null;
  }

  await acquireAltitudePreWork();
  try {
    if (typeof altitudeCancelGeneration !== 'undefined' && generation !== altitudeCancelGeneration) {
      return null;
    }

    // Grab the own DEM bytes (transferable). We do NOT decode here.
    let ownDemBuf;
    try {
      ownDemBuf = await demBlob.arrayBuffer();
    } catch {
      return null;
    }
    if (typeof altitudeCancelGeneration !== 'undefined' && generation !== altitudeCancelGeneration) {
      return null;
    }

    const workerIdx = pickSlopeWorker();
    if (workerIdx < 0) return null;
    const worker = workers[workerIdx];

    const id = ++_slopeJobMonotonic;
    const jobPromise = new Promise((resolve, reject) => {
      _slopeJobCallbacks.set(id, { resolve, reject, kind: 'altitude' });
    });

    worker.postMessage(
      { id, kind: 'altitude', z, x, y, ownDem: ownDemBuf, zoneRing: zoneRing || null },
      [ownDemBuf],
    );

    let result;
    try {
      result = await jobPromise;
    } catch {
      return null;
    }
    if (!result) return null; // cancelled

    if (typeof altitudeCancelGeneration !== 'undefined' && generation !== altitudeCancelGeneration) {
      return null;
    }

    // Wrap the returned ArrayBuffer into a PNG Blob.
    const blob = new Blob([result.png], { type: 'image/png' });
    return { blob };
  } finally {
    releaseAltitudePreWork();
  }
}
