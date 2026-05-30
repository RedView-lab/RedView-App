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

// Mercator zoom gate.
//
// Even with the TIFF pyramid (overviews 1 m / 2 m / 4 m / 8 m / 16 m) the
// per-cell *discovery* cost remains: each 1 km LV95 cell needs one STAC
// resolution and one COG header open. A z=11 Mercator tile spans ~20×20 km
// = ~400 cells → 400 STAC queries (clustered into ~16 bbox calls of 5×5
// each, still 16 round-trips) + ~400 header fetches. That's what blew up
// the queue on Apr 24 even before the per-pixel fetch went out. So we
// keep z=12 as the floor (a z=12 tile is ~10×10 = ~100 cells, which is
// roughly the throughput SWISS_CONCURRENCY=16 can sustain in a few s).
//
// Inside that range, pickSwissCOGLevel() reads the matching overview
// instead of native 0.5 m, so a z=12 tile resolves from L4 (8 m) and only
// needs ~1 internal tile per cell.
const SWISS_ENGAGE_MPP = 30;
function shouldUseSwiss(mercZ, lat) {
  if (mercZ < SWISS_DEM_MINZOOM) return false;
  const cosLat = Math.cos((lat * Math.PI) / 180);
  const mppAtZ = (40075016.686 * Math.abs(cosLat)) / (256 * (1 << mercZ));
  return mppAtZ < SWISS_ENGAGE_MPP;
}

// HTTP timeouts — tuned for AWS-hosted COG range requests. Under burst
// load (16 mercator tiles × 4-9 sub-cells = 100+ concurrent range fetches)
// data.geo.admin.ch can take 10-20 s per response. STAC bumped to 15 s,
// COG range bumped to 20 s with one auto-retry on timeout (Apr 24 obs).
const SWISS_STAC_FETCH_TIMEOUT_MS = 15_000;
const SWISS_COG_HEADER_TIMEOUT_MS = 12_000;
const SWISS_COG_RANGE_TIMEOUT_MS  = 20_000;
const SWISS_COG_RANGE_RETRIES     = 2;   // total attempts incl. first try
const SWISS_COG_HEADER_RETRIES    = 3;   // headers are tiny → cheap to retry

// Negative-cache TTLs (ms) — STAC misses are usually permanent (tile not
// surveyed) so we cache them for an hour. Range/header transient failures
// must NOT poison cache for long: the user is actively panning and a 60 s
// blackout after one timeout looks like a hard outage. Keep transient
// nulls very short so the next pan retries.
const SWISS_NULL_TTL_PERMANENT = 3600_000; // 1 h
const SWISS_NULL_TTL_TRANSIENT = 5_000;    // 5 s

// LRU caps. Each COG header descriptor is small (~4 KB); each decoded
// internal tile is up to 256×256 Float32 = 256 KB but we keep them around
// because adjacent Mercator tiles re-sample the same internal tiles.
const SWISS_HEADER_CACHE_MAX = 512;   // ≈2 MB
const SWISS_TILE_CACHE_MAX = 256;     // ≈64 MB upper bound
const SWISS_STAC_CELL_CACHE_MAX = 16384; // STAC item resolutions per LV95-km cell (a 14×14 window writes ~196 at once)

// COG concurrency limiter — separate semaphore from IGN so France traffic
// never starves Swiss traffic and vice versa. CDN benchmark (Apr 24) shows
// data.geo.admin.ch handles 32 streams at p95=2.5s with 0 errors. Bumped
// 24 → 32 (May 30) once header fetches dropped to 32 KB and range requests
// are coalesced, so per-tile fetch VOLUME is far lower and the extra streams
// drain the cold-pan burst faster without queue saturation.
const SWISS_CONCURRENCY = 32;
const SWISS_QUEUE_MAX = 400;

// STAC clustering window — every cell snaps to a fixed (Ekm/STAC_GRID,
// Nkm/STAC_GRID) block so sibling cells deterministically join the SAME
// inflight STAC query (super-window dedup, see swiss-fetcher.js).
//   The swisstopo STAC API caps `limit` at 100 features/page and paginates
//   via an opaque `cursor` in the response's rel="next" link. We now FOLLOW
//   that cursor (up to SWISS_STAC_MAX_PAGES), so a window may hold far more
//   than 100 cells without silently truncating. A 14×14 = 196-cell block ×
//   ~1.2 published years/cell ≈ 235 features = 3 pages, but ONE logical
//   window now covers ~4× the area of the old 7×7 block → a viewport pan
//   resolves discovery in a handful of windows instead of ~15, and every
//   subsequent tile in the pan reads cells straight from cache.
const SWISS_STAC_GRID = 14;

// STAC page size (server hard-caps at 100) and the max number of cursor
// pages we will follow per window before giving up. 4 pages × 100 = 400
// features comfortably covers a fully-populated 14×14 block even where
// every cell has 2 published acquisition years.
const SWISS_STAC_PAGE_LIMIT = 100;
const SWISS_STAC_MAX_PAGES = 6;

const SWISS_PRUNED_SENTINEL = Object.freeze({ _swissPruned: true });

// Fast-path skip: at very low zoom the tile spans dozens of km² and we'd
// have to consult STAC for many cells just to discover the Mercator pixel
// is already coarser than the COG. shouldUseSwiss() handles this but we
// also clamp here defensively.
const SWISS_DEM_MINZOOM = 12;
