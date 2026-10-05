// ---------------------------------------------------------------------------
// IGN request scheduling — shared by every geopf fetch (WMTS MNS, HIGHRES,
// terrain/MNS WMS): in-memory tile cache + in-flight dedup, purpose tags,
// tri-tier priority queues (basemap > slope-visible > slope-warm) with
// centre-first ordering and a dynamic concurrency limiter.
// ---------------------------------------------------------------------------

const ignTileCache = new Map();
const ignInflight = new Map(); // Deduplication: in-progress fetches by key
let activeIGN = 0;
let activeIGNBackground = 0;
let activeIGNSlopeVisible = 0;
// ── Tri-tier scheduling (May 20 rewrite) ──────────────────────────────
// Basemap (no purpose tag) > slope-visible > slope-warm.
//
// Before this rewrite, basemap and slope-visible shared the same
// "foreground" queue with a soft sub-cap on slope-visible. In practice,
// the LIFO pop semantics meant that once slope-visible saturated the
// queue, the basemap getIGNTile/getHighresTile requests that came in
// AFTER the slope burst would land at the tail and pop next — fine —
// BUT all the slope-visible entries enqueued in the same idle cycle
// would already be in flight occupying every IGN slot. Each basemap
// request then queued behind 40+ concurrent slope sub-tile fetches.
//
// The fix is to give basemap its OWN queue and pop it before touching
// the slope-visible queue. Slope-visible still uses LIFO + a dynamic
// sub-cap; isolated slope loads (no basemap queued) get the full
// budget so dedicated 1 m benchmarks are unaffected.
const ignForegroundQueue = [];   // basemap (purpose === null/undefined)
const ignSlopeVisibleQueue = []; // PURPOSE_SLOPE_VISIBLE
const ignBackgroundQueue = [];   // PURPOSE_SLOPE_WARM
let ignPrunedTotal = 0; // Lifetime counter for diagnostics

// Purpose tagging — separates visible 1 m slope fetches from background
// seam-heal / recache work so first-paint slope tiles do not wait behind
// opportunistic warmups. Both tags remain slope-only, so cancellation can
// abort them without touching basemap-driven IGN traffic.
const PURPOSE_SLOPE_VISIBLE = 'slope-visible';
const PURPOSE_SLOPE_WARM = 'slope-warm';
const PURPOSE_SLOPE_ZONE = 'slope-zone';
const PURPOSE_DEM_PREFETCH = 'dem-prefetch';

let ignViewportCenter = null;

function setIGNViewportCenter(center) {
  if (center && Number.isFinite(center.lng) && Number.isFinite(center.lat)) {
    ignViewportCenter = { lng: center.lng, lat: center.lat };
  }
}

function wgs84TileCenter(z, col, row) {
  const matrixWidth = 1 << (z + 1);
  const matrixHeight = 1 << z;
  const lng = ((col + 0.5) / matrixWidth) * 360 - 180;
  const lat = 90 - ((row + 0.5) / matrixHeight) * 180;
  return { lng, lat };
}

function isIGNBackgroundPurpose(purpose) {
  return purpose === PURPOSE_SLOPE_WARM || purpose === PURPOSE_DEM_PREFETCH;
}

function isIGNSlopeVisiblePurpose(purpose) {
  return purpose === PURPOSE_SLOPE_VISIBLE;
}

function isIGNSlopeZonePurpose(purpose) {
  return purpose === PURPOSE_SLOPE_ZONE;
}

// ── WMS elevation rasters: bytes in flight ────────────────────────────
// A LiDAR HD GetMap raster weighs 370 KB (MNS, 1×) to 1.5 MB (MNT, 2×).
// Dispatched up to IGN_CONCURRENCY (40-64) at once, they shared the client's
// line until most of them crossed IGN_FETCH_TIMEOUT_MS. Measured 2026-10-04
// on a ~2 MB/s line: 16 rasters in parallel took 2.4 s each, 40 took 7.4 s,
// 64 took 12.6 s (median; 23 s max, plus 429s) — aborted downloads, bytes
// wasted, and stand-in tiles: 42 % of the relief tiles of a 0.40 m flyover
// video. The line's throughput is the same with a few MB in flight: each
// raster lands in ~2 s, centre-first, while the others wait in the queue,
// outside the fetch timeout (it starts with the job).
const IGN_WMS_INFLIGHT_BYTES_MAX = 4_500_000;
let activeIGNWmsBytes = 0;

function canStartIGNEntry(entry) {
  return !entry.wmsBytes
    || activeIGNWmsBytes === 0
    || activeIGNWmsBytes + entry.wmsBytes <= IGN_WMS_INFLIGHT_BYTES_MAX;
}

function firstStartableIGNIndex(queue) {
  for (let i = 0; i < queue.length; i++) if (canStartIGNEntry(queue[i])) return i;
  return -1;
}

function lastStartableIGNIndex(queue) {
  for (let i = queue.length - 1; i >= 0; i--) if (canStartIGNEntry(queue[i])) return i;
  return -1;
}

function totalIGNQueueLength() {
  return ignForegroundQueue.length
    + ignSlopeVisibleQueue.length
    + ignBackgroundQueue.length;
}

function currentIGNBackgroundConcurrency() {
  if (ignForegroundQueue.length > 0 || ignSlopeVisibleQueue.length > 0) {
    return Math.max(4, Math.min(12, Math.floor(IGN_CONCURRENCY * 0.25)));
  }
  return IGN_CONCURRENCY;
}

// Dynamic sub-cap for visible-slope IGN concurrency.
//
// - If basemap requests are queued, throttle slope-visible to ~30 % of
//   the budget so basemap DEM/ortho/highres fetches always have at
//   least ~70 % of the slots immediately. This is the user-visible
//   regression we keep solving: with slope active, the 3D world
//   freezes because every IGN slot is taken by slope sub-tile fan-out.
// - If basemap is NOT queued (e.g. dedicated slope load test, or
//   ambient prefetch idle window), let slope-visible consume the full
//   budget so a pure-slope viewport still loads at peak speed.
function currentIGNSlopeVisibleCap() {
  if (ignForegroundQueue.length > 0) {
    return Math.max(4, Math.floor(IGN_CONCURRENCY * 0.3));
  }
  return IGN_CONCURRENCY;
}

function pushIGNEntry(entry) {
  if (isIGNSlopeZonePurpose(entry.purpose)) {
    // Zone requests have top priority — push directly into foreground queue
    ignForegroundQueue.push(entry);
    return;
  }
  if (isIGNBackgroundPurpose(entry.purpose)) {
    ignBackgroundQueue.push(entry);
    return;
  }
  if (isIGNSlopeVisiblePurpose(entry.purpose)) {
    ignSlopeVisibleQueue.push(entry);
    return;
  }
  ignForegroundQueue.push(entry);
}

function popNextIGNEntry() {
  // 1. Basemap / Slope-Zone (foreground) — strict highest priority.
  //    Select candidate closest to current viewport center so center of screen loads first!
  //    Strict priority: while it holds entries, nothing else starts — not
  //    even when its WMS rasters wait for bytes in flight to land.
  if (ignForegroundQueue.length > 0) {
    if (ignForegroundQueue.length === 1 || !ignViewportCenter) {
      // FIFO when center is unknown (Mapbox sends center tiles first)
      const idx = firstStartableIGNIndex(ignForegroundQueue);
      return idx < 0 ? null : { entry: ignForegroundQueue.splice(idx, 1)[0], background: false };
    }
    let bestIdx = -1;
    let minD2 = Infinity;
    const cLng = ignViewportCenter.lng;
    const cLat = ignViewportCenter.lat;
    for (let i = 0; i < ignForegroundQueue.length; i++) {
      const e = ignForegroundQueue[i];
      if (!e.hasCoords || !canStartIGNEntry(e)) continue;
      const dLng = e.lng - cLng;
      const dLat = e.lat - cLat;
      const d2 = dLng * dLng + dLat * dLat;
      if (d2 < minD2) {
        minD2 = d2;
        bestIdx = i;
      }
    }
    if (bestIdx < 0) bestIdx = firstStartableIGNIndex(ignForegroundQueue);
    return bestIdx < 0 ? null : { entry: ignForegroundQueue.splice(bestIdx, 1)[0], background: false };
  }
  // 2. Slope-visible — only when basemap queue is drained, and only up
  //    to its dynamic cap so a single slope burst can never monopolise
  //    every slot.
  if (
    ignSlopeVisibleQueue.length > 0
    && activeIGNSlopeVisible < currentIGNSlopeVisibleCap()
  ) {
    const idx = lastStartableIGNIndex(ignSlopeVisibleQueue);
    if (idx >= 0) return { entry: ignSlopeVisibleQueue.splice(idx, 1)[0], background: false };
  }
  // 3. Background (prefetch / slope-warm) — separate concurrency budget so warmups
  //    cannot starve foreground basemap or slope-visible.
  if (ignBackgroundQueue.length === 0) return null;
  if (activeIGNBackground >= currentIGNBackgroundConcurrency()) return null;
  const idx = firstStartableIGNIndex(ignBackgroundQueue);
  return idx < 0 ? null : { entry: ignBackgroundQueue.splice(idx, 1)[0], background: true };
}

function pruneOldestIGNEntry() {
  if (totalIGNQueueLength() === 0) return null;

  let targetQueue = null;
  let targetIdx = -1;
  let oldestTs = Infinity;

  const considerQueue = (queue) => {
    for (let i = 0; i < queue.length; i++) {
      if (queue[i].ts < oldestTs) {
        oldestTs = queue[i].ts;
        targetIdx = i;
        targetQueue = queue;
      }
    }
  };

  // Prune oldest background entries first (they're warmups), then
  // slope-visible (cancellable), and finally basemap (most expensive
  // to lose because Mapbox is actively waiting on them).
  considerQueue(ignBackgroundQueue);
  considerQueue(ignSlopeVisibleQueue);
  considerQueue(ignForegroundQueue);
  if (!targetQueue || targetIdx < 0) return null;
  return targetQueue.splice(targetIdx, 1)[0] || null;
}

function evict(cache, max) {
  if (cache.size <= max) return;
  const iter = cache.keys();
  const toDelete = cache.size - Math.floor(max * 0.75);
  for (let i = 0; i < toDelete; i++) {
    const k = iter.next().value;
    if (k !== undefined) cache.delete(k);
  }
}

// `mapTile` ({ key: 'z/x/y', requestedAt }) tags work done for a DEM tile the
// map itself asked for, so pruneUnwantedMapDemWork() can drop it once the map
// no longer waits on that tile. `options.wmsBytes`: size of the WMS raster the
// job downloads (IGN_WMS_INFLIGHT_BYTES_MAX).
function scheduleIGN(fn, purpose, coords, mapTile = null, options = {}) {
  return new Promise((resolve, reject) => {
    let lng = 0, lat = 0;
    let hasCoords = false;
    if (coords && typeof coords.z === 'number' && typeof coords.col === 'number') {
      const c = wgs84TileCenter(coords.z, coords.col, coords.row);
      lng = c.lng;
      lat = c.lat;
      hasCoords = true;
    } else if (coords && Number.isFinite(coords.lng) && Number.isFinite(coords.lat)) {
      // Direct lng/lat (Mercator-tile WMS requests) — centre-first ordering.
      lng = coords.lng;
      lat = coords.lat;
      hasCoords = true;
    }
    pushIGNEntry({
      fn,
      resolve,
      reject,
      ts: performance.now(),
      purpose: purpose || null,
      mapTile,
      wmsBytes: Math.max(0, Number(options?.wmsBytes) || 0),
      lng,
      lat,
      hasCoords,
    });
    // When the queue overflows, drop the OLDEST entries by enqueue timestamp
    // (tiles requested during an earlier pan gesture) instead of the head.
    // Ensures the current viewport survives rapid panning.
    let pruned = 0;
    while (totalIGNQueueLength() > IGN_QUEUE_MAX) {
      const stale = pruneOldestIGNEntry();
      if (!stale) break;
      stale.resolve(PRUNED_SENTINEL);
      pruned++;
    }
    if (pruned > 0) {
      ignPrunedTotal += pruned;
      if (DEBUG) console.warn(`[sw-dem][queue] pruned ${pruned} stale (queue=${totalIGNQueueLength()}, lifetime=${ignPrunedTotal})`);
    }
    drainIGN();
  });
}

function drainIGN() {
  while (activeIGN < IGN_CONCURRENCY && totalIGNQueueLength() > 0) {
    // LIFO: pop newest item — prioritise current-viewport tiles over stale ones
    const next = popNextIGNEntry();
    if (!next?.entry) break;
    const { entry, background } = next;
    const { fn, resolve, reject, purpose, wmsBytes } = entry;
    activeIGN++;
    activeIGNWmsBytes += wmsBytes;
    if (background) activeIGNBackground++;
    const isSlopeVisible = purpose === PURPOSE_SLOPE_VISIBLE;
    if (isSlopeVisible) activeIGNSlopeVisible++;
    fn()
      .then(resolve)
      .catch(reject)
      .finally(() => {
        activeIGN--;
        activeIGNWmsBytes = Math.max(0, activeIGNWmsBytes - wmsBytes);
        if (background) activeIGNBackground = Math.max(0, activeIGNBackground - 1);
        if (isSlopeVisible) activeIGNSlopeVisible = Math.max(0, activeIGNSlopeVisible - 1);
        drainIGN();
      });
  }
}

// Drain the queued-but-not-yet-running speculative IGN entries (slope,
// prefetch, warm-ups), resolving each with PRUNED_SENTINEL. Posted by the
// browser on user gesture (`zoomstart` / `movestart`) via the
// `CANCEL_STALE_DEM` SW message so the previous viewport's speculative
// work does not hold the IGN slots.
//
// Basemap entries (no purpose) are kept: a gesture start says nothing about
// which DEM tiles the map still needs — after a rotation or a pitch it is
// nearly all of them. Flushing them made those very tiles fall back to the
// correlation MNS / 30 m relief (the "3D drops to 30 m when I turn the
// camera" bug). Stale basemap work is dropped per tile instead, once the
// map stops waiting on it (pruneUnwantedMapDemWork / DEM_WANTED_TILES).
//
// Returns the number of pruned entries for diagnostics.
function flushIGNQueue() {
  const total = totalIGNQueueLength();
  if (total === 0) return 0;
  // Keep basemap and PURPOSE_SLOPE_ZONE entries in the foreground queue.
  const keptForeground = [];
  while (ignForegroundQueue.length > 0) {
    const entry = ignForegroundQueue.pop();
    if (!entry.purpose || entry.purpose === PURPOSE_SLOPE_ZONE) {
      keptForeground.unshift(entry);
    } else {
      entry.resolve(PRUNED_SENTINEL);
    }
  }
  for (const entry of keptForeground) ignForegroundQueue.push(entry);

  while (ignSlopeVisibleQueue.length > 0) {
    const stale = ignSlopeVisibleQueue.pop();
    stale.resolve(PRUNED_SENTINEL);
  }
  while (ignBackgroundQueue.length > 0) {
    const stale = ignBackgroundQueue.pop();
    stale.resolve(PRUNED_SENTINEL);
  }
  const pruned = total - keptForeground.length;
  if (pruned > 0) {
    ignPrunedTotal += pruned;
    if (DEBUG) console.warn(`[sw-dem][queue] flushed ${pruned} stale on viewport change`);
  }
  return pruned;
}
