// ---------------------------------------------------------------------------
// Build concurrency: composite limiter (peak memory of IGN/Mapbox blends),
// adaptive slope / altitude build queues with cancel generations, and the
// per-tile in-flight maps that coalesce duplicate DEM / slope / altitude requests.
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

let _compositeActive = 0;
const _compositeQueue = [];
const SLOPE_BUILD_BUSY_CONCURRENT = 2;
const SLOPE_BUILD_WARM_CONCURRENT = 4;
let _slopeBuildActive = 0;
const _slopeBuildQueue = [];
// Altitude build concurrency is adaptive (mirrors slope's
// currentSlopeBuildConcurrency). This only caps the IN-PROCESS fallback
// path; the worker pool is the primary build path and is bounded by the
// pool size. A flat `2` starved the fallback on multi-core machines where
// the pool is briefly unavailable.
const ALTITUDE_BUILD_BUSY_CONCURRENT = 2;
const ALTITUDE_BUILD_WARM_CONCURRENT = 4;
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

// Altitude in-process fallback concurrency. Same DEM-pressure heuristic as
// slope: back off when the DEM pipeline is saturated, free-run when it's
// idle. Mirrors currentSlopeBuildConcurrency so the fallback never starves
// the basemap.
function currentAltitudeBuildConcurrency() {
  const demPressure = DEM_INFLIGHT.size;
  if (demPressure >= 24) return ALTITUDE_BUILD_BUSY_CONCURRENT;
  if (demPressure >= 8) return Math.min(SLOPE_BUILD_IDLE_CONCURRENT, ALTITUDE_BUILD_WARM_CONCURRENT);
  return SLOPE_BUILD_IDLE_CONCURRENT;
}

function cancelSlopeWork() {
  slopeCancelGeneration += 1;
  const slopeCount = SLOPE_INFLIGHT.size;
  SLOPE_INFLIGHT.clear();
  const remainingSlope = [];
  while (_slopeBuildQueue.length > 0) {
    const queued = _slopeBuildQueue.shift();
    if (queued?.generation === null) {
      remainingSlope.push(queued);
    } else {
      try { queued?.resolve(null); } catch { /* ignore */ }
    }
  }
  _slopeBuildQueue.push(...remainingSlope);
  // Drop every pending worker-pool job too (except uncancellable ones).
  let poolCancelled = 0;
  try {
    if (typeof cancelAllSlopePoolJobs === 'function') poolCancelled = cancelAllSlopePoolJobs();
  } catch { /* ignore */ }
  try { if (typeof clearSlopeProcessingCaches === 'function') clearSlopeProcessingCaches(); } catch { /* ignore */ }
  return { slopeCount, poolCancelled };
}

function cancelAltitudeWork() {
  altitudeCancelGeneration += 1;
  const altitudeCount = ALTITUDE_INFLIGHT.size;
  ALTITUDE_INFLIGHT.clear();
  while (_altitudeBuildQueue.length > 0) {
    const queued = _altitudeBuildQueue.shift();
    try { queued?.resolve(null); } catch { /* ignore */ }
  }
  // Drop every pending worker-pool job tagged kind:'altitude' too (see
  // slope's CANCEL_SLOPE_WORK for rationale). Per-kind cancel ensures we
  // never touch slope's in-flight jobs.
  let poolCancelled = 0;
  try {
    if (typeof cancelAllAltitudePoolJobs === 'function') poolCancelled = cancelAllAltitudePoolJobs();
  } catch { /* ignore */ }
  try { if (typeof clearAltitudeProcessingCaches === 'function') clearAltitudeProcessingCaches(); } catch { /* ignore */ }
  return { altitudeCount, poolCancelled };
}

function pumpAltitudeBuildQueue() {
  while (_altitudeBuildActive < currentAltitudeBuildConcurrency() && _altitudeBuildQueue.length > 0) {
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
    if (entry.generation !== null && entry.generation !== undefined && entry.generation !== slopeCancelGeneration) {
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
  if (generation !== null && generation !== undefined && generation !== slopeCancelGeneration) return Promise.resolve(null);
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
