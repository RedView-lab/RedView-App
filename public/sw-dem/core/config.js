// ---------------------------------------------------------------------------
// Configuration constants — shared by all SW modules
// ---------------------------------------------------------------------------

const IGN_WMTS_BASE = 'https://data.geopf.fr/wmts';
const IGN_WMS_BASE = 'https://data.geopf.fr/wms-r/wms';
// MNS LiDAR HD (Modèle Numérique de Surface — top-of-canopy, trees, rocks,
// buildings included). This is what gives the user the "20 cm detail with
// rocks and trees" relief they want to see. LiDAR HD native grid is ~1 m,
// published up to z17 on TileMatrixSet WGS84G_4_17.
//
// The MNS↔MNT canopy offset that used to produce cliffs at tile seams where
// IGN tiles met Mapbox Terrain-RGB (bare-earth) is handled by the median-bias
// correction in compositeIGNMapbox (composite.js): the 1-px border ring
// offset is sampled against Mapbox, the median is applied as a constant
// subtraction, so the MNS elevation surface snaps onto Mapbox at the seam
// without any visible step.
const IGN_DEM_LAYER = 'ELEVATION.ELEVATIONGRIDCOVERAGE.HIGHRES.MNS';
const IGN_DEM_TILEMATRIXSET = 'WGS84G_4_17';
const IGN_DEM_FORMAT = 'image/x-bil;bits=32';

// RGE ALTI terrain model (MNT / bare earth). IGN officially publishes this
// dataset at 1 m and 5 m resolution; the WMTS endpoint below exposes the same
// terrain product on a coarser tiled grid, while the WMS endpoint can serve a
// direct 32-bit raster for an arbitrary bbox.
const IGN_DEM_FALLBACK_LAYER = 'ELEVATION.ELEVATIONGRIDCOVERAGE.HIGHRES';
const IGN_DEM_FALLBACK_TILEMATRIXSET = 'WGS84G_6_14';
const IGN_DEM_FALLBACK_MINZOOM = 6;
const IGN_DEM_FALLBACK_MAXZOOM = 14;

const FRANCE_BOUNDS = [-5.5, 41.0, 10.0, 51.5];

// Overseas French territories (DOM-TOM) where IGN publishes the same
// HIGHRES / HIGHRES.MNS LiDAR pyramid on the global WGS84G TileMatrixSet.
// Each entry is [west, south, east, north] in lng/lat. Tiles inside any of
// these bboxes are treated like "predominantly French inside" tiles by the
// dispatcher (skip CH/NO/ES branches, skip the france-border.json polygon
// test which is metro-only, go straight into the IGN HD path).
//
// Coverage notes (verified on geoplateforme):
//   - REU (La Réunion)      : LiDAR HD published 2023-2024, full island
//   - GLP (Guadeloupe)      : LiDAR HD published, full archipelago
//   - MTQ (Martinique)      : LiDAR HD published, full island
//   - MYT (Mayotte)         : LiDAR HD published, full island
//   - GUF (Guyane française): RGE ALTI 5 m + partial LiDAR HD
const OVERSEAS_FRANCE_BOUNDS = [
  [55.20, -21.40, 55.85, -20.85], // Réunion
  [-61.85, 15.80, -61.00, 16.55], // Guadeloupe
  [-61.25, 14.35, -60.80, 14.90], // Martinique
  [45.00, -13.05, 45.30, -12.60], // Mayotte
  [-54.65, 2.10, -51.60, 5.80],   // Guyane française
];

const DEM_TILE_SIZE = 256;
const IGN_SRC_TILE_SIZE = 256;
const DEM_NODATA_THRESHOLD = -10000;

// Physical elevation bounds used to reject sentinel values (IGN occasionally
// serves -9999.0 as nodata instead of the documented -99999). France's lowest
// real point is ~-5 m (Rhône delta) so any value below -500 m is sentinel
// garbage; any value above 9 000 m is impossible (Mont Blanc is 4 810 m) and
// comes from LiDAR hot pixels / scanner artefacts. Values outside this range
// are treated exactly like NaN.
const MIN_VALID_ELEVATION_M = -500;
const MAX_VALID_ELEVATION_M = 9_000;

// Despike threshold — if a pixel differs from its 3×3 neighborhood median by
// more than this many metres, it is clamped to the median. Catches isolated
// LiDAR hot-pixel outliers that survived IGN's own pre-processing without
// erasing real ridgelines (real cliffs span multiple pixels).
const DESPIKE_THRESHOLD_M = 80;

const IGN_DEM_MINZOOM = 4;
const IGN_DEM_MAXZOOM = 17;

// France HD engage gates. We open the RGE ALTI terrain fallback one zoom earlier
// than the full MNS LiDAR path so mountainous terrain sharpens sooner without
// paying the full MNS fan-out as aggressively across overview zooms.
//
// HIGHRES threshold = 56 m/px: enables the France HD fallback around z11.
// MNS threshold = 36 m/px: keeps true LiDAR easy to reach at z12 across
// France while avoiding a blanket z11 MNS burst.
const IGN_HIGHRES_ENGAGE_MPP = 56;
const IGN_MNS_ENGAGE_MPP = 36;

function mercatorMetersPerPixel(mercZ, lat) {
  const cosLat = Math.cos((lat * Math.PI) / 180);
  // Earth circumference at equator in metres
  return (40075016.686 * Math.abs(cosLat)) / (256 * (1 << mercZ));
}

function shouldUseIGNHighres(mercZ, lat) {
  if (mercZ < IGN_DEM_FALLBACK_MINZOOM) return false;
  return mercatorMetersPerPixel(mercZ, lat) < IGN_HIGHRES_ENGAGE_MPP;
}

function shouldUseIGN(mercZ, lat) {
  if (mercZ < IGN_DEM_MINZOOM) return false;
  return mercatorMetersPerPixel(mercZ, lat) < IGN_MNS_ENGAGE_MPP;
}

const IGN_ORTHO_LAYER = 'HR.ORTHOIMAGERY.ORTHOPHOTOS';
const IGN_ORTHO_TILEMATRIXSET = 'PM_6_19';
const ORTHO_TILE_SIZE = 256;

// Global map-cache epoch. Bump this single token when a release must force a
// full reset of DEM / ortho / slope / altitude / project-map caches for every
// client. The app also propagates the same epoch into DEM request URLs and
// one-shot browser-side purges.
//
// 2026-05-08-satellite-dem-refresh-3: keeps neighbour-computed slope borders
// in 1 m terrain mode and forces Standard-Satellite DEM refresh/recovery to
// purge stale flat tiles from Mapbox's raster-dem pyramid.
//
// 2026-05-08-slope-1m-fast-quality-1: ships the 1 m slope pipeline update
// (terrain-profile prefetch, decoded DEM LRU, deferred neighbour seam-heal,
// derived-cache reload fix). Bumping here guarantees sw-dem submodules are
// fetched with a new query string and stale slope/DEM entries are purged once.
const MAP_CACHE_EPOCH = '2026-05-10-slope-aws-allow-2';

// AbortController.abort() reason used when CANCEL_STALE_DEM aborts an
// in-flight IGN/Ortho fetch. The catch handlers check
// `controller.signal.reason === USER_CANCEL_REASON` and SKIP negative-cache
// writes for those tiles — a re-request issued moments later (the new
// viewport often overlaps the old one) must run the real pipeline, not get
// short-circuited by a transient null entry caused by our own abort.
const USER_CANCEL_REASON = 'rv-user-gesture-cancel';

const CACHE_NAME = `dem-tiles-${MAP_CACHE_EPOCH}`;
const NEGATIVE_CACHE_NAME = `dem-negative-${MAP_CACHE_EPOCH}`;
const ORTHO_CACHE_NAME = `ortho-tiles-${MAP_CACHE_EPOCH}`;
const SLOPE_CACHE_NAME = `slope-tiles-${MAP_CACHE_EPOCH}`;
const ALTITUDE_CACHE_NAME = `altitude-tiles-${MAP_CACHE_EPOCH}`;
const STATIC_CACHE_NAME = `dem-static-${MAP_CACHE_EPOCH}`;

// Debug flag — gate verbose per-tile logging. Warnings and errors always log.
const DEBUG = false;

const IGN_CACHE_MAX = 500;
// HTTP/2 on data.geopf.fr comfortably multiplexes 40+ streams per connection.
// At zoom-in the viewport needs ~80 sub-tiles in a single burst (20 Mapbox
// tiles × 4 WGS84G sub-tiles). With concurrency=20 the 60-deep queue stretched
// the effective fetch time past the 1.5 s soft deadline → tiles fell back to
// overzoomed Mapbox (flat 30 m) even though IGN was serving 200s.
const IGN_CONCURRENCY = 40;
// Sized for 60° pitch at z14 across a widescreen viewport — burst can exceed
// 300 tile requests in < 500 ms. Below this we start pruning, which is fine
// but degrades the pan experience.
const IGN_QUEUE_MAX = 600;

// Separate ortho concurrency — prevents ortho from starving DEM and vice versa.
// Bumped from 10 → 16: geopf HTTP/2 comfortably multiplexes 20+ streams, and
// at 10 the queue head-of-line blocked the viewport during fast dezoom.
const ORTHO_CONCURRENCY = 16;
const ORTHO_QUEUE_MAX = 400;

// IGN WMTS fetch timeout (ms). Geoplateforme can spike to 10+ s during peak
// hours; 15 s avoids false-positive permanent-error caching.
const IGN_FETCH_TIMEOUT_MS = 15_000;

// Orthophoto fetch timeout — lower than DEM because a stuck ortho tile keeps
// the blurred parent on screen and blocks the ortho queue. 8 s is enough for
// geopf hot JPEGs while letting us fail fast onto the parent-overzoom path.
const ORTHO_FETCH_TIMEOUT_MS = 8_000;

// If an in-flight ortho tile fetch hasn't completed within this window,
// promote a cropped parent tile immediately to the renderer and let the
// real fetch continue in the background. Eliminates the "white hole during
// dezoom" artifact without cancelling useful work.
const ORTHO_INFLIGHT_PROMOTE_MS = 800;

// Null-cache TTLs (ms) — distinguish transient errors from permanent 404s
const IGN_NULL_TTL_TRANSIENT = 10_000;   // 10s — timeout, 5xx, network error
const IGN_NULL_TTL_PERMANENT = 3600_000; // 1h  — 404, invalid size

// Negative cache TTL for the CacheStorage-level negative cache (seconds)
const NEGATIVE_TTL_CONFIRMED = 3600;     // 1h — tile genuinely does not exist
const NEGATIVE_TTL_PIPELINE = 2;         // 2s  — transient France pipeline failure; retry fast

// Sentinel object returned by queue pruning — never cache these failures
const PRUNED_SENTINEL = Object.freeze({ _pruned: true });

// Maximum zoom levels to fall back when IGN tile is missing
const IGN_FALLBACK_MAX_DEPTH = 3;
// Maximum zoom levels to overzoom DEM when native tile is missing
const DEM_OVERZOOM_MAX_DEPTH = 4;

// Zoom-adaptive soft deadline. When close to the terrain the user expects
// LiDAR-HD detail — NOT a Mapbox 30 m fallback. The deadline is the maximum
// the pipeline will wait for all IGN sub-tiles before compositing with
// whatever it has; any stragglers are deliberately allowed to dominate the
// wall-clock budget at high zoom because:
//   1. Mapbox Terrain-RGB at z≥14 is server-overzoomed (flat), so falling
//      back to it actively harms visual quality.
//   2. IGN sub-tile fetches are cached + deduplicated in-memory; the user
//      pays the cost once per tile, then every subsequent render is instant.
//   3. At z≥16 the Mapbox prefill path hides real rock detail under a
//      bilinear 30-m blur — worse than a brief loading delay.
//
// Deadlines:
//   * z≤12: 1.2 s — overview, Mapbox is fine anyway (IGN isn't engaged).
//   * z=13:  2.5 s — IGN just engaged, balance between wait and coverage.
//   * z=14:  5.0 s — first LiDAR zoom, need the detail.
//   * z=15:  9.0 s — close-up; LiDAR is critical, Mapbox is visually flat.
//   * z≥16: 14.0 s — summit / rock detail; waiting longer is always better
//     than serving 30 m Mapbox. On Mac / slower links the original 8 s was
//     short enough that Mont Blanc-style peaks consistently tripped the
//     deadline → composite with partial coverage → visual quality drop.
function ignSoftDeadlineMs(mercZ) {
  if (mercZ <= 12) return 1_200;
  if (mercZ === 13) return 2_500;
  if (mercZ === 14) return 5_000;
  if (mercZ === 15) return 9_000;
  return 14_000;
}
const IGN_SUBTILE_SOFT_DEADLINE_MS = 14_000; // fallback/legacy const
