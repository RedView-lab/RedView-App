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
          priority: 'high',
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
        const isTransientNetworkError =
          err?.name === 'TimeoutError' ||
          err?.name === 'TypeError' ||
          msg.includes('timed out') ||
          msg.includes('aborted') ||
          msg.includes('Failed to fetch');
        if (!isTransientNetworkError) {
          console.warn(`[swiss][range] error ${url} (no retry):`, msg);
          return { _permanent: true, value: null };
        }
        console.warn(`[swiss][range] retryable ${url} (attempt ${attempt}/${SWISS_COG_RANGE_RETRIES}):`, msg);
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

// Super-window inflight: keyed by the SWISS_STAC_GRID-aligned block
// (`${EkmGrid}/${NkmGrid}`). Every cell in the block joins the same
// promise so we never fire two overlapping STAC queries for the same
// neighbourhood. Apr 24 logs showed 5+ near-identical bbox queries
// timing out concurrently because dedup was per-cell only.
const _stacWindowInflight = new Map();

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
// Returns:
//   { ok: true,  cellBest }  — STAC succeeded (cellBest may be empty if
//                              the bbox truly has no published data)
//   { ok: false }            — transient network failure (timeout, 5xx,
//                              prune). Caller MUST NOT mark cells as
//                              permanent-null; the next render retries.
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
        priority: 'high',
      });
      if (!res.ok) {
        // 4xx → permanent (treat as "ok, zero features"). 5xx → transient.
        if (res.status >= 400 && res.status < 500) {
          console.warn(`[swiss][stac] HTTP ${res.status} ${url} (permanent)`);
          return { _permanent: true, value: { features: [] } };
        }
        console.warn(`[swiss][stac] HTTP ${res.status} ${url} (transient)`);
        return null;
      }
      return { _permanent: true, value: await res.json() };
    } catch (e) {
      console.warn(`[swiss][stac] fetch error ${url}:`, e?.message || e);
      return null; // transient (timeout, network)
    }
  });
  // Pruned or transient network failure → tell caller to retry, do NOT
  // mark cells as permanent-null.
  if (!json || json === SWISS_PRUNED_SENTINEL) {
    console.warn(`[swiss][stac] transient failure for bbox ${sw.lng.toFixed(3)},${sw.lat.toFixed(3)},${ne.lng.toFixed(3)},${ne.lat.toFixed(3)}`);
    return { ok: false };
  }
  const payload = json._permanent ? json.value : json;
  if (!payload || !Array.isArray(payload.features)) {
    console.warn(`[swiss][stac] malformed payload for bbox ${sw.lng.toFixed(3)},${sw.lat.toFixed(3)},${ne.lng.toFixed(3)},${ne.lat.toFixed(3)}`);
    return { ok: false };
  }
  console.log(
    `[swiss][stac] %c bbox %c ${sw.lng.toFixed(3)},${sw.lat.toFixed(3)},${ne.lng.toFixed(3)},${ne.lat.toFixed(3)} \u2192 ${payload.features.length} features`,
    'background:#D52B1E;color:#fff;padding:1px 4px;border-radius:2px', '',
  );

  // Group features by (Ekm, Nkm) keeping the most recent year per cell.
  const cellBest = new Map();
  for (const feat of payload.features) {
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

  // STAC succeeded. Write resolved cells to cache; unresolved cells in
  // the queried window get a PERMANENT null (the catalogue has spoken:
  // no published data for that km cell).
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
  return { ok: true, cellBest };
}

// Sentinel returned by getCOGUrlForCell() when STAC failed transiently
// (network timeout, 5xx, queue prune). Distinguishes from `null`, which
// means "STAC succeeded and there is no published data here". Callers
// MUST treat this as "retry next render, do NOT poison area-neg cache".
const SWISS_STAC_TRANSIENT = Object.freeze({ _swissStacTransient: true });

async function getCOGUrlForCell(Ekm, Nkm) {
  const key = `${Ekm}/${Nkm}`;
  const cached = _stacCellGet(key);
  if (cached.hit) return cached.url;

  // Snap to a fixed grid so any cell in the same block deterministically
  // resolves through the SAME STAC query (super-window dedup). Without
  // this, sibling cells fire overlapping 5×5 queries and saturate the
  // queue → timeouts (see Apr 24 logs).
  const G = SWISS_STAC_GRID;
  const EkmGrid = Math.floor(Ekm / G) * G;
  const NkmGrid = Math.floor(Nkm / G) * G;
  const windowKey = `${EkmGrid}/${NkmGrid}`;

  const readCellOrTransient = (windowOk) => {
    const after = _stacCellGet(key);
    if (after.hit) return after.url; // resolved (URL or permanent null)
    // STAC didn't reach a verdict for this cell. If the window query
    // succeeded but the cell wasn't in its bbox somehow, treat as null.
    // Otherwise it's transient — let caller retry.
    return windowOk ? null : SWISS_STAC_TRANSIENT;
  };

  // Per-cell inflight (legacy path).
  if (_stacCellInflight.has(key)) return _stacCellInflight.get(key);

  // Per-window inflight: another cell in the same block already kicked
  // off the STAC query. Wait for it then read this cell from cache.
  const existingWindow = _stacWindowInflight.get(windowKey);
  if (existingWindow) {
    return existingWindow.then((res) => readCellOrTransient(res?.ok === true));
  }

  const windowPromise = (async () => {
    try {
      return await _resolveSwissCellsViaStac(
        EkmGrid, EkmGrid + G - 1,
        NkmGrid, NkmGrid + G - 1,
      );
    } catch (e) {
      if (DEBUG) console.warn('[swiss][stac] failed', e);
      return { ok: false };
    }
  })().finally(() => _stacWindowInflight.delete(windowKey));

  _stacWindowInflight.set(windowKey, windowPromise);

  const promise = windowPromise
    .then((res) => readCellOrTransient(res?.ok === true))
    .finally(() => _stacCellInflight.delete(key));

  _stacCellInflight.set(key, promise);
  return promise;
}

// ─── COG header cache ───────────────────────────────────────────────────────
// Map key: url → cog descriptor | { _null, ts, ttl }
const _cogHeaderCache = new Map();
const _cogHeaderInflight = new Map();

const SWISS_HEADER_INITIAL_BYTES = 32_768; // 32 KB — GDAL writes IFD0 + every overview IFD into the front "ghost" header (<4 KB total); the openSwissCOG refetch loop covers the rare outlier
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
    // Two-axis attempt loop:
    //   networkAttempt: 1..SWISS_COG_HEADER_RETRIES (retry on timeout/5xx)
    //   sizeAttempt:    0..1 (re-fetch with larger range if header doesn't fit)
    // We don't poison the negative cache on a single timeout — short TTL +
    // retry keeps the user able to keep panning without a 60 s blackout.
    let networkAttempt = 0;
    let sizeAttempt = 0;
    let permanentParseFail = false;
    while (sizeAttempt < 2 && networkAttempt < SWISS_COG_HEADER_RETRIES) {
      const buf = await swissScheduleFetch(async () => {
        try {
          const res = await fetch(url, {
            headers: { Range: `bytes=0-${bytesNeeded - 1}` },
            signal: AbortSignal.timeout(SWISS_COG_HEADER_TIMEOUT_MS),
            priority: 'high',
          });
          if (!res.ok && res.status !== 206) {
            // 4xx → permanent (file deleted / wrong URL)
            if (res.status >= 400 && res.status < 500) {
              console.warn(`[swiss][header] HTTP ${res.status} ${url} (permanent)`);
              return { _permanent: true, value: null };
            }
            console.warn(`[swiss][header] HTTP ${res.status} ${url} (attempt ${networkAttempt + 1}/${SWISS_COG_HEADER_RETRIES})`);
            return null;
          }
          return { _permanent: true, value: await res.arrayBuffer() };
        } catch (e) {
          const msg = e?.message || String(e);
          const isTimeout = e?.name === 'TimeoutError' || msg.includes('timed out') || msg.includes('aborted');
          if (!isTimeout) {
            console.warn(`[swiss][header] fetch error ${url} (no retry):`, msg);
            return { _permanent: true, value: null };
          }
          console.warn(`[swiss][header] timeout ${url} (attempt ${networkAttempt + 1}/${SWISS_COG_HEADER_RETRIES})`);
          return null;
        }
      });
      if (buf === SWISS_PRUNED_SENTINEL) {
        // Queue pruned mid-flight. Don't poison cache, let next pan retry.
        return null;
      }
      // Permanent network outcome (4xx, error, or success)
      if (buf && typeof buf === 'object' && buf._permanent) {
        if (!buf.value) {
          _headerSetNull(url, SWISS_NULL_TTL_PERMANENT);
          return null;
        }
        try {
          const parsed = await parseSwissCOGHeader(url, new Uint8Array(buf.value));
          if (parsed && parsed._needMoreBytes) {
            bytesNeeded = Math.min(parsed._needMoreBytes + 1024, SWISS_HEADER_MAX_BYTES);
            if (sizeAttempt === 1) {
              permanentParseFail = true;
              break;
            }
            sizeAttempt++;
            networkAttempt = 0; // reset network retries for the bigger fetch
            continue;
          }
          cog = parsed;
          break;
        } catch (err) {
          console.warn(`[swiss][header] parse failed for ${url}:`, err.message);
          permanentParseFail = true;
          break;
        }
      }
      // Transient (timeout / 5xx) — retry
      networkAttempt++;
      if (networkAttempt < SWISS_COG_HEADER_RETRIES) {
        await new Promise((r) => setTimeout(r, 250 + Math.random() * 500));
      }
    }
    if (!cog) {
      // Permanent parse failure → long TTL. Transient (all retries timed out)
      // → very short TTL so the next pan can retry instead of blacking out.
      _headerSetNull(url, permanentParseFail ? SWISS_NULL_TTL_PERMANENT : SWISS_NULL_TTL_TRANSIENT);
      return null;
    }
    console.log(
      `[swiss][header] %c OK %c ${url.split('/').pop()} \u2192 ${cog.levels.length} levels (${cog.levels.map((l) => `${l.width}\u00d7${l.height}@${l.pixelScaleX.toFixed(2)}m`).join(', ')}), origin=(${cog.originE.toFixed(0)},${cog.originN.toFixed(0)})`,
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

async function getCOGInternalTile(cog, levelIdx, tileIndex) {
  const key = `${cog.url}#L${levelIdx}#${tileIndex}`;
  const cached = _tileGet(key);
  if (cached.hit) return cached.data;
  if (_tileInflight.has(key)) return _tileInflight.get(key);

  const promise = (async () => {
    try {
      const data = await fetchAndDecodeTile(cog, levelIdx, tileIndex, swissRangeFetch);
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

// Synchronous cache reader — returns the decoded Float32Array if it is already
// resident, else null. Used by the sync bilinear sampler after a prefetch has
// guaranteed the needed tiles are in cache.
function getCOGInternalTileCached(cog, levelIdx, tileIndex) {
  const e = _tileCache.get(`${cog.url}#L${levelIdx}#${tileIndex}`);
  if (!e || e._null) return null;
  return e;
}

// ─── Coalesced multi-tile prefetch ──────────────────────────────────────────
// Groups the requested internal tiles of one COG level into contiguous
// byte-range runs and issues ONE Range request per run. swisstopo writes a
// level's tiles contiguously in file order, so a cell that needs several
// adjacent tiles (native / high zoom) collapses from N HTTP requests to ~1.
// Each tile is still decoded individually (every tile is compressed on its
// own) and cached under its own key, so getCOGInternalTile() and the sync
// sampler both find it afterwards.
const SWISS_RANGE_MERGE_GAP = 16 * 1024;      // merge tiles ≤16 KB apart in the file
const SWISS_RANGE_MAX_SPAN = 6 * 1024 * 1024; // cap a single coalesced fetch at 6 MB

async function prefetchCOGTilesCoalesced(cog, levelIdx, tileIndices) {
  const level = cog.levels[levelIdx];
  if (!level) return;

  // Dedup + drop tiles already cached or in-flight; collect their byte ranges.
  const seen = new Set();
  const need = [];
  for (const ti of tileIndices) {
    if (seen.has(ti)) continue;
    seen.add(ti);
    const key = `${cog.url}#L${levelIdx}#${ti}`;
    if (_tileGet(key).hit) continue;
    if (_tileInflight.has(key)) continue;
    const offset = level.tileOffsets[ti];
    const length = level.tileByteCounts[ti];
    if (!Number.isFinite(offset) || !Number.isFinite(length) || length <= 0) {
      _tileSetNull(key, SWISS_NULL_TTL_TRANSIENT);
      continue;
    }
    need.push({ ti, offset, length, key });
  }
  if (need.length === 0) return;

  need.sort((a, b) => a.offset - b.offset);

  // Build contiguous runs (merge tiles whose gap ≤ MERGE_GAP, span ≤ MAX_SPAN).
  const runs = [];
  let cur = null;
  for (const t of need) {
    const end = t.offset + t.length;
    if (cur && t.offset - cur.end <= SWISS_RANGE_MERGE_GAP && end - cur.start <= SWISS_RANGE_MAX_SPAN) {
      cur.tiles.push(t);
      if (end > cur.end) cur.end = end;
    } else {
      cur = { start: t.offset, end, tiles: [t] };
      runs.push(cur);
    }
  }

  await Promise.all(runs.map(async (run) => {
    if (run.tiles.length === 1) {
      // Singleton — defer to the normal cached/inflight path (no merge gain).
      await getCOGInternalTile(cog, levelIdx, run.tiles[0].ti);
      return;
    }
    const span = run.end - run.start;
    const fetchPromise = swissRangeFetch(cog.url, run.start, span);
    // Register a per-tile inflight promise derived from the shared fetch so a
    // concurrent build for any of these tiles dedups onto this request.
    const tilePromises = run.tiles.map((t) => {
      const p = fetchPromise
        .then(async (buf) => {
          if (!buf) { _tileSetNull(t.key, SWISS_NULL_TTL_TRANSIENT); return null; }
          const sub = buf.slice(t.offset - run.start, t.offset - run.start + t.length);
          const data = await decodeSwissTileBytes(level, levelIdx, t.ti, sub);
          if (!data) { _tileSetNull(t.key, SWISS_NULL_TTL_TRANSIENT); return null; }
          _tileCache.set(t.key, data);
          evictMap(_tileCache, SWISS_TILE_CACHE_MAX);
          return data;
        })
        .finally(() => {
          if (_tileInflight.get(t.key) === p) _tileInflight.delete(t.key);
        });
      _tileInflight.set(t.key, p);
      return p;
    });
    await Promise.all(tilePromises);
  }));
}
async function sampleSwissElevation(E, N) {
  if (
    E < SWISS_LV95_BOUNDS.Emin || E > SWISS_LV95_BOUNDS.Emax ||
    N < SWISS_LV95_BOUNDS.Nmin || N > SWISS_LV95_BOUNDS.Nmax
  ) return NaN;

  const Ekm = Math.floor(E / 1000);
  const Nkm = Math.floor(N / 1000);
  const url = await getCOGUrlForCell(Ekm, Nkm);
  if (!url || url === SWISS_STAC_TRANSIENT) return NaN;
  const cog = await openSwissCOG(url);
  if (!cog) return NaN;
  return sampleSwissCOG(cog, 0, E, N, (lvl, idx) => getCOGInternalTile(cog, lvl, idx));
}
