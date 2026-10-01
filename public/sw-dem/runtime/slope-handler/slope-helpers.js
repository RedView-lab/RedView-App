// ---------------------------------------------------------------------------
// Slope Tile Processing — Shared Helpers
// ---------------------------------------------------------------------------

const DEBUG_SLOPE = false;

// Native zoom of the global (AWS 30 m) slope. Same cap as the 30 m mode
// (slope-source.ts resolveSlopeMaxZoom): beyond it AWS Terrarium tiles are
// server-side upsampled and Horn turns the interpolation into hatching, so
// higher zooms reuse the z13 slope instead (see buildUpsampledGlobalSlopeResponse).
const GLOBAL_SLOPE_NATIVE_MAX_Z = 13;

// Deepest HD slope zoom (same as slope-source.ts): past it the national
// rasters are upsampled and Mapbox overzooms the z16 slope itself.
const HD_SLOPE_MAX_Z = 16;

// Terrain-aligned tiles are drawn over 1024–2048 CSS px for 256 DEM cells:
// the slope is upsampled 2× here with a smooth cubic (slope-math.js) so the
// GPU's bilinear magnification has 4× less to stretch. Zone tiles (z14
// pipeline) stay at native resolution.
const SLOPE_OUTPUT_SCALE = 2;

function logDemPente(...args) {
  if (!DEBUG_SLOPE) return;
  console.log('[DEM PENTE]', ...args);
  try {
    self.clients.matchAll({ type: 'window' }).then((clients) => {
      clients.forEach((client) => {
        client.postMessage({
          type: 'DEM_PENTE_LOG',
          message: args.map((a) => (typeof a === 'object' ? JSON.stringify(a) : String(a))).join(' '),
        });
      });
    }).catch(() => {});
  } catch { /* ignore */ }
}

async function invalidateParentDownsampledSlopeTiles(z, x, y, zoneHash) {
  if (!zoneHash) return;
  try {
    if (typeof slopeHotInvalidateZoneDownsampled === 'function') {
      slopeHotInvalidateZoneDownsampled(zoneHash);
    }
    const slopeCache = await caches.open(SLOPE_CACHE_NAME);
    const keys = await slopeCache.keys();
    const zoneSub = `zone=${zoneHash}`;
    const toDelete = [];
    for (const req of keys) {
      const url = req.url;
      if (url.includes(zoneSub)) {
        const match = url.match(/\/slope-tiles\/(\d+)\//);
        if (match && parseInt(match[1], 10) < 14) {
          toDelete.push(slopeCache.delete(req));
        }
      }
    }
    await Promise.all(toDelete);
  } catch { /* best-effort */ }
}

// ── Stale slope tiles → page-side source reload ───────────────────────
// Mapbox treats any 200 image as final: a provisional slope tile (missing
// neighbour, stand-in DEM, ancestor fallback, transparent placeholder) stays
// on screen until the tile leaves the viewport. The SW cannot push a tile,
// so it tells the page, which reloads the slope source once the map settles
// (listeners.ts); complete tiles come straight back from the hot tier, the
// stale ones are rebuilt.
//
// Notifications driven by a DEM tile landing (notifySlopeDemTileReady) are
// never capped — each DEM tile lands once. Blind retries (nothing specific
// to wait for) are capped per tile so a tile that cannot improve does not
// keep the reload loop alive.
const SLOPE_STALE_NOTIFY_DEBOUNCE_MS = 700;
const SLOPE_STALE_NOTIFY_MAX_WAIT_MS = 3000;
const SLOPE_STALE_MAX_RETRIES = 3;
const SLOPE_STALE_RETRY_MAX_KEYS = 4096;
const slopeStaleRetries = new Map(); // tile cache key → reloads already asked
let slopeStaleTimer = null;
let slopeStaleFirstAt = 0;
let slopeStaleCount = 0;

function flushSlopeStaleNotify() {
  slopeStaleTimer = null;
  slopeStaleFirstAt = 0;
  const count = slopeStaleCount;
  slopeStaleCount = 0;
  if (count === 0) return;
  try {
    self.clients.matchAll({ type: 'window' }).then((clients) => {
      clients.forEach((client) => client.postMessage({ type: 'SLOPE_TILES_STALE', count }));
    }).catch(() => {});
  } catch { /* ignore */ }
}

function noteSlopeTileStale(tileKey, { capped = true } = {}) {
  if (capped) {
    const n = slopeStaleRetries.get(tileKey) || 0;
    if (n >= SLOPE_STALE_MAX_RETRIES) return;
    slopeStaleRetries.delete(tileKey);
    slopeStaleRetries.set(tileKey, n + 1);
    if (slopeStaleRetries.size > SLOPE_STALE_RETRY_MAX_KEYS) {
      slopeStaleRetries.delete(slopeStaleRetries.keys().next().value);
    }
  }
  slopeStaleCount++;
  const now = Date.now();
  if (!slopeStaleFirstAt) slopeStaleFirstAt = now;
  if (slopeStaleTimer) clearTimeout(slopeStaleTimer);
  const wait = Math.min(
    SLOPE_STALE_NOTIFY_DEBOUNCE_MS,
    Math.max(0, slopeStaleFirstAt + SLOPE_STALE_NOTIFY_MAX_WAIT_MS - now),
  );
  slopeStaleTimer = setTimeout(flushSlopeStaleNotify, wait);
}

function noteSlopeTileFinal(tileKey) {
  slopeStaleRetries.delete(tileKey);
}

// ── Provisional slope tiles waiting on a DEM tile ─────────────────────
// A slope tile built while a cardinal neighbour DEM is not there yet (the
// terrain never asked for it: outside the viewport), or while its own DEM is
// a stand-in, is served but not cached. When that DEM tile becomes final —
// the terrain reaching it on a pan, the prefetch ring, a background upgrade
// — finalize() calls notifySlopeDemTileReady() and the page reloads the
// slope source: the tile comes back seam-complete and gets cached.
const SLOPE_DEM_WAITERS = new Map(); // `${profile}:${z}/${x}/${y}` → Set<slope tile key>
const SLOPE_DEM_WAITERS_MAX = 4096;

function slopeDemWaitKey(demProfile, z, x, y) {
  return `${demProfile || 'default'}:${z}/${x}/${y}`;
}

function waitSlopeTileOnDem(tileKey, demProfile, z, tiles) {
  for (const [tx, ty] of tiles) {
    const key = slopeDemWaitKey(demProfile, z, tx, ty);
    let waiting = SLOPE_DEM_WAITERS.get(key);
    if (!waiting) {
      if (SLOPE_DEM_WAITERS.size >= SLOPE_DEM_WAITERS_MAX) {
        SLOPE_DEM_WAITERS.delete(SLOPE_DEM_WAITERS.keys().next().value);
      }
      waiting = new Set();
      SLOPE_DEM_WAITERS.set(key, waiting);
    }
    waiting.add(tileKey);
  }
}

// Called for every DEM tile committed as final (finalize, background upgrade).
function notifySlopeDemTileReady(z, x, y, demProfile) {
  if (SLOPE_DEM_WAITERS.size === 0) return;
  const key = slopeDemWaitKey(demProfile, z, x, y);
  const waiting = SLOPE_DEM_WAITERS.get(key);
  if (!waiting) return;
  SLOPE_DEM_WAITERS.delete(key);
  for (const tileKey of waiting) noteSlopeTileStale(tileKey, { capped: false });
}

function isSlopeWorkCancelled(generation) {
  if (generation === null || generation === undefined) return false;
  return generation !== slopeCancelGeneration;
}

// Own DEM blob → slope PNG. Neighbours are resolved first (terrain tiles,
// in-flight builds awaited), then the job runs in the worker pool — or in
// process when the pool is unavailable.
//
// Returns { blob, missingNeighbours: [[x, y]], standInNeighbours: [[x, y]] }
// or null (cancelled / failed).
async function buildSlopeBlobFromDem(demBlob, z, x, y, demCache, resFactor, demProfile, generation, zoneRing, sourceDem = '', ownSourceClass = '', outputScale = 1) {
  const neighbours = await resolveSlopeNeighbourDems(z, x, y, demProfile, demCache, sourceDem, ownSourceClass);
  if (generation !== null && isSlopeWorkCancelled(generation)) return null;

  let slopeResult = null;
  if (typeof computeSlopeViaPool === 'function') {
    try {
      slopeResult = await computeSlopeViaPool(
        demBlob, neighbours.blobs, z, x, y, resFactor, generation, zoneRing, outputScale,
      );
    } catch {
      /* fall through to in-process */
    }
  }
  if (!slopeResult) {
    slopeResult = await scheduleSlopeBuild(
      () => buildSlopeTile(demBlob, neighbours.blobs, z, x, y, resFactor, demProfile, zoneRing, outputScale),
      generation,
    );
  }
  if (!slopeResult?.blob || (generation !== null && isSlopeWorkCancelled(generation))) return null;

  // A neighbour blob the worker failed to decode counts as missing too.
  const missingNeighbours = neighbours.missing.slice();
  const n = 2 ** z;
  const offsets = { north: [0, -1], east: [1, 0], south: [0, 1], west: [-1, 0] };
  for (const dir of slopeResult.missingDirections || []) {
    if (!neighbours.blobs[dir] || !offsets[dir]) continue;
    missingNeighbours.push([(x + offsets[dir][0] + n) % n, y + offsets[dir][1]]);
  }
  return {
    blob: slopeResult.blob,
    missingNeighbours,
    standInNeighbours: neighbours.standIns,
  };
}

// ── HD coverage & DEM source classes ──────────────────────────────────

/**
 * True when a high-resolution national DEM (IGN France incl. overseas,
 * swissSURFACE3D, Norway DTM, Spain MDT) may cover the tile — i.e. the HD
 * slope pipeline has something better than AWS 30 m to work with. Uses the
 * same predicates as the DEM dispatcher (compute-request.js).
 */
async function slopeTileHasHdCoverage(z, x, y) {
  if (tileOverlapsOverseasFrance(z, x, y)) return true;
  if (tileOverlapsSwitzerland(z, x, y) || tileOverlapsNorway(z, x, y) || tileOverlapsSpain(z, x, y)) return true;
  if (!tileOverlapsFrance(z, x, y)) return false;
  // Polygon unavailable: keep the HD path (previous behaviour).
  if (!(await ensureFrancePoly())) return true;
  return classifyDemTile(z, x, y) !== 'outside';
}

/** 'aws' for the global 30 m DEM, 'hires' for every national high-res DEM. */
function slopeDemSourceClass(source) {
  const s = (source || '').toLowerCase();
  return (s === 'aws-fast-30m' || s.startsWith('aws-terrarium')) ? 'aws' : 'hires';
}
