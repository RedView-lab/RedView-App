// ---------------------------------------------------------------------------
// In-memory hot tiers (Map-as-LRU) in front of CacheStorage for the DEM,
// slope, altitude and ortho endpoints: cached tiles answer in < 1 ms.
// ---------------------------------------------------------------------------

// ──────────────────────────────────────────────────────────────────────────
// DEM_HOT_CACHE — in-memory LRU of recently served DEM tile blobs.
//
// Motivation: every cache hit currently pays for `caches.open(CACHE_NAME)`
// (~1-5 ms) + `cache.match(key)` (~5-25 ms on disk-backed CacheStorage).
// On a single zoom-out a 60° pitched viewport at z14 needs ~25-50 tiles,
// and a satellite/topo style switch re-asks for ~150 tiles within a few
// hundred ms. Even when every tile is already cached on disk, the
// cumulative CacheStorage round-trip latency stacks into 0.5–2.5 s of
// pure I/O overhead on the SW thread — exactly the kind of stall that
// makes the user perceive "the map is dragging".
//
// This hot tier sits in FRONT of CacheStorage and returns a fresh Response
// (clone of the blob) in <1 ms. Hit ratios above 80 % are routine on a
// session where the user is zooming/panning inside the same region.
//
// Size budget: 192 entries × ~120 KB average terrain-RGB PNG ≈ 23 MB peak
// — trivial vs the 1 GB+ working set Mapbox itself keeps in WebGL textures.
//
// Eviction: classic Map-as-LRU. We re-insert on every get so the iteration
// order matches recency, then drop the oldest keys when the size cap is
// exceeded. No expiry — entries are invalidated by epoch bump (cache name
// changes → activate purges everything → hot cache survives but is just
// stale references that never get queried again because the cacheKey URL
// embeds the epoch via demProfile and PURGE messages call demHotClear).
// ──────────────────────────────────────────────────────────────────────────
const DEM_HOT_CACHE_DEFAULT_MAX = 512;
let DEM_HOT_CACHE_MAX = DEM_HOT_CACHE_DEFAULT_MAX;
const DEM_HOT_CACHE = new Map();

function demHotGet(keyStr) {
  const entry = DEM_HOT_CACHE.get(keyStr);
  if (!entry) return null;
  // Refresh LRU position
  DEM_HOT_CACHE.delete(keyStr);
  DEM_HOT_CACHE.set(keyStr, entry);
  return entry;
}

function demHotPut(keyStr, blob, headerInit) {
  if (!blob) return;
  if (DEM_HOT_CACHE.has(keyStr)) DEM_HOT_CACHE.delete(keyStr);
  DEM_HOT_CACHE.set(keyStr, { blob, headers: headerInit });
  if (DEM_HOT_CACHE.size > DEM_HOT_CACHE_MAX) {
    const drop = DEM_HOT_CACHE.size - Math.floor(DEM_HOT_CACHE_MAX * 0.85);
    const iter = DEM_HOT_CACHE.keys();
    for (let i = 0; i < drop; i++) {
      const k = iter.next().value;
      if (k === undefined) break;
      DEM_HOT_CACHE.delete(k);
    }
  }
}

function demHotClear() {
  DEM_HOT_CACHE.clear();
}

// Reconstruct a fresh Response from a hot-cache entry. Each call gets its
// own Response wrapper (cheap) backed by the SAME Blob (zero-copy on
// most engines — the renderer just bumps an internal ref count).
function demHotResponse(entry) {
  return new Response(entry.blob, { status: 200, headers: entry.headers });
}

// Resize the DEM hot tier at runtime. Called when slope or altitude is enabled.
let _slopeActive = false;
let _altitudeActive = false;

function syncDemHotCacheCapacity() {
  if (_slopeActive || _altitudeActive) {
    setDemHotCacheCapacity(
      (typeof DEM_HOT_CACHE_MAX_SLOPE_ACTIVE !== 'undefined')
        ? DEM_HOT_CACHE_MAX_SLOPE_ACTIVE
        : 2048
    );
  } else {
    setDemHotCacheCapacity(DEM_HOT_CACHE_DEFAULT_MAX);
  }
}

function setDemHotCacheCapacity(newMax) {
  if (!Number.isFinite(newMax) || newMax < 32) return;
  DEM_HOT_CACHE_MAX = newMax;
  if (DEM_HOT_CACHE.size > DEM_HOT_CACHE_MAX) {
    const drop = DEM_HOT_CACHE.size - Math.floor(DEM_HOT_CACHE_MAX * 0.85);
    const iter = DEM_HOT_CACHE.keys();
    for (let i = 0; i < drop; i++) {
      const k = iter.next().value;
      if (k === undefined) break;
      DEM_HOT_CACHE.delete(k);
    }
  }
}

// ──────────────────────────────────────────────────────────────────────────
// SLOPE_HOT_CACHE — in-memory LRU of recently served slope PNG blobs.
//
// Mirrors DEM_HOT_CACHE in front of CacheStorage for the /slope-tiles
// endpoint. Every slope cache hit currently pays 5-25 ms on the SW thread
// for caches.open() + cache.match(). On a resolution switch (0.40m ↔ 1m)
// or a pan-back, the same viewport re-asks for ~25-50 slope tiles within a
// few hundred ms; even when every one is cached on disk the cumulative
// CacheStorage latency stacks into 0.5-2 s of pure I/O — exactly the
// "switch isn't instant" symptom. This tier returns a fresh Response in
// <1 ms, so cached slope tiles paint immediately.
//
// Size budget: 192 × ~8 KB average slope PNG ≈ 1.5 MB peak — trivial.
// ──────────────────────────────────────────────────────────────────────────
const SLOPE_HOT_CACHE = new Map();

function slopeHotGet(keyStr) {
  const entry = SLOPE_HOT_CACHE.get(keyStr);
  if (!entry) return null;
  SLOPE_HOT_CACHE.delete(keyStr);
  SLOPE_HOT_CACHE.set(keyStr, entry);
  return entry;
}

function slopeHotPut(keyStr, blob, headerInit) {
  if (!blob) return;
  if (SLOPE_HOT_CACHE.has(keyStr)) SLOPE_HOT_CACHE.delete(keyStr);
  SLOPE_HOT_CACHE.set(keyStr, { blob, headers: headerInit });
  if (SLOPE_HOT_CACHE.size > SLOPE_HOT_CACHE_MAX) {
    const drop = SLOPE_HOT_CACHE.size - Math.floor(SLOPE_HOT_CACHE_MAX * 0.85);
    const iter = SLOPE_HOT_CACHE.keys();
    for (let i = 0; i < drop; i++) {
      const k = iter.next().value;
      if (k === undefined) break;
      SLOPE_HOT_CACHE.delete(k);
    }
  }
}

function slopeHotDelete(keyStr) {
  SLOPE_HOT_CACHE.delete(keyStr);
}

function slopeHotInvalidateZoneDownsampled(zoneHash) {
  if (!zoneHash) return;
  const zoneSub = `zone=${zoneHash}`;
  for (const key of Array.from(SLOPE_HOT_CACHE.keys())) {
    if (key.includes(zoneSub)) {
      SLOPE_HOT_CACHE.delete(key);
    }
  }
}

function slopeHotClear() {
  SLOPE_HOT_CACHE.clear();
}

// Drops every hot entry of one slope tile, whatever its profile / source /
// query (keys look like `${sourceDem}:${profile}:/slope-tiles/z/x/y?…`).
function slopeHotDeleteTile(z, x, y) {
  const path = `/slope-tiles/${z}/${x}/${y}`;
  for (const key of Array.from(SLOPE_HOT_CACHE.keys())) {
    const at = key.indexOf(path);
    if (at < 0) continue;
    const next = key.charAt(at + path.length);
    if (next === '' || next === '?') SLOPE_HOT_CACHE.delete(key);
  }
}

function slopeHotResponse(entry) {
  return new Response(entry.blob, { status: 200, headers: entry.headers });
}

// ──────────────────────────────────────────────────────────────────────────
// ALTITUDE_HOT_CACHE — in-memory LRU of recently served altitude PNG blobs.
//
// Mirrors SLOPE_HOT_CACHE in front of CacheStorage for the /altitude-tiles
// endpoint. Every altitude cache hit currently pays 5-25 ms on the SW thread
// for caches.open() + cache.match(). On a toggle off/on, a Mapbox repaint
// or a pan-back, the same viewport re-asks for ~25-50 altitude tiles within
// a few hundred ms; even when every one is cached on disk the cumulative
// CacheStorage latency stacks into ~0.5-2 s of pure I/O — exactly the
// "altitude overlay is sluggish" symptom. This tier returns a fresh Response
// in <1 ms, so cached altitude tiles paint immediately.
//
// Size budget: 192 × ~4 KB average altitude PNG ≈ 0.8 MB peak — trivial.
// ──────────────────────────────────────────────────────────────────────────
const ALTITUDE_HOT_CACHE = new Map();

function altitudeHotGet(keyStr) {
  const entry = ALTITUDE_HOT_CACHE.get(keyStr);
  if (!entry) return null;
  ALTITUDE_HOT_CACHE.delete(keyStr);
  ALTITUDE_HOT_CACHE.set(keyStr, entry);
  return entry;
}

function altitudeHotPut(keyStr, blob, headerInit) {
  if (!blob) return;
  if (ALTITUDE_HOT_CACHE.has(keyStr)) ALTITUDE_HOT_CACHE.delete(keyStr);
  ALTITUDE_HOT_CACHE.set(keyStr, { blob, headers: headerInit });
  if (ALTITUDE_HOT_CACHE.size > ALTITUDE_HOT_CACHE_MAX) {
    const drop = ALTITUDE_HOT_CACHE.size - Math.floor(ALTITUDE_HOT_CACHE_MAX * 0.85);
    const iter = ALTITUDE_HOT_CACHE.keys();
    for (let i = 0; i < drop; i++) {
      const k = iter.next().value;
      if (k === undefined) break;
      ALTITUDE_HOT_CACHE.delete(k);
    }
  }
}

function altitudeHotClear() {
  ALTITUDE_HOT_CACHE.clear();
}

function altitudeHotResponse(entry) {
  return new Response(entry.blob, { status: 200, headers: entry.headers });
}

// ──────────────────────────────────────────────────────────────────────────
// ORTHO_HOT_CACHE — in-memory LRU of recently served orthophoto image blobs.
//
// Eliminates CacheStorage disk round-trips for the /ortho-tiles endpoint.
// Returns a fresh Response in <1 ms so cached orthophoto tiles paint instantly.
// Size budget: 192 × ~25 KB average JPEG ≈ 4.8 MB peak.
// ──────────────────────────────────────────────────────────────────────────
const ORTHO_HOT_CACHE_MAX = 192;
const ORTHO_HOT_CACHE = new Map();

function orthoHotGet(keyStr) {
  const entry = ORTHO_HOT_CACHE.get(keyStr);
  if (!entry) return null;
  ORTHO_HOT_CACHE.delete(keyStr);
  ORTHO_HOT_CACHE.set(keyStr, entry);
  return entry;
}

function orthoHotPut(keyStr, blob, headerInit) {
  if (!blob) return;
  if (ORTHO_HOT_CACHE.has(keyStr)) ORTHO_HOT_CACHE.delete(keyStr);
  ORTHO_HOT_CACHE.set(keyStr, { blob, headers: headerInit });
  if (ORTHO_HOT_CACHE.size > ORTHO_HOT_CACHE_MAX) {
    const drop = ORTHO_HOT_CACHE.size - Math.floor(ORTHO_HOT_CACHE_MAX * 0.85);
    const iter = ORTHO_HOT_CACHE.keys();
    for (let i = 0; i < drop; i++) {
      const k = iter.next().value;
      if (k === undefined) break;
      ORTHO_HOT_CACHE.delete(k);
    }
  }
}

function orthoHotClear() {
  ORTHO_HOT_CACHE.clear();
}

function orthoHotResponse(entry) {
  return new Response(entry.blob, { status: 200, headers: entry.headers });
}
