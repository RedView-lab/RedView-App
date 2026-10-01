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
//   1. take DEM blobs the caller already resolved (slope neighbours come from
//      resolveSlopeNeighbourDems() in slope-lidar-dem.js),
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
// id → { resolve, reject, kind, workerIdx } — `kind` lets cancel target one overlay only.
const _slopeJobCallbacks = new Map();
const _workerActiveJobs = new Map(); // workerIdx → active count
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
      if (typeof cb.workerIdx === 'number') {
        const c = _workerActiveJobs.get(cb.workerIdx) || 0;
        _workerActiveJobs.set(cb.workerIdx, Math.max(0, c - 1));
      }
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
      for (const [id, cb] of _slopeJobCallbacks) {
        _slopeJobCallbacks.delete(id);
        cb.reject(new Error('slope-worker-died'));
      }
      _workerActiveJobs.clear();
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
  // Least-busy dispatch: select the worker with the fewest active jobs
  let minIdx = 0;
  let minCount = _workerActiveJobs.get(0) || 0;
  for (let i = 1; i < _slopeWorkers.length; i++) {
    const c = _workerActiveJobs.get(i) || 0;
    if (c < minCount) {
      minCount = c;
      minIdx = i;
    }
  }
  _workerActiveJobs.set(minIdx, minCount + 1);
  return minIdx;
}

function terminateSlopePool() {
  if (!_slopeWorkers) return;
  for (const w of _slopeWorkers) {
    try { w.terminate(); } catch { /* ignore */ }
  }
  _slopeWorkers = null;
  _slopeWorkerReady = null;
  _workerActiveJobs.clear();
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
    if (typeof cb.workerIdx === 'number') {
      const c = _workerActiveJobs.get(cb.workerIdx) || 0;
      _workerActiveJobs.set(cb.workerIdx, Math.max(0, c - 1));
    }
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

// ── Public entry: compute one slope tile via the pool ─────────────────
//
//   demBlob         own DEM tile blob
//   neighbourBlobs  { north, east, south, west } DEM blobs already resolved
//                   by resolveSlopeNeighbourDems() (null when absent)
//   z, x, y         tile coords
//   resFactor       1 = normal, >1 = legacy block-average
//   generation      slopeCancelGeneration snapshot, or null (uncancellable)
//   zoneRing        optional [[lng, lat], …] analysis-zone ring
//   outputScale     1 = native DEM resolution, 2 = 2× Catmull-Rom
//
// Returns { blob, missingDirections } — or null when the pool is unavailable
// or the job was cancelled; the caller then runs the in-process path.
//
// SW-thread work: one arrayBuffer() per blob + postMessage. Decode, Horn,
// upsample and PNG encode all run in the worker.
async function computeSlopeViaPool(demBlob, neighbourBlobs, z, x, y, resFactor, generation, zoneRing, outputScale = 1) {
  const workers = ensureSlopePool();
  if (!workers) return null;

  const isCancelled = () => generation !== null && generation !== undefined && typeof slopeCancelGeneration !== 'undefined' && generation !== slopeCancelGeneration;
  if (isCancelled()) return null;

  await acquireSlopePreWork();
  // Released once, either right after the transfer or on an early exit (a
  // second release used to hand out one extra slot per tile).
  let preWorkHeld = true;
  const releasePreWork = () => {
    if (!preWorkHeld) return;
    preWorkHeld = false;
    releaseSlopePreWork();
  };
  try {
    if (isCancelled()) return null;

    // Own + neighbour bytes, all TRANSFERRED (zero copy) to the worker.
    const directions = ['north', 'east', 'south', 'west'];
    let ownDemBuf;
    let neighbourBufs;
    try {
      [ownDemBuf, ...neighbourBufs] = await Promise.all([
        demBlob.arrayBuffer(),
        ...directions.map((dir) => (neighbourBlobs?.[dir] ? neighbourBlobs[dir].arrayBuffer() : null)),
      ]);
    } catch {
      return null;
    }
    if (isCancelled()) return null;

    const transferList = [ownDemBuf];
    const neighbourMsg = {};
    directions.forEach((dir, i) => {
      if (!neighbourBufs[i]) return;
      neighbourMsg[dir] = neighbourBufs[i];
      transferList.push(neighbourBufs[i]);
    });

    const workerIdx = pickSlopeWorker();
    if (workerIdx < 0) return null;
    const worker = workers[workerIdx];

    const id = ++_slopeJobMonotonic;
    const jobPromise = new Promise((resolve, reject) => {
      _slopeJobCallbacks.set(id, {
        resolve,
        reject,
        kind: 'slope',
        workerIdx,
        uncancellable: generation === null || generation === undefined,
      });
    });

    worker.postMessage(
      {
        id, kind: 'slope', z, x, y,
        resFactor: Number(resFactor) > 1 ? Number(resFactor) : 1,
        outputScale: outputScale >= 2 ? 2 : 1,
        ownDem: ownDemBuf,
        neighbours: neighbourMsg,
        zoneRing: zoneRing || null,
      },
      transferList,
    );

    // The buffers are gone: free the pre-work slot while the worker computes.
    releasePreWork();

    let result;
    try {
      result = await jobPromise;
    } catch {
      return null;
    }
    if (!result || isCancelled()) return null;

    return {
      blob: new Blob([result.png], { type: 'image/png' }),
      missingDirections: result.missingDirections || [],
    };
  } finally {
    releasePreWork();
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
      _slopeJobCallbacks.set(id, { resolve, reject, kind: 'altitude', workerIdx });
    });

    worker.postMessage(
      { id, kind: 'altitude', z, x, y, ownDem: ownDemBuf, zoneRing: zoneRing || null },
      [ownDemBuf],
    );

    releaseAltitudePreWork();

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

// ── Multi-Core AWS Terrarium Converter (2026-08-29) ───────────────────
// Dispatches raw Terrarium PNG ArrayBuffer to worker pool for parallel
// decoding, Terrarium → Terrain-RGB conversion and Sub-filter PNG encoding.
async function computeAwsTerrariumViaPool(arrayBuffer, z, x, y, fetchZ, fetchX, fetchY, clamped) {
  const workers = ensureSlopePool();
  if (!workers) return null;

  const workerIdx = pickSlopeWorker();
  if (workerIdx < 0) return null;
  const worker = workers[workerIdx];

  const id = ++_slopeJobMonotonic;
  const jobPromise = new Promise((resolve, reject) => {
    _slopeJobCallbacks.set(id, { resolve, reject, kind: 'aws-terrarium', workerIdx });
  });

  try {
    worker.postMessage(
      { id, kind: 'aws-terrarium', z, x, y, fetchZ, fetchX, fetchY, clamped, terrariumBuf: arrayBuffer },
      [arrayBuffer],
    );

    const result = await jobPromise;
    if (!result || !result.png) return null;

    return new Blob([result.png], { type: 'image/png' });
  } catch {
    return null;
  }
}
