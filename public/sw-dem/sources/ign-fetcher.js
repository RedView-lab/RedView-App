// ---------------------------------------------------------------------------
// IGN tile fetching with in-memory LRU cache + concurrency limiter
// TTL-aware null caching + zoom-level fallback for missing tiles
// ---------------------------------------------------------------------------

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
      const res = await fetchIgnWithRetry(url, init);
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
