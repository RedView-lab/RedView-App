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
//   * GetCoverage with `scaleSize=x(256),y(256)` makes the server downsample
//     server-side and serve a fixed 256x256 16-bit TIFF (~131 KB) with a
//     1-year CloudFront cache. Without this, a single z12 tile transfers
//     ~8 MB (10 km × 10 km / 5 m → 2000² native pixels) which saturated the
//     SW fetch queue, stranded the slope/altitude pill at 1 % and produced
//     intermittent flat tiles when the request timed out before the body
//     finished downloading.
// ---------------------------------------------------------------------------

const SPAIN_BOUNDS = [-19.5, 27.0, 5.5, 44.5];
const SPAIN_MAINLAND_BOUNDS = [-10.5, 35.0, 5.5, 44.5];
const SPAIN_CANARY_BOUNDS = [-19.5, 27.0, -12.0, 30.5];
const SPAIN_DEM_RESOLUTION_M = 5;
const SPAIN_DEM_MINZOOM = 12;
const SPAIN_ENGAGE_MPP = 32;
const SPAIN_FETCH_TIMEOUT_MS = 15_000;
// Each request now returns a fixed 256x256 16-bit TIFF (~131 KB) thanks to
// scaleSize, and is served by a CloudFront edge with year-long max-age.
// We can safely run a deeper queue / higher concurrency than the original
// design that assumed multi-MB payloads.
const SPAIN_CONCURRENCY = 16;
const SPAIN_QUEUE_MAX = 400;
// Server-side output dimensions — must match DEM_TILE_SIZE so the parsed
// TIFF can skip the local nearest-neighbour resample entirely.
const SPAIN_WCS_OUTPUT_PX = 256;
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