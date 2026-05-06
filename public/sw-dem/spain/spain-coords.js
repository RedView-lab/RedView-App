// ---------------------------------------------------------------------------
// Spain — bbox classification + WGS84 -> projected native DEM coverage space
// ---------------------------------------------------------------------------

function tileOverlapsSpain(z, x, y) {
  const b = mercatorTileBounds(z, x, y);
  const [w, s, e, n] = SPAIN_BOUNDS;
  return !(b.east < w || b.west > e || b.south > n || b.north < s);
}

function isSpainCanaryLngLat(lng, lat) {
  const [w, s, e, n] = SPAIN_CANARY_BOUNDS;
  return lng >= w && lng <= e && lat >= s && lat <= n;
}

function pickSpainCoverage(lng, lat) {
  if (isSpainCanaryLngLat(lng, lat)) return SPAIN_WCS_COVERAGES.canary;
  const [w, s, e, n] = SPAIN_MAINLAND_BOUNDS;
  if (lng >= w && lng <= e && lat >= s && lat <= n) return SPAIN_WCS_COVERAGES.mainland;
  return SPAIN_WCS_COVERAGES.mainland;
}

function wgs84ToSpainProjected(lng, lat, utmZone) {
  const a = 6378137.0;
  const f = 1 / 298.257223563;
  const e2 = f * (2 - f);
  const ep2 = e2 / (1 - e2);
  const k0 = 0.9996;

  const phi = lat * Math.PI / 180;
  const lam = lng * Math.PI / 180;
  const lam0 = ((utmZone * 6) - 183) * Math.PI / 180;

  const sinPhi = Math.sin(phi);
  const cosPhi = Math.cos(phi);
  const tanPhi = Math.tan(phi);

  const N = a / Math.sqrt(1 - e2 * sinPhi * sinPhi);
  const T = tanPhi * tanPhi;
  const C = ep2 * cosPhi * cosPhi;
  const A = cosPhi * (lam - lam0);

  const e4 = e2 * e2;
  const e6 = e4 * e2;
  const M = a * (
    (1 - e2 / 4 - 3 * e4 / 64 - 5 * e6 / 256) * phi
    - (3 * e2 / 8 + 3 * e4 / 32 + 45 * e6 / 1024) * Math.sin(2 * phi)
    + (15 * e4 / 256 + 45 * e6 / 1024) * Math.sin(4 * phi)
    - (35 * e6 / 3072) * Math.sin(6 * phi)
  );

  return {
    E: k0 * N * (
      A
      + (1 - T + C) * Math.pow(A, 3) / 6
      + (5 - 18 * T + T * T + 72 * C - 58 * ep2) * Math.pow(A, 5) / 120
    ) + 500000,
    N: k0 * (
      M + N * tanPhi * (
        (A * A) / 2
        + (5 - T + 9 * C + 4 * C * C) * Math.pow(A, 4) / 24
        + (61 - 58 * T + T * T + 600 * C - 330 * ep2) * Math.pow(A, 6) / 720
      )
    ),
  };
}

function projectMercatorTileToSpainCoverageBounds(z, x, y, coverage) {
  const b = mercatorTileBounds(z, x, y);
  const cLng = (b.west + b.east) / 2;
  const cLat = (b.north + b.south) / 2;
  const samples = [
    [b.west, b.south],
    [b.west, b.north],
    [b.east, b.south],
    [b.east, b.north],
    [cLng, cLat],
    [cLng, b.north],
    [cLng, b.south],
    [b.west, cLat],
    [b.east, cLat],
  ];

  let minE = Infinity;
  let maxE = -Infinity;
  let minN = Infinity;
  let maxN = -Infinity;
  for (const [lng, lat] of samples) {
    const p = wgs84ToSpainProjected(lng, lat, coverage.utmZone);
    if (p.E < minE) minE = p.E;
    if (p.E > maxE) maxE = p.E;
    if (p.N < minN) minN = p.N;
    if (p.N > maxN) maxN = p.N;
  }

  const grid = SPAIN_DEM_RESOLUTION_M;
  return {
    minE: Math.floor(minE / grid) * grid,
    minN: Math.floor(minN / grid) * grid,
    maxE: Math.ceil(maxE / grid) * grid,
    maxN: Math.ceil(maxN / grid) * grid,
  };
}