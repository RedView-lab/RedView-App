// ---------------------------------------------------------------------------
// IGN tile fetching with in-memory LRU cache + concurrency limiter
// TTL-aware null caching + zoom-level fallback for missing tiles
// ---------------------------------------------------------------------------

const ignTileCache = new Map();
const ignInflight = new Map(); // Deduplication: in-progress fetches by key
let activeIGN = 0;
const ignQueue = [];
let ignPrunedTotal = 0; // Lifetime counter for diagnostics

function evict(cache, max) {
  if (cache.size <= max) return;
  const iter = cache.keys();
  const toDelete = cache.size - Math.floor(max * 0.75);
  for (let i = 0; i < toDelete; i++) {
    const k = iter.next().value;
    if (k !== undefined) cache.delete(k);
  }
}

function scheduleIGN(fn) {
  return new Promise((resolve, reject) => {
    ignQueue.push({ fn, resolve, reject, ts: performance.now() });
    // When the queue overflows, drop the OLDEST entries by enqueue timestamp
    // (tiles requested during an earlier pan gesture) instead of the head.
    // Ensures the current viewport survives rapid panning.
    let pruned = 0;
    while (ignQueue.length > IGN_QUEUE_MAX) {
      let oldestIdx = 0;
      let oldestTs = ignQueue[0].ts;
      for (let i = 1; i < ignQueue.length; i++) {
        if (ignQueue[i].ts < oldestTs) { oldestTs = ignQueue[i].ts; oldestIdx = i; }
      }
      const stale = ignQueue.splice(oldestIdx, 1)[0];
      stale.resolve(PRUNED_SENTINEL);
      pruned++;
    }
    if (pruned > 0) {
      ignPrunedTotal += pruned;
      if (DEBUG) console.warn(`[sw-dem][queue] pruned ${pruned} stale (queue=${ignQueue.length}, lifetime=${ignPrunedTotal})`);
    }
    drainIGN();
  });
}

function drainIGN() {
  while (activeIGN < IGN_CONCURRENCY && ignQueue.length > 0) {
    // LIFO: pop newest item — prioritise current-viewport tiles over stale ones
    const { fn, resolve, reject } = ignQueue.pop();
    activeIGN++;
    fn()
      .then(resolve)
      .catch(reject)
      .finally(() => {
        activeIGN--;
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
  if (ignQueue.length === 0) return 0;
  const pruned = ignQueue.length;
  // Resolve in reverse insertion order so promise chains unwind LIFO
  // (matches the normal scheduler popping order).
  while (ignQueue.length > 0) {
    const stale = ignQueue.pop();
    stale.resolve(PRUNED_SENTINEL);
  }
  ignPrunedTotal += pruned;
  if (DEBUG) console.warn(`[sw-dem][queue] flushed ${pruned} stale on viewport change`);
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

function ignFetchInit(extra) {
  const controller = new AbortController();
  const timeout = setTimeout(() => {
    try { controller.abort('rv-ign-timeout'); } catch { /* ignore */ }
  }, IGN_FETCH_TIMEOUT_MS);
  ignActiveControllers.add(controller);
  const cleanup = () => {
    clearTimeout(timeout);
    ignActiveControllers.delete(controller);
  };
  return {
    controller,
    cleanup,
    init: { signal: controller.signal, priority: 'high', ...(extra || {}) },
  };
}

function isIGNUserCancel(controller) {
  return controller.signal.aborted && controller.signal.reason === USER_CANCEL_REASON;
}

function cancelInFlightIGN() {
  if (ignActiveControllers.size === 0) return 0;
  let n = 0;
  for (const c of ignActiveControllers) {
    try { c.abort(USER_CANCEL_REASON); n++; } catch { /* ignore */ }
  }
  ignActiveControllers.clear();
  if (DEBUG) console.warn(`[sw-dem][queue] aborted ${n} in-flight IGN fetches on viewport change`);
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

async function getIGNTile(z, col, row) {
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
  }).then((result) => {
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

async function getIGNTileWithFallback(z, col, row, deadlineAt) {
  const data = await getIGNTile(z, col, row);
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
    // its soft deadline, give up on the fallback chain. Without this each
    // sub-tile that 404s at native zoom can hold an IGN slot for up to
    // IGN_FALLBACK_MAX_DEPTH × IGN_FETCH_TIMEOUT_MS = 45 s while sequentially
    // trying z-1, z-2, z-3 — starving the next viewport burst and producing
    // the 17–71 s wall-clock per-tile builds the user reported. Cached
    // (z-1) hits still resolve instantly even past the deadline since
    // `getIGNTile` is short-circuited by the in-memory cache.
    if (typeof deadlineAt === 'number' && performance.now() >= deadlineAt) {
      // Try the very next zoom level only if it's already cached — costs
      // nothing and may give us a quick coarse answer the renderer uses
      // as overzoom mesh.
      const cached = getCached(`${fbZ}/${fbCol}/${fbRow}`);
      if (cached.hit && cached.data) {
        return { data: cached.data, actualZ: fbZ, actualCol: fbCol, actualRow: fbRow };
      }
      return null;
    }
    const fbData = await getIGNTile(fbZ, fbCol, fbRow);
    if (fbData) {
      return { data: fbData, actualZ: fbZ, actualCol: fbCol, actualRow: fbRow };
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
  return mercZ >= 15 ? 2 : 1;
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

async function getTerrainWmsTile(mercZ, mercX, mercY) {
  const supersample = terrainWmsSupersampleFactor(mercZ);
  const key = `wms/${mercZ}/${mercX}/${mercY}@${supersample}x`;
  const cached = getCachedTerrainWms(key);
  if (cached.hit) return cached.data;

  if (terrainWmsInflight.has(key)) return terrainWmsInflight.get(key);

  const promise = scheduleIGN(async () => {
    const cached2 = getCachedTerrainWms(key);
    if (cached2.hit) return cached2.data;

    const url = buildTerrainWmsTileURL(mercZ, mercX, mercY, supersample);
    const { controller, cleanup, init } = ignFetchInit();
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
  }).then((result) => {
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
