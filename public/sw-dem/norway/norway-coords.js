// ---------------------------------------------------------------------------
// Norway — bbox classification + WGS84 -> EUREF89 / UTM projection helpers
// ---------------------------------------------------------------------------

function tileOverlapsNorway(z, x, y) {
  const b = mercatorTileBounds(z, x, y);
  const [w, s, e, n] = NORWAY_BOUNDS;
  return !(b.east < w || b.west > e || b.south > n || b.north < s);
}

function pickNorwayUTMZone(lng) {
  if (lng < 12) return 32;
  if (lng < 24) return 33;
  return 35;
}

function getNorwayZoneOrder(lng) {
  const primary = pickNorwayUTMZone(lng);
  if (primary === 32) return [32, 33, 35];
  if (primary === 35) return [35, 33, 32];
  return lng < 18 ? [33, 32, 35] : [33, 35, 32];
}

function wgs84ToNorwayUTM(lng, lat, zone) {
  const a = 6378137.0;
  const f = 1 / 298.257223563;
  const e2 = f * (2 - f);
  const ep2 = e2 / (1 - e2);
  const k0 = 0.9996;

  const phi = lat * Math.PI / 180;
  const lam = lng * Math.PI / 180;
  const lam0 = ((zone * 6) - 183) * Math.PI / 180;

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

  const easting = k0 * N * (
    A
    + (1 - T + C) * Math.pow(A, 3) / 6
    + (5 - 18 * T + T * T + 72 * C - 58 * ep2) * Math.pow(A, 5) / 120
  ) + 500000;

  const northing = k0 * (
    M + N * tanPhi * (
      (A * A) / 2
      + (5 - T + 9 * C + 4 * C * C) * Math.pow(A, 4) / 24
      + (61 - 58 * T + T * T + 600 * C - 330 * ep2) * Math.pow(A, 6) / 720
    )
  );

  return { E: easting, N: northing };
}

function projectMercatorTileToNorwayUTMExtent(z, x, y, zone) {
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
    const p = wgs84ToNorwayUTM(lng, lat, zone);
    if (p.E < minE) minE = p.E;
    if (p.E > maxE) maxE = p.E;
    if (p.N < minN) minN = p.N;
    if (p.N > maxN) maxN = p.N;
  }

  return {
    minE,
    minN,
    maxE,
    maxN,
  };
}