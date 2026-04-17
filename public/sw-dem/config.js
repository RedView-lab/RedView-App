// ---------------------------------------------------------------------------
// Configuration constants — shared by all SW modules
// ---------------------------------------------------------------------------

const IGN_WMTS_BASE = 'https://data.geopf.fr/wmts';
// MNT LiDAR HD (Modèle Numérique de Terrain — bare-earth, trees/buildings removed).
// We use MNT, NOT MNS, because Mapbox Terrain-RGB is bare-earth: mixing the two
// at tile seams produces 15–40 m vertical cliffs in forested France (canopy
// offset).
//
// IMPORTANT: the HIGHRES (MNT) layer is published on TileMatrixSet WGS84G_6_14
// (zoom 6–14), NOT on WGS84G_4_17 like MNS. At z14 the ground sample distance
// is ~1 m which still exceeds LiDAR HD's native 1 m grid, so no resolution is
// lost; higher-zoom mercator tiles (z15–16) are handled by GPU overzoom on
// the resulting Terrain-RGB PNG — same behaviour as Mapbox's own DEM past z14.
const IGN_DEM_LAYER = 'ELEVATION.ELEVATIONGRIDCOVERAGE.HIGHRES';
const IGN_DEM_TILEMATRIXSET = 'WGS84G_6_14';
const IGN_DEM_FORMAT = 'image/x-bil;bits=32';

const FRANCE_BOUNDS = [-5.5, 41.0, 10.0, 51.5];
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

const IGN_DEM_MINZOOM = 6;
const IGN_DEM_MAXZOOM = 14;

// Zoom gate for running the IGN composite pipeline. Pixel-density based: we
// only invest the IGN fetch + composite cost when the rendered pixel is
// meaningfully smaller than what Mapbox Terrain-RGB already delivers.
//
// At latitude φ, mercator z=Z pixel size = cos(φ) · 40075000 / (256 · 2^Z) m.
// The IGN_ENGAGE_MPP threshold is what matters for perceptible LOD gain:
//   * Mapbox Terrain-RGB native sample ~30 m/px — usable up to ~z12.
//   * At a rendered pixel density of ~10 m/px the user starts perceiving
//     sub-Mapbox detail, and LiDAR HD (0.4 m native) delivers a huge win.
//   * Above 10 m/px the composite cost (~3 s/tile, plus compositeSem queue
//     saturation) vastly outweighs any visual gain — we'd stall the pipeline
//     for zero perceptible improvement, producing the "3 min of blur" bug.
//
// At France median φ≈46° this crosses 10 m/px between z13 and z14, i.e. the
// IGN composite engages exclusively at z14+ where it actually matters.
// Continuous on lat so Corsica (~42°) engages at z14 and Dunkirk (~51°)
// at z14 as well — consistent UX across the country.
const IGN_ENGAGE_MPP = 10;
function shouldUseIGN(mercZ, lat) {
  if (mercZ < IGN_DEM_MINZOOM) return false;
  const cosLat = Math.cos((lat * Math.PI) / 180);
  // Earth circumference at equator in metres
  const mppAtZ = (40075016.686 * Math.abs(cosLat)) / (256 * (1 << mercZ));
  return mppAtZ < IGN_ENGAGE_MPP;
}

const IGN_ORTHO_LAYER = 'HR.ORTHOIMAGERY.ORTHOPHOTOS';
const IGN_ORTHO_TILEMATRIXSET = 'PM_6_19';
const ORTHO_TILE_SIZE = 256;

// Bumped cache versions — invalidates tiles cached during the "système D"
// era that served fake flat 200s. Old cache names are listed in
// sw-dem.js OLD_CACHES and purged on activate.
// v23 / v17 / v8 — evicts:
//   (a) MNS-era tiles (canopy offset producing 15–40 m cliffs)
//   (b) v22 tiles cached during the brief window where HIGHRES was queried
//       against the wrong TileMatrixSet WGS84G_4_17, causing every sub-tile
//       to 404 and the whole IGN path to fall through to overzoomed Mapbox.
const CACHE_NAME = 'dem-tiles-v23';
const NEGATIVE_CACHE_NAME = 'dem-negative-v17';
const ORTHO_CACHE_NAME = 'ortho-tiles-v9';
const SLOPE_CACHE_NAME = 'slope-tiles-v4';
const STATIC_CACHE_NAME = 'dem-static-v1';

// Debug flag — gate verbose per-tile logging. Warnings and errors always log.
const DEBUG = false;

const IGN_CACHE_MAX = 500;
// HTTP/2 on data.geopf.fr comfortably multiplexes 20+ streams per connection.
// Higher concurrency dramatically reduces queue wait — the main source of
// sub-tile tail latency.
const IGN_CONCURRENCY = 20;
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

// Soft deadline for the per-Mapbox-tile batch of IGN sub-tile fetches.
// When this fires we serve the best-quality result we have right now
// (composited with Mapbox for any still-pending sub-tiles) and let the
// stragglers continue in the background. The background completion triggers
// a cache-replace with the full-quality IGN blob — see scheduleBackgroundUpgrade
// in sw-dem.js. The user never waits longer than this for first paint, and
// every tile eventually converges to best quality.
//
// Shorter than before (was 3 s) — with IGN_ENGAGE_MPP=10 we only composite
// at z14+, where each tile needs at most 2×2 = 4 IGN sub-tiles. Those are
// small (512x512 BIL32 ≈ 1 MB) and return in 300–800 ms on HTTP/2. Beyond
// 1.2 s the remaining sub-tiles are tail-latency outliers — we'd rather
// ship the partial composite + background-upgrade them than block.
function ignSoftDeadlineMs(mercZ) {
  return mercZ <= 13 ? 1_200 : 1_500;
}
const IGN_SUBTILE_SOFT_DEADLINE_MS = 1_500; // fallback/legacy const
