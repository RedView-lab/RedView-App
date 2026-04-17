// ---------------------------------------------------------------------------
// Configuration constants — shared by all SW modules
// ---------------------------------------------------------------------------

const IGN_WMTS_BASE = 'https://data.geopf.fr/wmts';
// MNS LiDAR HD (Modèle Numérique de Surface) = surface with trees/buildings
// Much more precise than old MNT bare-ground model
const IGN_DEM_LAYER = 'ELEVATION.ELEVATIONGRIDCOVERAGE.HIGHRES.MNS';
const IGN_DEM_TILEMATRIXSET = 'WGS84G_4_17';
const IGN_DEM_FORMAT = 'image/x-bil;bits=32';

const FRANCE_BOUNDS = [-5.5, 41.0, 10.0, 51.5];
const DEM_TILE_SIZE = 256;
const IGN_SRC_TILE_SIZE = 256;
const DEM_NODATA_THRESHOLD = -10000;
const IGN_DEM_MINZOOM = 4;
const IGN_DEM_MAXZOOM = 17;

// Minimum Mapbox zoom at which we run the IGN composite pipeline.
// Below this, Mapbox's 30 m global DEM is visually indistinguishable from
// IGN LiDAR HD at the rendered pixel density, while the IGN build would
// enqueue 6-9 WGS84G sub-tiles per Mapbox tile and jam the queue.
const IGN_BUILD_MINZOOM = 10;

const IGN_ORTHO_LAYER = 'HR.ORTHOIMAGERY.ORTHOPHOTOS';
const IGN_ORTHO_TILEMATRIXSET = 'PM_6_19';
const ORTHO_TILE_SIZE = 256;

// Bumped cache versions — invalidates tiles cached during the "système D"
// era that served fake flat 200s. Old cache names are listed in
// sw-dem.js OLD_CACHES and purged on activate.
const CACHE_NAME = 'dem-tiles-v18';
const NEGATIVE_CACHE_NAME = 'dem-negative-v12';
const ORTHO_CACHE_NAME = 'ortho-tiles-v3';
const SLOPE_CACHE_NAME = 'slope-tiles-v3';
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

// Separate ortho concurrency — prevents ortho from starving DEM and vice versa
const ORTHO_CONCURRENCY = 10;
const ORTHO_QUEUE_MAX = 400;

// IGN WMTS fetch timeout (ms). Geoplateforme can spike to 10+ s during peak
// hours; 15 s avoids false-positive permanent-error caching.
const IGN_FETCH_TIMEOUT_MS = 15_000;

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
const IGN_SUBTILE_SOFT_DEADLINE_MS = 3_000;
