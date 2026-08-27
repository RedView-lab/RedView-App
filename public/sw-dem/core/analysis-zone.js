// ---------------------------------------------------------------------------
// Analysis zone registry — the single user-drawn polygon that focuses the
// slope / altitude tile pipelines on a bounded area.
//
// The page posts SET_ANALYSIS_ZONE { hash, ring } whenever the zone is
// (re)drawn (src/features/analysisZone/lib/swZoneBridge.ts) and the tile
// handlers receive the SAME hash as `?zone=<hash>` in the tile URL. Two uses:
//
//   1. EARLY REJECTION — `tileIntersectsAnalysisZone()` is a pure bbox test
//      (tile bbox vs zone bbox) that runs BEFORE any CacheStorage DEM read or
//      IGN fetch. A tile fully outside the polygon returns a transparent
//      response in <0.1 ms, so the cost of the overlay scales with the zone,
//      not the viewport.
//
//   2. PER-PIXEL MASK — partially covered tiles are built normally, then
//      alpha-masked to the polygon by rasterizeRingMask()/applyRingMaskToRgba()
//      in workers/slope-math.js (shared by the SW scope AND the worker pool).
//
// The registry is intentionally tiny (LRU 8): a hash in the tile URL that the
// SW does not know (SW restarted, race with source swap) degrades to an
// UNMASKED build — a correct tile, never an error.
//
// Lives in core/ (pure state + math on mercatorTileBounds from geo.js), no
// SW-event access, importScripts'd from sw-dem.js before the handlers.
// ---------------------------------------------------------------------------

const ANALYSIS_ZONE_REGISTRY_MAX = 8;

// hash → { ring: [[lng, lat], ...], bbox: [w, s, e, n] }
const analysisZoneRegistry = new Map();

function analysisZoneBBoxFromRing(ring) {
  let w = Infinity, s = Infinity, e = -Infinity, n = -Infinity;
  for (const [lng, lat] of ring) {
    if (lng < w) w = lng;
    if (lng > e) e = lng;
    if (lat < s) s = lat;
    if (lat > n) n = lat;
  }
  return [w, s, e, n];
}

/**
 * ring: flat [lng, lat, lng, lat, …] payload from the page (matches
 * analysisZoneRingPayload). ≥3 distinct points required.
 */
function registerAnalysisZone(hash, flatRing) {
  if (!hash || typeof hash !== 'string' || !Array.isArray(flatRing)) return null;
  const ring = [];
  for (let i = 0; i + 1 < flatRing.length; i += 2) {
    const lng = Number(flatRing[i]);
    const lat = Number(flatRing[i + 1]);
    if (!Number.isFinite(lng) || !Number.isFinite(lat)) return null;
    ring.push([lng, lat]);
  }
  if (ring.length < 3) return null;

  const entry = { ring, bbox: analysisZoneBBoxFromRing(ring) };
  if (analysisZoneRegistry.has(hash)) analysisZoneRegistry.delete(hash);
  analysisZoneRegistry.set(hash, entry);
  while (analysisZoneRegistry.size > ANALYSIS_ZONE_REGISTRY_MAX) {
    const oldest = analysisZoneRegistry.keys().next().value;
    if (oldest === undefined) break;
    analysisZoneRegistry.delete(oldest);
  }
  return entry;
}

function clearAnalysisZones() {
  analysisZoneRegistry.clear();
}

function getAnalysisZone(hash) {
  if (!hash) return null;
  const entry = analysisZoneRegistry.get(hash);
  // LRU refresh so an active zone is never the eviction victim.
  if (entry) {
    analysisZoneRegistry.delete(hash);
    analysisZoneRegistry.set(hash, entry);
  }
  return entry ?? null;
}

/**
 * Pure bbox overlap test between the tile at (z, x, y) and the registered
 * zone. Returns true when the tile MIGHT contain polygon pixels (a bbox hit
 * is necessary, not sufficient — the exact mask is applied per-pixel later).
 * A miss is definitive: the tile is guaranteed outside the polygon.
 */
function tileIntersectsAnalysisZone(entry, z, x, y) {
  if (!entry) return false;
  const b = mercatorTileBounds(z, x, y);
  const [w, s, e, n] = entry.bbox;
  return !(b.east < w || b.west > e || b.south > n || b.north < s);
}

/**
 * Resolves a `?zone=` hash into { entry, ring } for a tile build.
 * Unknown / missing hash → { entry: null, ring: null } → unmasked build.
 */
function resolveAnalysisZoneForTile(zoneHash) {
  if (!zoneHash) return { entry: null, ring: null };
  const entry = getAnalysisZone(zoneHash);
  if (!entry) return { entry: null, ring: null };
  return { entry, ring: entry.ring };
}
