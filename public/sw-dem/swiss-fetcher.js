// ---------------------------------------------------------------------------
// swissSURFACE3D fetcher — STAC catalogue + COG cache + range scheduler
// ---------------------------------------------------------------------------
// Three layers of caching, with TTL-aware null handling:
//
//   1. STAC cell cache  : (Ekm, Nkm) → { url, year } | null
//        Resolves which COG file holds a given LV95 1-km cell.
//   2. COG header cache : url → { width, tileOffsets, … } | null
//        Parsed TIFF header; tells us how to range-fetch internal tiles.
//   3. Internal tile cache : `${url}#${tileIndex}` → Float32Array | null
//        Decompressed Float32 tile (typically 256×256 = 256 KB).
//
// Concurrency: every network fetch (STAC, COG header, COG range) goes through
// `swissScheduleFetch()` so the pipeline never opens more than
// SWISS_CONCURRENCY HTTP/2 streams at once. Same LIFO/oldest-prune semantics
// as the IGN scheduler, with our own SWISS_PRUNED_SENTINEL.
// ---------------------------------------------------------------------------

// ─── Concurrency limiter ────────────────────────────────────────────────────
let _swissActive = 0;
const _swissQueue = [];
let _swissPrunedTotal = 0;

function swissScheduleFetch(fn) {
  return new Promise((resolve, reject) => {
    _swissQueue.push({ fn, resolve, reject, ts: performance.now() });
    let pruned = 0;
    while (_swissQueue.length > SWISS_QUEUE_MAX) {
      let oldestIdx = 0, oldestTs = _swissQueue[0].ts;
      for (let i = 1; i < _swissQueue.length; i++) {
        if (_swissQueue[i].ts < oldestTs) { oldestTs = _swissQueue[i].ts; oldestIdx = i; }
      }
      const stale = _swissQueue.splice(oldestIdx, 1)[0];
      stale.resolve(SWISS_PRUNED_SENTINEL);
      pruned++;
    }
    if (pruned > 0) {
      _swissPrunedTotal += pruned;
      if (DEBUG) console.warn(`[swiss][queue] pruned ${pruned} (lifetime=${_swissPrunedTotal})`);
    }
    drainSwissQueue();
  });
}

function drainSwissQueue() {
  while (_swissActive < SWISS_CONCURRENCY && _swissQueue.length > 0) {
    const { fn, resolve, reject } = _swissQueue.pop(); // LIFO
    _swissActive++;
    fn().then(resolve).catch(reject).finally(() => {
      _swissActive--;
      drainSwissQueue();
    });
  }
}

// Range-fetch helper used by the COG reader. Always returns ArrayBuffer | null.
// Retries up to SWISS_COG_RANGE_RETRIES times on timeout / network error
// (NOT on HTTP 4xx, which are permanent). Each retry takes a fresh slot so
// it doesn't block the head of the queue.
async function swissRangeFetch(url, offset, length) {
  for (let attempt = 1; attempt <= SWISS_COG_RANGE_RETRIES; attempt++) {
    const result = await swissScheduleFetch(async () => {
      try {
        const res = await fetch(url, {
          headers: { Range: `bytes=${offset}-${offset + length - 1}` },
          signal: AbortSignal.timeout(SWISS_COG_RANGE_TIMEOUT_MS),
        });
        if (!res.ok && res.status !== 206) {
          // Permanent: 4xx → don't retry. 5xx → retry.
          if (res.status >= 400 && res.status < 500) {
            console.warn(`[swiss][range] HTTP ${res.status} ${url} bytes=${offset}-${offset + length - 1} (no retry)`);
            return { _permanent: true, value: null };
          }
          console.warn(`[swiss][range] HTTP ${res.status} ${url} bytes=${offset}-${offset + length - 1} (attempt ${attempt}/${SWISS_COG_RANGE_RETRIES})`);
          return null;
        }
        return { _permanent: true, value: await res.arrayBuffer() };
      } catch (err) {
        const msg = err?.message || String(err);
        const isTimeout = err?.name === 'TimeoutError' || msg.includes('timed out') || msg.includes('aborted');
        if (!isTimeout) {
          console.warn(`[swiss][range] error ${url} (no retry):`, msg);
          return { _permanent: true, value: null };
        }
        console.warn(`[swiss][range] timeout ${url} (attempt ${attempt}/${SWISS_COG_RANGE_RETRIES})`);
        return null;
      }
    });
    if (result === SWISS_PRUNED_SENTINEL) return null;
    if (result && typeof result === 'object' && result._permanent) return result.value;
    if (attempt < SWISS_COG_RANGE_RETRIES) {
      // Brief jittered back-off so we don't all retry in lockstep.
      await new Promise((r) => setTimeout(r, 200 + Math.random() * 400));
    }
  }
  return null;
}

// ─── STAC cell-resolution cache ─────────────────────────────────────────────
// Map key: `${Ekm}/${Nkm}` → { url } | { _null, ts, ttl }
const _stacCellCache = new Map();
const _stacCellInflight = new Map();

function evictMap(cache, max) {
  if (cache.size <= max) return;
  const iter = cache.keys();
  const toDelete = cache.size - Math.floor(max * 0.75);
  for (let i = 0; i < toDelete; i++) {
    const k = iter.next().value;
    if (k !== undefined) cache.delete(k);
  }
}

function _stacCellGet(key) {
  const e = _stacCellCache.get(key);
  if (!e) return { hit: false };
  if (e._null) {
    if (Date.now() - e.ts < e.ttl) return { hit: true, url: null };
    _stacCellCache.delete(key);
    return { hit: false };
  }
  return { hit: true, url: e.url };
}

function _stacCellSetNull(key, ttl) {
  _stacCellCache.set(key, { _null: true, ts: Date.now(), ttl });
  evictMap(_stacCellCache, SWISS_STAC_CELL_CACHE_MAX);
}

// Issue a single STAC bbox query covering up to a 5×5 km super-window so
// we resolve many adjacent cells in one round-trip. The returned items
// are then exploded into the per-cell cache.
//
// Item ID grammar:  swisssurface3d-raster_{year}_{Ekm}-{Nkm}
// Asset href is the canonical COG URL we want.
async function _resolveSwissCellsViaStac(EkmMin, EkmMax, NkmMin, NkmMax) {
  // STAC bbox is in WGS84. Convert the corners.
  const sw = lv95ToWGS84(EkmMin * 1000, NkmMin * 1000);
  const ne = lv95ToWGS84((EkmMax + 1) * 1000, (NkmMax + 1) * 1000);
  const url =
    `${SWISS_STAC_BASE}` +
    `?bbox=${sw.lng.toFixed(6)},${sw.lat.toFixed(6)},${ne.lng.toFixed(6)},${ne.lat.toFixed(6)}` +
    `&limit=200`;

  const json = await swissScheduleFetch(async () => {
    try {
      const res = await fetch(url, {
        headers: { Accept: 'application/json' },
        signal: AbortSignal.timeout(SWISS_STAC_FETCH_TIMEOUT_MS),
      });
      if (!res.ok) {
        console.warn(`[swiss][stac] HTTP ${res.status} ${url}`);
        return null;
      }
      return await res.json();
    } catch (e) {
      console.warn(`[swiss][stac] fetch error ${url}:`, e?.message || e);
      return null;
    }
  });
  if (!json || json === SWISS_PRUNED_SENTINEL || !Array.isArray(json.features)) {
    console.warn(`[swiss][stac] no features for bbox ${sw.lng.toFixed(3)},${sw.lat.toFixed(3)},${ne.lng.toFixed(3)},${ne.lat.toFixed(3)}`);
    return null;
  }
  console.log(
    `[swiss][stac] %c bbox %c ${sw.lng.toFixed(3)},${sw.lat.toFixed(3)},${ne.lng.toFixed(3)},${ne.lat.toFixed(3)} \u2192 ${json.features.length} features`,
    'background:#D52B1E;color:#fff;padding:1px 4px;border-radius:2px', '',
  );

  // Group features by (Ekm, Nkm) keeping the most recent year per cell.
  const cellBest = new Map();
  for (const feat of json.features) {
    const id = feat.id || '';
    const m = id.match(/^swisssurface3d-raster_(\d{4})_(\d+)-(\d+)$/);
    if (!m) continue;
    const year = parseInt(m[1], 10);
    const Ekm = parseInt(m[2], 10);
    const Nkm = parseInt(m[3], 10);
    const cellKey = `${Ekm}/${Nkm}`;

    // Pick the COG asset (there may also be xyz.zip / etc.)
    let cogHref = null;
    if (feat.assets) {
      for (const [assetKey, asset] of Object.entries(feat.assets)) {
        if (assetKey.endsWith('.tif') && (asset?.type || '').includes('tiff')) {
          cogHref = asset.href;
          break;
        }
      }
    }
    if (!cogHref) continue;

    const prev = cellBest.get(cellKey);
    if (!prev || prev.year < year) {
      cellBest.set(cellKey, { year, url: cogHref });
    }
  }

  // Write resolved cells to cache; unresolved cells get a permanent null.
  for (let Ekm = EkmMin; Ekm <= EkmMax; Ekm++) {
    for (let Nkm = NkmMin; Nkm <= NkmMax; Nkm++) {
      const key = `${Ekm}/${Nkm}`;
      const best = cellBest.get(key);
      if (best) {
        _stacCellCache.set(key, { url: best.url, year: best.year });
      } else {
        _stacCellSetNull(key, SWISS_NULL_TTL_PERMANENT);
      }
    }
  }
  evictMap(_stacCellCache, SWISS_STAC_CELL_CACHE_MAX);
  return cellBest;
}

async function getCOGUrlForCell(Ekm, Nkm) {
  const key = `${Ekm}/${Nkm}`;
  const cached = _stacCellGet(key);
  if (cached.hit) return cached.url;

  if (_stacCellInflight.has(key)) return _stacCellInflight.get(key);

  // Cluster nearby cells into one STAC query (5×5 window centred on cell)
  const win = 2;
  const EkmMin = Ekm - win, EkmMax = Ekm + win;
  const NkmMin = Nkm - win, NkmMax = Nkm + win;

  const promise = (async () => {
    try {
      await _resolveSwissCellsViaStac(EkmMin, EkmMax, NkmMin, NkmMax);
    } catch (e) {
      // Transient — short null TTL on this cell so we retry soon.
      _stacCellSetNull(key, SWISS_NULL_TTL_TRANSIENT);
      if (DEBUG) console.warn('[swiss][stac] failed', e);
    }
    const after = _stacCellGet(key);
    return after.hit ? after.url : null;
  })().finally(() => _stacCellInflight.delete(key));

  _stacCellInflight.set(key, promise);
  return promise;
}

// ─── COG header cache ───────────────────────────────────────────────────────
// Map key: url → cog descriptor | { _null, ts, ttl }
const _cogHeaderCache = new Map();
const _cogHeaderInflight = new Map();

const SWISS_HEADER_INITIAL_BYTES = 32_768;
const SWISS_HEADER_MAX_BYTES = 524_288;

function _headerGet(url) {
  const e = _cogHeaderCache.get(url);
  if (!e) return { hit: false };
  if (e._null) {
    if (Date.now() - e.ts < e.ttl) return { hit: true, cog: null };
    _cogHeaderCache.delete(url);
    return { hit: false };
  }
  return { hit: true, cog: e };
}

function _headerSetNull(url, ttl) {
  _cogHeaderCache.set(url, { _null: true, ts: Date.now(), ttl });
  evictMap(_cogHeaderCache, SWISS_HEADER_CACHE_MAX);
}

async function openSwissCOG(url) {
  const cached = _headerGet(url);
  if (cached.hit) return cached.cog;
  if (_cogHeaderInflight.has(url)) return _cogHeaderInflight.get(url);

  const promise = (async () => {
    let bytesNeeded = SWISS_HEADER_INITIAL_BYTES;
    let cog = null;
    for (let attempt = 0; attempt < 2; attempt++) {
      const buf = await swissScheduleFetch(async () => {
        try {
          const res = await fetch(url, {
            headers: { Range: `bytes=0-${bytesNeeded - 1}` },
            signal: AbortSignal.timeout(SWISS_COG_HEADER_TIMEOUT_MS),
          });
          if (!res.ok && res.status !== 206) {
            console.warn(`[swiss][header] HTTP ${res.status} ${url}`);
            return null;
          }
          return await res.arrayBuffer();
        } catch (e) {
          console.warn(`[swiss][header] fetch error ${url}:`, e?.message || e);
          return null;
        }
      });
      if (!buf || buf === SWISS_PRUNED_SENTINEL) {
        _headerSetNull(url, SWISS_NULL_TTL_TRANSIENT);
        return null;
      }
      try {
        const parsed = await parseSwissCOGHeader(url, new Uint8Array(buf));
        if (parsed && parsed._needMoreBytes) {
          bytesNeeded = Math.min(parsed._needMoreBytes + 1024, SWISS_HEADER_MAX_BYTES);
          if (attempt === 1) {
            // Header genuinely doesn't fit → mark permanent null.
            _headerSetNull(url, SWISS_NULL_TTL_PERMANENT);
            return null;
          }
          continue;
        }
        cog = parsed;
        break;
      } catch (err) {
        console.warn(`[swiss][header] parse failed for ${url}:`, err.message);
        _headerSetNull(url, SWISS_NULL_TTL_PERMANENT);
        return null;
      }
    }
    if (!cog) return null;
    console.log(
      `[swiss][header] %c OK %c ${url.split('/').pop()} \u2192 ${cog.width}\u00d7${cog.height} px, tile ${cog.tileW}\u00d7${cog.tileH}, comp=${cog.compression}, origin=(${cog.originE.toFixed(0)},${cog.originN.toFixed(0)})`,
      'background:#4CAF50;color:#fff;padding:1px 4px;border-radius:2px', '',
    );
    _cogHeaderCache.set(url, cog);
    evictMap(_cogHeaderCache, SWISS_HEADER_CACHE_MAX);
    return cog;
  })().finally(() => _cogHeaderInflight.delete(url));

  _cogHeaderInflight.set(url, promise);
  return promise;
}

// ─── Internal-tile cache ────────────────────────────────────────────────────
// Map key: `${url}#${tileIndex}` → Float32Array | null marker
const _tileCache = new Map();
const _tileInflight = new Map();

function _tileGet(key) {
  const e = _tileCache.get(key);
  if (!e) return { hit: false };
  if (e._null) {
    if (Date.now() - e.ts < e.ttl) return { hit: true, data: null };
    _tileCache.delete(key);
    return { hit: false };
  }
  return { hit: true, data: e };
}

function _tileSetNull(key, ttl) {
  _tileCache.set(key, { _null: true, ts: Date.now(), ttl });
  evictMap(_tileCache, SWISS_TILE_CACHE_MAX);
}

async function getCOGInternalTile(cog, tileIndex) {
  const key = `${cog.url}#${tileIndex}`;
  const cached = _tileGet(key);
  if (cached.hit) return cached.data;
  if (_tileInflight.has(key)) return _tileInflight.get(key);

  const promise = (async () => {
    try {
      const data = await fetchAndDecodeTile(cog, tileIndex, swissRangeFetch);
      if (!data) {
        _tileSetNull(key, SWISS_NULL_TTL_TRANSIENT);
        return null;
      }
      _tileCache.set(key, data);
      evictMap(_tileCache, SWISS_TILE_CACHE_MAX);
      return data;
    } catch (e) {
      console.warn(`[swiss][tile] decode failed`, e);
      _tileSetNull(key, SWISS_NULL_TTL_TRANSIENT);
      return null;
    }
  })().finally(() => _tileInflight.delete(key));

  _tileInflight.set(key, promise);
  return promise;
}

// High-level helper: given an LV95 point, sample elevation. Returns NaN if
// no data (cell unsurveyed, COG unreachable, etc.).
async function sampleSwissElevation(E, N) {
  if (
    E < SWISS_LV95_BOUNDS.Emin || E > SWISS_LV95_BOUNDS.Emax ||
    N < SWISS_LV95_BOUNDS.Nmin || N > SWISS_LV95_BOUNDS.Nmax
  ) return NaN;

  const Ekm = Math.floor(E / 1000);
  const Nkm = Math.floor(N / 1000);
  const url = await getCOGUrlForCell(Ekm, Nkm);
  if (!url) return NaN;
  const cog = await openSwissCOG(url);
  if (!cog) return NaN;
  return sampleSwissCOG(cog, E, N, (idx) => getCOGInternalTile(cog, idx));
}
