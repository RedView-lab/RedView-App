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
    try {
      const res = await fetch(url, { signal: AbortSignal.timeout(IGN_FETCH_TIMEOUT_MS) });
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
      cacheNull(key, 'transient');
      return null;
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

async function getIGNTileWithFallback(z, col, row) {
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

function buildTerrainWmsTileURL(mercZ, mercX, mercY) {
  const bounds = mercatorTileBounds(mercZ, mercX, mercY);
  // WMS 1.3.0 axis order for EPSG:4326 is latitude,longitude.
  const bbox = [bounds.south, bounds.west, bounds.north, bounds.east].join(',');
  // 2× supersample: ask the WMS for a 512×512 raster on the same bbox, then
  // box-average to 256×256 in getTerrainWmsTile. The IGN MNT WMS server
  // appears to use nearest-neighbour resampling along the latitude axis when
  // the requested grid spacing is finer than its native ~1 m source. At z≥15
  // a 256×256 request would return rows of identical elevations with sharp
  // jumps at source-row boundaries, which Horn's method then turns into the
  // characteristic horizontal stripe pattern in the slope overlay. Asking
  // for double the resolution and averaging is proper anti-aliasing (not a
  // post-hoc blur) and erases the staircase without softening real edges.
  return (
    `${IGN_WMS_BASE}?SERVICE=WMS&REQUEST=GetMap&VERSION=1.3.0` +
    `&LAYERS=${IGN_DEM_FALLBACK_LAYER}&STYLES=` +
    `&FORMAT=${encodeURIComponent(IGN_DEM_FORMAT)}` +
    `&CRS=EPSG:4326&BBOX=${bbox}` +
    `&WIDTH=${DEM_TILE_SIZE * 2}&HEIGHT=${DEM_TILE_SIZE * 2}`
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
    try {
      const res = await fetch(url, { signal: AbortSignal.timeout(IGN_FETCH_TIMEOUT_MS) });
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
      cacheHighresNull(key, 'transient');
      return null;
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
  const key = `wms/${mercZ}/${mercX}/${mercY}`;
  const cached = getCachedTerrainWms(key);
  if (cached.hit) return cached.data;

  if (terrainWmsInflight.has(key)) return terrainWmsInflight.get(key);

  const promise = scheduleIGN(async () => {
    const cached2 = getCachedTerrainWms(key);
    if (cached2.hit) return cached2.data;

    const url = buildTerrainWmsTileURL(mercZ, mercX, mercY);
    try {
      const res = await fetch(url, { signal: AbortSignal.timeout(IGN_FETCH_TIMEOUT_MS) });
      if (!res.ok) {
        cacheTerrainWmsNull(key, res.status === 404 ? 'permanent' : 'transient');
        return null;
      }
      const buf = await res.arrayBuffer();
      // Supersampled request: expect (DEM_TILE_SIZE*2)² float32 values.
      const SS = DEM_TILE_SIZE * 2;
      if (buf.byteLength !== SS * SS * 4) {
        cacheTerrainWmsNull(key, 'permanent');
        return null;
      }
      const hi = decodeBIL32(buf);
      // Box-average 2×2 → 1 into a DEM_TILE_SIZE² Float32Array. NaN-aware so
      // sentinel/no-data pixels never poison the average; if all four samples
      // are NaN we propagate NaN so downstream coverage tracking still works.
      const data = new Float32Array(DEM_TILE_SIZE * DEM_TILE_SIZE);
      for (let y = 0; y < DEM_TILE_SIZE; y++) {
        const sy = y * 2;
        for (let x = 0; x < DEM_TILE_SIZE; x++) {
          const sx = x * 2;
          const a = hi[sy * SS + sx];
          const b = hi[sy * SS + sx + 1];
          const c = hi[(sy + 1) * SS + sx];
          const d = hi[(sy + 1) * SS + sx + 1];
          let sum = 0, n = 0;
          if (!Number.isNaN(a)) { sum += a; n++; }
          if (!Number.isNaN(b)) { sum += b; n++; }
          if (!Number.isNaN(c)) { sum += c; n++; }
          if (!Number.isNaN(d)) { sum += d; n++; }
          data[y * DEM_TILE_SIZE + x] = n > 0 ? sum / n : NaN;
        }
      }
      evict(terrainWmsTileCache, TERRAIN_WMS_CACHE_MAX);
      terrainWmsTileCache.set(key, data);
      return data;
    } catch {
      cacheTerrainWmsNull(key, 'transient');
      return null;
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
