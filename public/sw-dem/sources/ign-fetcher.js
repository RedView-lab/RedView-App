// ---------------------------------------------------------------------------
// IGN tile fetching with in-memory LRU cache + concurrency limiter
// TTL-aware null caching + zoom-level fallback for missing tiles
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
  if (ignForegroundQueue.length > 0) {
    if (ignForegroundQueue.length === 1 || !ignViewportCenter) {
      // FIFO when center is unknown (Mapbox sends center tiles first)
      return { entry: ignForegroundQueue.shift(), background: false };
    }
    let bestIdx = 0;
    let minD2 = Infinity;
    const cLng = ignViewportCenter.lng;
    const cLat = ignViewportCenter.lat;
    for (let i = 0; i < ignForegroundQueue.length; i++) {
      const e = ignForegroundQueue[i];
      if (!e.hasCoords) continue;
      const dLng = e.lng - cLng;
      const dLat = e.lat - cLat;
      const d2 = dLng * dLng + dLat * dLat;
      if (d2 < minD2) {
        minD2 = d2;
        bestIdx = i;
      }
    }
    return { entry: ignForegroundQueue.splice(bestIdx, 1)[0], background: false };
  }
  // 2. Slope-visible — only when basemap queue is drained, and only up
  //    to its dynamic cap so a single slope burst can never monopolise
  //    every slot.
  if (
    ignSlopeVisibleQueue.length > 0
    && activeIGNSlopeVisible < currentIGNSlopeVisibleCap()
  ) {
    return { entry: ignSlopeVisibleQueue.pop(), background: false };
  }
  // 3. Background (prefetch / slope-warm) — separate concurrency budget so warmups
  //    cannot starve foreground basemap or slope-visible.
  if (ignBackgroundQueue.length === 0) return null;
  if (activeIGNBackground >= currentIGNBackgroundConcurrency()) return null;
  return { entry: ignBackgroundQueue.shift(), background: true };
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

function scheduleIGN(fn, purpose, coords) {
  return new Promise((resolve, reject) => {
    let lng = 0, lat = 0;
    let hasCoords = false;
    if (coords && typeof coords.z === 'number' && typeof coords.col === 'number') {
      const c = wgs84TileCenter(coords.z, coords.col, coords.row);
      lng = c.lng;
      lat = c.lat;
      hasCoords = true;
    }
    pushIGNEntry({
      fn,
      resolve,
      reject,
      ts: performance.now(),
      purpose: purpose || null,
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
    const { fn, resolve, reject, purpose } = entry;
    activeIGN++;
    if (background) activeIGNBackground++;
    const isSlopeVisible = purpose === PURPOSE_SLOPE_VISIBLE;
    if (isSlopeVisible) activeIGNSlopeVisible++;
    fn()
      .then(resolve)
      .catch(reject)
      .finally(() => {
        activeIGN--;
        if (background) activeIGNBackground = Math.max(0, activeIGNBackground - 1);
        if (isSlopeVisible) activeIGNSlopeVisible = Math.max(0, activeIGNSlopeVisible - 1);
        drainIGN();
      });
  }
}

// Drain every queued-but-not-yet-running IGN entry, resolving each with
// PRUNED_SENTINEL. Posted by the browser on user gesture (`zoomstart` /
// `movestart`) via the `CANCEL_STALE_DEM` SW message: when the viewport
// changes, the previous viewport's queued IGN sub-tile fetches are now
// targeting the wrong zoom — they would just block the new viewport's
// burst from reaching the IGN concurrency slots. In-flight fetches are
// aborted by `cancelInFlightIGN()` (paired call from the same message
// handler) so all 40 concurrency slots become available immediately for
// the new viewport instead of trickling free over up to 15 s as the
// previous viewport's HTTP responses landed one by one.
//
// Returns the number of pruned entries for diagnostics.
function flushIGNQueue() {
  const total = totalIGNQueueLength();
  if (total === 0) return 0;
  // Keep PURPOSE_SLOPE_ZONE entries in foreground queue!
  const keptForeground = [];
  while (ignForegroundQueue.length > 0) {
    const entry = ignForegroundQueue.pop();
    if (entry.purpose === PURPOSE_SLOPE_ZONE) {
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

// In-flight AbortController registry. Every IGN sub-tile fetch (MNS,
// HIGHRES, terrain WMS) registers its controller here for the duration
// of the network request. `cancelInFlightIGN()` aborts them all with
// USER_CANCEL_REASON; the per-fetch catch handlers then check the
// signal reason and skip negative-cache writes (otherwise tiles we
// just killed would be blacklisted for IGN_NULL_TTL_TRANSIENT and the
// re-request issued ~50 ms later for the new viewport would return
// null without ever hitting the network).
const ignActiveControllers = new Set();
// Per-purpose controller registry — populated alongside ignActiveControllers
// when ignFetchInit is called with { purpose }. Only used by
// cancelInFlightIGNByPurpose, which aborts a narrow tag without touching the
// global set (basemap fetches keep running).
const ignActiveControllersByPurpose = new Map();

function ignFetchInit(extra) {
  const purpose = extra && typeof extra === 'object' ? extra.purpose || null : null;
  const priority = isIGNBackgroundPurpose(purpose) ? 'low' : 'high';
  // Strip the SW-internal `purpose` field before forwarding to fetch init —
  // it isn't a valid RequestInit option and would be ignored, but keeping it
  // out of the spread avoids future linter/typing surprises.
  const fetchExtra = (extra && typeof extra === 'object')
    ? Object.fromEntries(Object.entries(extra).filter(([k]) => k !== 'purpose'))
    : (extra || {});
  const controller = new AbortController();
  controller._purpose = purpose;
  const timeout = setTimeout(() => {
    try { controller.abort('rv-ign-timeout'); } catch { /* ignore */ }
  }, IGN_FETCH_TIMEOUT_MS);
  ignActiveControllers.add(controller);
  let purposeBucket = null;
  if (purpose) {
    purposeBucket = ignActiveControllersByPurpose.get(purpose);
    if (!purposeBucket) {
      purposeBucket = new Set();
      ignActiveControllersByPurpose.set(purpose, purposeBucket);
    }
    purposeBucket.add(controller);
  }
  const cleanup = () => {
    clearTimeout(timeout);
    ignActiveControllers.delete(controller);
    if (purposeBucket) purposeBucket.delete(controller);
  };
  return {
    controller,
    cleanup,
    init: { signal: controller.signal, priority, ...fetchExtra },
  };
}

function isIGNUserCancel(controller) {
  return controller.signal.aborted && controller.signal.reason === USER_CANCEL_REASON;
}

function cancelInFlightIGN() {
  if (ignActiveControllers.size === 0) return 0;
  let n = 0;
  for (const c of Array.from(ignActiveControllers)) {
    // Analysis-zone requests are user-initiated and must NOT be cancelled by camera movements
    if (c._purpose === PURPOSE_SLOPE_ZONE) continue;
    try { c.abort(USER_CANCEL_REASON); n++; } catch { /* ignore */ }
    ignActiveControllers.delete(c);
  }
  if (DEBUG) console.warn(`[sw-dem][queue] aborted ${n} in-flight IGN fetches on viewport change`);
  return n;
}

// Drain queued (not-yet-running) IGN entries that match a purpose tag.
// Returns the count of pruned entries. Safe to call concurrently with
// drainIGN — pruned items resolve with PRUNED_SENTINEL so their callers
// see a normal `null` return.
function flushIGNQueueByPurpose(purpose) {
  if (!purpose || totalIGNQueueLength() === 0) return 0;
  // Route to the queue that owns this purpose tag now that slope-visible
  // lives in its own queue separate from basemap (May 20 tri-tier rewrite).
  let targetQueue;
  if (isIGNBackgroundPurpose(purpose)) targetQueue = ignBackgroundQueue;
  else if (isIGNSlopeVisiblePurpose(purpose)) targetQueue = ignSlopeVisibleQueue;
  else targetQueue = ignForegroundQueue;
  if (targetQueue.length === 0) return 0;
  let pruned = 0;
  for (let i = targetQueue.length - 1; i >= 0; i--) {
    if (targetQueue[i].purpose === purpose) {
      const stale = targetQueue.splice(i, 1)[0];
      stale.resolve(PRUNED_SENTINEL);
      pruned++;
    }
  }
  if (pruned > 0) ignPrunedTotal += pruned;
  return pruned;
}

// Abort only IGN HTTP fetches tagged with `purpose`. Used by
// CANCEL_SLOPE_WORK to free terrain-WMS concurrency slots immediately
// when the user disables 1 m slope, instead of waiting up to
// IGN_FETCH_TIMEOUT_MS for each in-flight slot to drain naturally
// (visible as a multi-second stall on subsequent satellite/DEM tile
// loads). The basemap pipeline is unaffected because it uses the
// default DEM profile, which never sets a purpose tag.
function cancelInFlightIGNByPurpose(purpose) {
  const bucket = ignActiveControllersByPurpose.get(purpose);
  if (!bucket || bucket.size === 0) return 0;
  let n = 0;
  for (const c of bucket) {
    try { c.abort(USER_CANCEL_REASON); n++; } catch { /* ignore */ }
    ignActiveControllers.delete(c);
  }
  bucket.clear();
  if (DEBUG && n > 0) console.warn(`[sw-dem][cancel-slope] aborted ${n} in-flight IGN ${purpose} fetches`);
  return n;
}

function buildDEMTileURL(z, col, row) {
  return (
    `${IGN_WMTS_BASE}?SERVICE=WMTS&REQUEST=GetTile&VERSION=1.0.0` +
    `&LAYER=${IGN_DEM_LAYER}&STYLE=normal` +
    `&FORMAT=${encodeURIComponent(IGN_DEM_FORMAT)}` +
    `&TILEMATRIXSET=${IGN_DEM_TILEMATRIXSET}` +
    `&TILEMATRIX=${z}&TILEROW=${row}&TILECOL=${col}`
  );
}

// Cache a null result with TTL metadata
function cacheNull(key, errorType) {
  const ttl = errorType === 'permanent' ? IGN_NULL_TTL_PERMANENT : IGN_NULL_TTL_TRANSIENT;
  ignTileCache.set(key, { _null: true, ts: Date.now(), ttl, errorType });
}

// Check if a cached entry is valid data (Float32Array) or an expired/active null
function getCached(key) {
  if (!ignTileCache.has(key)) return { hit: false };
  const entry = ignTileCache.get(key);
  // Valid tile data (Float32Array)
  if (entry instanceof Float32Array) return { hit: true, data: entry };
  // Null entry with TTL
  if (entry && entry._null) {
    if (Date.now() - entry.ts < entry.ttl) {
      return { hit: true, data: null }; // Still within TTL — honor the null
    }
    // Expired — evict and allow retry
    ignTileCache.delete(key);
    return { hit: false };
  }
  // Legacy null (no metadata) — evict
  if (entry === null) {
    ignTileCache.delete(key);
    return { hit: false };
  }
  return { hit: true, data: entry };
}

async function getIGNTile(z, col, row, purpose) {
  const key = `${z}/${col}/${row}`;
  const cached = getCached(key);
  if (cached.hit) return cached.data;

  // Deduplicate: if this tile is already being fetched, reuse the in-flight promise
  if (ignInflight.has(key)) return ignInflight.get(key);

  const promise = scheduleIGN(async () => {
    // Re-check after acquiring the concurrency slot
    const cached2 = getCached(key);
    if (cached2.hit) return cached2.data;

    const url = buildDEMTileURL(z, col, row);
    const { controller, cleanup, init } = ignFetchInit();
    try {
      // priority:'high' is a HTTP/2 stream-priority hint (Chrome/Edge/Safari
      // honour it natively, Firefox ignores). DEM tiles drive the visible
      // mesh — they MUST land before lazy assets (analytics, prefetch link
      // hints, etc.) on the shared geopf H2 connection. Free ~30–80 ms TTFB
      // win when the connection has any background traffic.
      const res = await fetch(url, init);
      if (!res.ok) {
        const errorType = res.status === 404 ? 'permanent' : 'transient';
        cacheNull(key, errorType);
        return null;
      }
      const buf = await res.arrayBuffer();
      if (buf.byteLength !== IGN_SRC_TILE_SIZE * IGN_SRC_TILE_SIZE * 4) {
        cacheNull(key, 'permanent');
        return null;
      }
      const data = decodeBIL32(buf);
      evict(ignTileCache, IGN_CACHE_MAX);
      ignTileCache.set(key, data);
      return data;
    } catch {
      // Skip neg-cache when WE aborted the fetch on a user gesture
      // (CANCEL_STALE_DEM): the new viewport often re-requests overlapping
      // tiles within ~50 ms and must hit the real network, not a transient
      // null entry caused by our own cancellation.
      if (isIGNUserCancel(controller)) return null;
      cacheNull(key, 'transient');
      return null;
    } finally {
      cleanup();
    }
  }, purpose, { z, col, row }).then((result) => {
    // If the request was pruned from the queue, do NOT cache — return null
    if (result === PRUNED_SENTINEL) return null;
    return result;
  }).finally(() => {
    ignInflight.delete(key);
  });

  ignInflight.set(key, promise);
  return promise;
}

// ---------------------------------------------------------------------------
// Zoom-level fallback: try lower zoom levels when tile is missing
// Returns { data, actualZ, actualCol, actualRow } or null
// ---------------------------------------------------------------------------
// Check if a cached null entry is a permanent 404 (tile genuinely missing)
function isCachedPermanent404(key) {
  if (!ignTileCache.has(key)) return false;
  const entry = ignTileCache.get(key);
  return entry && entry._null && entry.errorType === 'permanent';
}

async function getIGNTileWithFallback(z, col, row, deadlineAt, purpose) {
  const data = await getIGNTile(z, col, row, purpose);
  if (data) return { data, actualZ: z, actualCol: col, actualRow: row };

  // If the native zoom returned a confirmed 404, reduce fallback depth.
  // MNS coverage is zoom-consistent: if z14 is permanently missing, z11-z13
  // almost certainly are too. Skip the deep fallback to free queue slots for
  // tiles that might actually exist.
  const key = `${z}/${col}/${row}`;
  const isPermanent = isCachedPermanent404(key);
  const maxDepth = isPermanent ? 1 : IGN_FALLBACK_MAX_DEPTH;
  const minZ = Math.max(IGN_DEM_MINZOOM, z - maxDepth);
  let fbCol = col;
  let fbRow = row;
  for (let fbZ = z - 1; fbZ >= minZ; fbZ--) {
    fbCol = fbCol >> 1;
    fbRow = fbRow >> 1;
    // Per-build deadline check: when the caller (build-tile.js) is past
    // its soft deadline, give up on the fallback chain.
    if (typeof deadlineAt === 'number' && performance.now() >= deadlineAt) {
      const cached = getCached(`${fbZ}/${fbCol}/${fbRow}`);
      if (cached.hit && cached.data) {
        return { data: cached.data, actualZ: fbZ, actualCol: fbCol, actualRow: fbRow };
      }
      return null;
    }
    const fbData = await getIGNTile(fbZ, fbCol, fbRow, purpose);
    if (fbData) {
      return { data: fbData, actualZ: fbZ, actualCol: fbCol, actualRow: fbRow };
    }
    // Optimization: if native zoom and z-1 both returned 404, don't probe deeper on network!
    if (fbZ === z - 1) {
      break;
    }
  }

  return null;
}

// ---------------------------------------------------------------------------
// HIGHRES (5 m DEM) fallback fetcher — same pattern as MNS but targeting
// ELEVATION.ELEVATIONGRIDCOVERAGE.HIGHRES on TileMatrixSet WGS84G_6_14.
// Shares the IGN concurrency limiter (same geopf server) but uses a separate
// in-memory tile cache so MNS and HIGHRES entries don't evict each other.
// ---------------------------------------------------------------------------
const highresTileCache = new Map();
const highresInflight = new Map();
const HIGHRES_CACHE_MAX = 300;
const terrainWmsTileCache = new Map();
const terrainWmsInflight = new Map();
const TERRAIN_WMS_CACHE_MAX = 300;

function buildHighresTileURL(z, col, row) {
  return (
    `${IGN_WMTS_BASE}?SERVICE=WMTS&REQUEST=GetTile&VERSION=1.0.0` +
    `&LAYER=${IGN_DEM_FALLBACK_LAYER}&STYLE=normal` +
    `&FORMAT=${encodeURIComponent(IGN_DEM_FORMAT)}` +
    `&TILEMATRIXSET=${IGN_DEM_FALLBACK_TILEMATRIXSET}` +
    `&TILEMATRIX=${z}&TILEROW=${row}&TILECOL=${col}`
  );
}

function terrainWmsSupersampleFactor(mercZ) {
  // 2× supersampling for z>=13: fetches 512×512 BIL32 from IGN WMS and box-averages
  // 2×2 -> 256×256. This eliminates the IGN WMS server's internal scanline duplication
  // and staircase row artifacts in Horn slope math.
  return mercZ >= 13 ? 2 : 1;
}

function buildTerrainWmsTileURL(mercZ, mercX, mercY, supersample) {
  const bounds = mercatorTileBounds(mercZ, mercX, mercY);
  // WMS 1.3.0 axis order for EPSG:4326 is latitude,longitude.
  const bbox = [bounds.south, bounds.west, bounds.north, bounds.east].join(',');
  // 2× supersample only where the rendered grid is fine enough to expose the
  // RGE ALTI server's row-staircase artefact in Horn slope math. At z≤14 the
  // screen pixel footprint is already coarser than native 1 m terrain, so a
  // 256² request is visually equivalent and 4× cheaper over the wire.
  const size = DEM_TILE_SIZE * supersample;
  return (
    `${IGN_WMS_BASE}?SERVICE=WMS&REQUEST=GetMap&VERSION=1.3.0` +
    `&LAYERS=${IGN_DEM_FALLBACK_LAYER}&STYLES=` +
    `&FORMAT=${encodeURIComponent(IGN_DEM_FORMAT)}` +
    `&CRS=EPSG:4326&BBOX=${bbox}` +
    `&WIDTH=${size}&HEIGHT=${size}`
  );
}

function getCachedHighres(key) {
  if (!highresTileCache.has(key)) return { hit: false };
  const entry = highresTileCache.get(key);
  if (entry instanceof Float32Array) return { hit: true, data: entry };
  if (entry && entry._null) {
    if (Date.now() - entry.ts < entry.ttl) return { hit: true, data: null };
    highresTileCache.delete(key);
    return { hit: false };
  }
  if (entry === null) { highresTileCache.delete(key); return { hit: false }; }
  return { hit: true, data: entry };
}

function cacheHighresNull(key, errorType) {
  const ttl = errorType === 'permanent' ? IGN_NULL_TTL_PERMANENT : IGN_NULL_TTL_TRANSIENT;
  highresTileCache.set(key, { _null: true, ts: Date.now(), ttl, errorType });
}

async function getHighresTile(z, col, row) {
  const key = `hr/${z}/${col}/${row}`;
  const cached = getCachedHighres(key);
  if (cached.hit) return cached.data;

  if (highresInflight.has(key)) return highresInflight.get(key);

  const promise = scheduleIGN(async () => {
    const cached2 = getCachedHighres(key);
    if (cached2.hit) return cached2.data;

    const url = buildHighresTileURL(z, col, row);
    const { controller, cleanup, init } = ignFetchInit();
    try {
      const res = await fetch(url, init);
      if (!res.ok) {
        cacheHighresNull(key, res.status === 404 ? 'permanent' : 'transient');
        return null;
      }
      const buf = await res.arrayBuffer();
      if (buf.byteLength !== IGN_SRC_TILE_SIZE * IGN_SRC_TILE_SIZE * 4) {
        cacheHighresNull(key, 'permanent');
        return null;
      }
      const data = decodeBIL32(buf);
      evict(highresTileCache, HIGHRES_CACHE_MAX);
      highresTileCache.set(key, data);
      return data;
    } catch {
      if (isIGNUserCancel(controller)) return null;
      cacheHighresNull(key, 'transient');
      return null;
    } finally {
      cleanup();
    }
  }).then((result) => {
    if (result === PRUNED_SENTINEL) return null;
    return result;
  }).finally(() => {
    highresInflight.delete(key);
  });

  highresInflight.set(key, promise);
  return promise;
}

function getCachedTerrainWms(key) {
  if (!terrainWmsTileCache.has(key)) return { hit: false };
  const entry = terrainWmsTileCache.get(key);
  if (entry instanceof Float32Array) return { hit: true, data: entry };
  if (entry && entry._null) {
    if (Date.now() - entry.ts < entry.ttl) return { hit: true, data: null };
    terrainWmsTileCache.delete(key);
    return { hit: false };
  }
  if (entry === null) {
    terrainWmsTileCache.delete(key);
    return { hit: false };
  }
  return { hit: true, data: entry };
}

function cacheTerrainWmsNull(key, errorType) {
  const ttl = errorType === 'permanent' ? IGN_NULL_TTL_PERMANENT : IGN_NULL_TTL_TRANSIENT;
  terrainWmsTileCache.set(key, { _null: true, ts: Date.now(), ttl, errorType });
}

async function getTerrainWmsTile(mercZ, mercX, mercY, purpose = PURPOSE_SLOPE_VISIBLE) {
  const supersample = terrainWmsSupersampleFactor(mercZ);
  const key = `wms/${mercZ}/${mercX}/${mercY}@${supersample}x`;
  const cached = getCachedTerrainWms(key);
  if (cached.hit) return cached.data;

  if (terrainWmsInflight.has(key)) return terrainWmsInflight.get(key);

  const promise = scheduleIGN(async () => {
    const cached2 = getCachedTerrainWms(key);
    if (cached2.hit) return cached2.data;

    const url = buildTerrainWmsTileURL(mercZ, mercX, mercY, supersample);
    const { controller, cleanup, init } = ignFetchInit({ purpose });
    try {
      const res = await fetch(url, init);
      if (!res.ok) {
        cacheTerrainWmsNull(key, res.status === 404 ? 'permanent' : 'transient');
        return null;
      }
      const buf = await res.arrayBuffer();
      const SS = DEM_TILE_SIZE * supersample;
      if (buf.byteLength !== SS * SS * 4) {
        cacheTerrainWmsNull(key, 'permanent');
        return null;
      }
      const hi = decodeBIL32(buf);
      if (supersample === 1) {
        evict(terrainWmsTileCache, TERRAIN_WMS_CACHE_MAX);
        terrainWmsTileCache.set(key, hi);
        return hi;
      }
      // Box-average supersample×supersample → 1 into a 256² Float32Array.
      // NaN-aware so sentinel/no-data pixels never poison the average.
      const data = new Float32Array(DEM_TILE_SIZE * DEM_TILE_SIZE);
      for (let y = 0; y < DEM_TILE_SIZE; y++) {
        const sy = y * supersample;
        for (let x = 0; x < DEM_TILE_SIZE; x++) {
          const sx = x * supersample;
          let sum = 0, n = 0;
          for (let yy = 0; yy < supersample; yy++) {
            const row = (sy + yy) * SS;
            for (let xx = 0; xx < supersample; xx++) {
              const value = hi[row + sx + xx];
              if (!Number.isNaN(value)) { sum += value; n++; }
            }
          }
          data[y * DEM_TILE_SIZE + x] = n > 0 ? sum / n : NaN;
        }
      }
      evict(terrainWmsTileCache, TERRAIN_WMS_CACHE_MAX);
      terrainWmsTileCache.set(key, data);
      return data;
    } catch {
      if (isIGNUserCancel(controller)) return null;
      cacheTerrainWmsNull(key, 'transient');
      return null;
    } finally {
      cleanup();
    }
  }, purpose).then((result) => {
    if (result === PRUNED_SENTINEL) return null;
    return result;
  }).finally(() => {
    terrainWmsInflight.delete(key);
  });

  terrainWmsInflight.set(key, promise);
  return promise;
}

// HIGHRES fallback with zoom fallback (same pattern, max 2 levels)
async function getHighresTileWithFallback(z, col, row) {
  const data = await getHighresTile(z, col, row);
  if (data) return { data, actualZ: z, actualCol: col, actualRow: row };

  const minZ = Math.max(IGN_DEM_FALLBACK_MINZOOM, z - 2);
  let fbCol = col;
  let fbRow = row;
  for (let fbZ = z - 1; fbZ >= minZ; fbZ--) {
    fbCol = fbCol >> 1;
    fbRow = fbRow >> 1;
    const fbData = await getHighresTile(fbZ, fbCol, fbRow);
    if (fbData) {
      return { data: fbData, actualZ: fbZ, actualCol: fbCol, actualRow: fbRow };
    }
  }
  return null;
}
