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
const NORWAY_FETCH_TIMEOUT_MS = 15_000;
const NORWAY_CONCURRENCY = 12;
const NORWAY_QUEUE_MAX = 240;
const NORWAY_WCS_FORMAT = 'GeoTIFF';

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