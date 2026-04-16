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
const DEM_TILE_SIZE = 512;
const IGN_SRC_TILE_SIZE = 256;
const DEM_NODATA_THRESHOLD = -10000;
const IGN_DEM_MINZOOM = 4;
const IGN_DEM_MAXZOOM = 17;

const IGN_ORTHO_LAYER = 'HR.ORTHOIMAGERY.ORTHOPHOTOS';
const IGN_ORTHO_TILEMATRIXSET = 'PM_6_19';
const ORTHO_TILE_SIZE = 256;

const CACHE_NAME = 'dem-tiles-v13';
const NEGATIVE_CACHE_NAME = 'dem-negative-v7';
const ORTHO_CACHE_NAME = 'ortho-tiles-v2';
const SLOPE_CACHE_NAME = 'slope-tiles-v3';
const STATIC_CACHE_NAME = 'dem-static-v1';

const IGN_CACHE_MAX = 3000;
const IGN_CONCURRENCY = 8;
const IGN_QUEUE_MAX = 400; // Max queued DEM tasks (increased for 60° pitch 3D globe views)

// Separate ortho concurrency — prevents ortho from starving DEM and vice versa
const ORTHO_CONCURRENCY = 8;
const ORTHO_QUEUE_MAX = 150;

// Null-cache TTLs (ms) — distinguish transient errors from permanent 404s
const IGN_NULL_TTL_TRANSIENT = 30_000;   // 30s — timeout, 5xx, network error
const IGN_NULL_TTL_PERMANENT = 3600_000; // 1h  — 404, invalid size

// Negative cache TTL for the CacheStorage-level negative cache (seconds)
const NEGATIVE_TTL_CONFIRMED = 3600;     // 1h — tile genuinely does not exist
const NEGATIVE_TTL_PIPELINE = 15;        // 15s — pipeline failed (network, queue, etc.)

// Sentinel object returned by queue pruning — never cache these failures
const PRUNED_SENTINEL = Object.freeze({ _pruned: true });

// Maximum zoom levels to fall back when IGN tile is missing
const IGN_FALLBACK_MAX_DEPTH = 3;
// Maximum zoom levels to overzoom DEM when native tile is missing
const DEM_OVERZOOM_MAX_DEPTH = 4;

// Batch timeout for buildIGNTile — proceed with partial coverage if exceeded
const BUILD_IGN_BATCH_TIMEOUT = 15_000; // 15s
