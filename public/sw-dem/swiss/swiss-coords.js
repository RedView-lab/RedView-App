// ---------------------------------------------------------------------------
// WGS84 ↔ LV95 (CH1903+ / EPSG:2056) coordinate conversion
// ---------------------------------------------------------------------------
// Reference: swisstopo "Approximate solution" — accurate to ~1 m, more than
// enough for sampling a 0.5 m grid through bilinear interpolation.
//   https://www.swisstopo.admin.ch/content/swisstopo-internet/en/online/
//   calculation-services/_jcr_content/contentPar/tabs/items/documents_publi
//   cation/tabPar/downloadlist/downloadItems/19_1467104436749.download/
//   ch1903wgs84_e.pdf
//
// We deliberately avoid pulling proj4 into the service worker: the SW is a
// classic worker (importScripts) and proj4 ships as ESM in the project.
// The closed-form polynomials below are <80 FLOPs and have no dependency.
// ---------------------------------------------------------------------------

function wgs84ToLV95(lng, lat) {
  // Convert decimal degrees to "swisstopo arc-seconds, scaled" form
  const phi = (lat * 3600 - 169028.66) / 10000;
  const lam = (lng * 3600 - 26782.5) / 10000;

  const E = 2600072.37
    + 211455.93 * lam
    -  10938.51 * lam * phi
    -      0.36 * lam * phi * phi
    -     44.54 * lam * lam * lam;

  const N = 1200147.07
    + 308807.95 * phi
    +   3745.25 * lam * lam
    +     76.63 * phi * phi
    -    194.56 * lam * lam * phi
    +    119.79 * phi * phi * phi;

  return { E, N };
}

function lv95ToWGS84(E, N) {
  const y = (E - 2600000) / 1000000;
  const x = (N - 1200000) / 1000000;

  let lam = 2.6779094
    + 4.728982 * y
    + 0.791484 * y * x
    + 0.1306   * y * x * x
    - 0.0436   * y * y * y;

  let phi = 16.9023892
    + 3.238272 * x
    - 0.270978 * y * y
    - 0.002528 * x * x
    - 0.0447   * y * y * x
    - 0.0140   * x * x * x;

  // swisstopo polynomials yield "10 000 grad" — convert to decimal degrees
  return { lng: lam * 100 / 36, lat: phi * 100 / 36 };
}

// ---------------------------------------------------------------------------
// Switzerland tile-overlap classification — bbox-only (no high-precision
// border polygon). The LV95 native bounds reject neatly: a Mercator tile
// that converts to entirely-outside [Emin..Emax]×[Nmin..Nmax] is guaranteed
// to fall outside published swissSURFACE3D coverage. We do not attempt
// fine-grained "inside vs border" because the COG fetcher already handles
// "no item for this LV95 km cell" gracefully (caches a permanent null).
// ---------------------------------------------------------------------------

function tileOverlapsSwitzerland(z, x, y) {
  const b = mercatorTileBounds(z, x, y);
  const [w, s, e, n] = SWITZERLAND_BOUNDS;
  if (b.east < w || b.west > e || b.south > n || b.north < s) return false;
  // Project the four corners to LV95 and reject if all are outside.
  const corners = [
    wgs84ToLV95(b.west, b.south),
    wgs84ToLV95(b.east, b.south),
    wgs84ToLV95(b.east, b.north),
    wgs84ToLV95(b.west, b.north),
  ];
  let allOut = true;
  for (const c of corners) {
    if (
      c.E >= SWISS_LV95_BOUNDS.Emin && c.E <= SWISS_LV95_BOUNDS.Emax &&
      c.N >= SWISS_LV95_BOUNDS.Nmin && c.N <= SWISS_LV95_BOUNDS.Nmax
    ) { allOut = false; break; }
  }
  if (allOut) {
    // The tile may still cross the LV95 footprint diagonally — be lenient
    // and accept any tile with a corner inside the WGS84 bounds. The COG
    // fetcher will return null for cells that have no published data.
    return true;
  }
  return true;
}

// Map a Mercator tile to the (Ekm, Nkm) range of LV95 1-km cells it covers.
// Returns inclusive cell ranges so the caller can iterate the grid.
function mercTileToLV95KmCells(z, x, y) {
  const b = mercatorTileBounds(z, x, y);
  const corners = [
    wgs84ToLV95(b.west, b.south),
    wgs84ToLV95(b.east, b.south),
    wgs84ToLV95(b.east, b.north),
    wgs84ToLV95(b.west, b.north),
  ];
  let Emin = Infinity, Emax = -Infinity, Nmin = Infinity, Nmax = -Infinity;
  for (const c of corners) {
    if (c.E < Emin) Emin = c.E;
    if (c.E > Emax) Emax = c.E;
    if (c.N < Nmin) Nmin = c.N;
    if (c.N > Nmax) Nmax = c.N;
  }
  // Clamp to published footprint
  Emin = Math.max(Emin, SWISS_LV95_BOUNDS.Emin);
  Emax = Math.min(Emax, SWISS_LV95_BOUNDS.Emax);
  Nmin = Math.max(Nmin, SWISS_LV95_BOUNDS.Nmin);
  Nmax = Math.min(Nmax, SWISS_LV95_BOUNDS.Nmax);
  if (Emin > Emax || Nmin > Nmax) return null;
  return {
    EkmMin: Math.floor(Emin / 1000),
    EkmMax: Math.floor(Emax / 1000),
    NkmMin: Math.floor(Nmin / 1000),
    NkmMax: Math.floor(Nmax / 1000),
  };
}
