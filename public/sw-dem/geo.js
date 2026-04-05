// ---------------------------------------------------------------------------
// Coordinate conversions & France bounds check
// ---------------------------------------------------------------------------

function mercatorTileBounds(z, x, y) {
  const n = Math.PI - (2 * Math.PI * y) / (1 << z);
  const s = Math.PI - (2 * Math.PI * (y + 1)) / (1 << z);
  return {
    west: (x / (1 << z)) * 360 - 180,
    east: ((x + 1) / (1 << z)) * 360 - 180,
    north: (Math.atan(Math.sinh(n)) * 180) / Math.PI,
    south: (Math.atan(Math.sinh(s)) * 180) / Math.PI,
  };
}

function lngLatToWGS84GTile(lng, lat, z) {
  const matrixWidth = 1 << (z + 1);
  const matrixHeight = 1 << z;
  return {
    col: Math.max(0, Math.min(Math.floor(((lng + 180) / 360) * matrixWidth), matrixWidth - 1)),
    row: Math.max(0, Math.min(Math.floor(((90 - lat) / 180) * matrixHeight), matrixHeight - 1)),
  };
}

function mercatorYToLat(yFrac) {
  const mercY = Math.PI * (1 - 2 * yFrac);
  return (Math.atan(Math.sinh(mercY)) * 180) / Math.PI;
}

function tileOverlapsFrance(z, x, y) {
  const b = mercatorTileBounds(z, x, y);
  const [w, s, e, n] = FRANCE_BOUNDS;
  return !(b.east < w || b.west > e || b.south > n || b.north < s);
}
