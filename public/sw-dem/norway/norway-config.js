// ---------------------------------------------------------------------------
// Norway — national 1 m DTM via Kartverket / Geonorge WCS
// ---------------------------------------------------------------------------
// Official sources confirmed during integration:
//   * NHM DTM WCS endpoints in EUREF89 / UTM 32, 33 and 35
//   * National coverage, open data, 1 m resolution or coarser by request scale
//   * ImageServer WCS 1.0.0/1.1.x/2.0.1 — we use 1.0.0 because width/height
//     driven GetCoverage is the simplest stable contract for Mercator tiles.
// ---------------------------------------------------------------------------

const NORWAY_BOUNDS = [2.0, 57.0, 33.4, 72.2];
const NORWAY_DEM_MINZOOM = 10;
const NORWAY_ENGAGE_MPP = 72;
const NORWAY_WCS_VERSION = '1.0.0';
// Cold backend (`hoydedata.no`) can take 15-25 s to render a fresh tile;
// 30 s prevents abort-and-retry storms when panning to a new region.
const NORWAY_FETCH_TIMEOUT_MS = 30_000;
const NORWAY_CONCURRENCY = 12;
const NORWAY_QUEUE_MAX = 240;
const NORWAY_WCS_FORMAT = 'GeoTIFF';
// Server-side raster size — request a 2× supersample of the output tile
// pitch so the local UTM→Mercator reprojection can do area-weighted box
// averaging (≈4 source pixels per destination pixel) instead of point-
// bilinear. Point sampling on a UTM raster requested at the same pitch
// as the Mercator output produced regular grid/moiré artefacts on the
// slope overlay (visible as oblique stripes on smooth terrain) — same
// failure mode as the May 03 France WMS 0.40 m → 1 m issue. 4× bandwidth
// (~520 KB → 4× = ~2 MB per Norway tile of float32 GeoTIFF, but Norway is
// already opt-in for high-zoom and on-fibre is imperceptible.
const NORWAY_WCS_OUTPUT_PX = 512;

const NORWAY_WCS_ZONES = {
  32: {
    zone: 32,
    epsg: '25832',
    base: 'https://hoydedata.no/arcgis/services/NHM_DTM_25832/ImageServer/WCSServer',
    coverage: 'nhm_dtm_topo_25832',
  },
  33: {
    zone: 33,
    epsg: '25833',
    base: 'https://hoydedata.no/arcgis/services/NHM_DTM_25833/ImageServer/WCSServer',
    coverage: 'nhm_dtm_topo_25833',
  },
  35: {
    zone: 35,
    epsg: '25835',
    base: 'https://hoydedata.no/arcgis/services/NHM_DTM_25835/ImageServer/WCSServer',
    coverage: 'nhm_dtm_topo_25835',
  },
};

function shouldUseNorway(mercZ, lat) {
  if (mercZ < NORWAY_DEM_MINZOOM) return false;
  return mercatorMetersPerPixel(mercZ, lat) < NORWAY_ENGAGE_MPP;
}