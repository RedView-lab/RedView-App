// ---------------------------------------------------------------------------
// Switzerland — swissSURFACE3D Raster integration constants
// ---------------------------------------------------------------------------
// Source: swissSURFACE3D Raster (Federal Office of Topography — swisstopo)
//   — Digital Surface Model (top-of-canopy: trees, buildings, bridges)
//   — 0.5 m grid, ±10 cm altimetric accuracy (LiDAR-derived)
//   — License: OGD (Open Government Data) — commercial use allowed, free
//   — Published as Cloud Optimized GeoTIFF (COG) on AWS, indexed by STAC
//
// API anchors:
//   STAC collection :  https://data.geo.admin.ch/api/stac/v1/collections/
//                      ch.swisstopo.swisssurface3d-raster
//   Items (bbox)    :  …/items?bbox={W},{S},{E},{N}&limit=…
//   COG asset URL   :  https://data.geo.admin.ch/ch.swisstopo.swisssurface3d-
//                      raster/{itemId}/{itemId}_0.5_2056_{group}.tif
//
// Item naming: swisssurface3d-raster_{year}_{Ekm}-{Nkm}
//   Ekm, Nkm = floor(LV95_easting/1000), floor(LV95_northing/1000) — the
//   south-west corner of the 1 km² tile. Year is published per acquisition
//   wave (currently 2018-2024 across the country); we resolve year per cell
//   via STAC because it is not deterministic.
// ---------------------------------------------------------------------------

const SWISS_STAC_BASE =
  'https://data.geo.admin.ch/api/stac/v1/collections/ch.swisstopo.swisssurface3d-raster/items';

// Conservative WGS84 bounding box of Switzerland (incl. Liechtenstein).
// Pulled from STAC collection extent: [5.95, 45.81, 10.50, 47.82].
// Padded slightly so border tiles still trigger Switzerland classification.
const SWITZERLAND_BOUNDS = [5.90, 45.78, 10.55, 47.85];

// LV95 (EPSG:2056) extent of officially published swissSURFACE3D Raster
// data — used as a fast pre-flight reject for tiles that fall in the
// Mercator bbox of Switzerland but actually outside the surveyed area
// (e.g. the bbox cuts into French Haute-Savoie or Italian Aosta Valley).
//   E ∈ [2 485 000, 2 834 000]  (≈ 349 km wide)
//   N ∈ [1 075 000, 1 296 000]  (≈ 221 km tall)
const SWISS_LV95_BOUNDS = {
  Emin: 2_485_000,
  Emax: 2_834_000,
  Nmin: 1_075_000,
  Nmax: 1_296_000,
};

// Native source resolution
const SWISS_NATIVE_GSD = 0.5;       // metres per pixel
const SWISS_KM_TILE_PX = 2000;      // 1 km / 0.5 m = 2000 pixels
const SWISS_KM_TILE_M = 1000;       // 1 km tile size in metres

// Mercator zoom gate — same threshold as IGN: only run COG pipeline when
// the rendered pixel is meaningfully smaller than what Mapbox Terrain-RGB
// (~30 m) already delivers. Reuses shouldUseIGN()-equivalent computation.
// We keep an independent constant in case Switzerland's data density
// pattern needs different tuning later.
const SWISS_ENGAGE_MPP = 25;
function shouldUseSwiss(mercZ, lat) {
  if (mercZ < 4) return false;
  const cosLat = Math.cos((lat * Math.PI) / 180);
  const mppAtZ = (40075016.686 * Math.abs(cosLat)) / (256 * (1 << mercZ));
  return mppAtZ < SWISS_ENGAGE_MPP;
}

// HTTP timeouts — tuned for AWS-hosted COG range requests (typically <300 ms
// per request once the COG header is cached). STAC bumped to 15 s because
// data.geo.admin.ch occasionally takes 8-12 s under load (observed Apr 24).
const SWISS_STAC_FETCH_TIMEOUT_MS = 15_000;
const SWISS_COG_HEADER_TIMEOUT_MS = 6_000;
const SWISS_COG_RANGE_TIMEOUT_MS  = 8_000;

// Negative-cache TTLs (ms) — STAC misses are usually permanent (tile not
// surveyed) so we cache them for an hour. Range-fetch failures are usually
// transient AWS hiccups, retry within a minute.
const SWISS_NULL_TTL_PERMANENT = 3600_000; // 1 h
const SWISS_NULL_TTL_TRANSIENT = 60_000;   // 60 s

// LRU caps. Each COG header descriptor is small (~4 KB); each decoded
// internal tile is up to 256×256 Float32 = 256 KB but we keep them around
// because adjacent Mercator tiles re-sample the same internal tiles.
const SWISS_HEADER_CACHE_MAX = 512;   // ≈2 MB
const SWISS_TILE_CACHE_MAX = 256;     // ≈64 MB upper bound
const SWISS_STAC_CELL_CACHE_MAX = 4096; // STAC item resolutions per LV95-km cell

// COG concurrency limiter — separate semaphore from IGN so France traffic
// never starves Swiss traffic and vice versa. Range requests against the
// AWS endpoint comfortably pipeline 30+ streams over HTTP/2.
const SWISS_CONCURRENCY = 24;
const SWISS_QUEUE_MAX = 400;

const SWISS_PRUNED_SENTINEL = Object.freeze({ _swissPruned: true });

// Fast-path skip: at very low zoom the tile spans dozens of km² and we'd
// have to consult STAC for many cells just to discover the Mercator pixel
// is already coarser than the COG. shouldUseSwiss() handles this but we
// also clamp here defensively.
const SWISS_DEM_MINZOOM = 8;
