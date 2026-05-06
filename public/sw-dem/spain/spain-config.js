// ---------------------------------------------------------------------------
// Spain — national MDT via IGN / IDEE INSPIRE WCS
// ---------------------------------------------------------------------------
// Official endpoints validated during integration:
//   * WCS: https://servicios.idee.es/wcs-inspire/mdt?service=WCS&request=GetCapabilities
//   * WMS ortho reference: https://www.ign.es/wms-inspire/pnoa-ma?service=WMS&request=GetCapabilities
//
// Findings:
//   * National DEM service exposes 1000 / 500 / 200 / 25 / 5 m products.
//   * Best nationwide terrain raster available through the official WCS is 5 m.
//   * Mainland / Balearic native coverage is Elevacion25830_5 (EPSG:25830).
//   * Canary native coverage is Elevacion4083_5 (EPSG:4083 / REGCAN95 UTM28).
//   * A validated GetCoverage request works reliably without WCS scaling; we
//     therefore engage only once the native request footprint stays bounded.
// ---------------------------------------------------------------------------

const SPAIN_BOUNDS = [-19.5, 27.0, 5.5, 44.5];
const SPAIN_MAINLAND_BOUNDS = [-10.5, 35.0, 5.5, 44.5];
const SPAIN_CANARY_BOUNDS = [-19.5, 27.0, -12.0, 30.5];
const SPAIN_DEM_RESOLUTION_M = 5;
const SPAIN_DEM_MINZOOM = 12;
const SPAIN_ENGAGE_MPP = 32;
const SPAIN_FETCH_TIMEOUT_MS = 15_000;
const SPAIN_CONCURRENCY = 6;
const SPAIN_QUEUE_MAX = 120;
const SPAIN_WCS_VERSION = '2.0.1';
const SPAIN_WCS_FORMAT = 'image/tiff';

const SPAIN_WCS_COVERAGES = {
  mainland: {
    key: 'mainland',
    coverageId: 'Elevacion25830_5',
    epsg: '25830',
    utmZone: 30,
  },
  canary: {
    key: 'canary',
    coverageId: 'Elevacion4083_5',
    epsg: '4083',
    utmZone: 28,
  },
};

function shouldUseSpain(mercZ, lat) {
  if (mercZ < SPAIN_DEM_MINZOOM) return false;
  return mercatorMetersPerPixel(mercZ, lat) <= SPAIN_ENGAGE_MPP;
}