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
// IDEE backend can be slow on cold misses (server-side raster generation
// for the requested bbox). 15 s was occasionally too tight on first visits
// to a fresh region — the abort fired, work was wasted and tiles were
// re-queued, snowballing perceived "an eternity to load" on first paint.
const SPAIN_FETCH_TIMEOUT_MS = 30_000;
// Each request returns a fixed 16-bit TIFF served by a CloudFront edge with
// year-long max-age. 256² (~131 KB) was the original choice; bumped to 512²
// (~520 KB) so the source raster matches the MDT5 native 5 m grid at z14-15
// (a z14 Spanish tile is ~2.5 km wide → 500² native pixels, so 512² captures
// essentially every native pixel without server-side downsampling and its
// associated low-pass artefacts that produced the visible "wavy contour"
// lines on smooth slopes). 4× more bytes per tile, but on fibre that's
// imperceptible compared to backend cold-miss latency, and CloudFront still
// year-caches everything.
// Concurrency raised 16→24 (May 06 perf pass): IDEE responses are now
// CloudFront-edge cached year-long thanks to scaleSize=512 capping, so the
// real cost per request is dominated by RTT, not backend compute. HTTP/2 on
// servicios.idee.es comfortably multiplexes 24+ streams; previously 16 hit
// pruning during fast pans across the Pyrenees viewport (which can require
// 30+ Spanish tiles in a single burst once mainland + canary hops merge).
// Queue 400→600 keeps the head from being pruned out from under the active
// viewport when the pan stalls briefly on a dezoom.
const SPAIN_CONCURRENCY = 24;
const SPAIN_QUEUE_MAX = 600;
const SPAIN_WCS_OUTPUT_PX = 512;
const SPAIN_WCS_VERSION = '2.0.1';
const SPAIN_WCS_FORMAT = 'image/tiff';
// MDT5 stores elevations as Int16 in metres → 1 m vertical quantization. On
// pentes douces (≤ ~15°) this surfaces as 1 m horizontal "stair" contours
// in the 3D mesh ("micro-ondulations"). A light 3×3 low-pass applied only
// where the local 3×3 height span is below this threshold smooths the
// quantization without softening real cliffs / ridges.
const SPAIN_SMOOTH_VARIANCE_M = 4;

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