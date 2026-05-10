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

// True when the tile bbox overlaps any French overseas territory bbox
// (REU / GLP / MTQ / MYT / GUF). Used by the DEM dispatcher to engage the
// IGN HD pipeline outside metropolitan France — same WMTS endpoint, same
// global WGS84G TileMatrixSet, just a different bbox gate.
function tileOverlapsOverseasFrance(z, x, y) {
  const b = mercatorTileBounds(z, x, y);
  for (const [w, s, e, n] of OVERSEAS_FRANCE_BOUNDS) {
    if (!(b.east < w || b.west > e || b.south > n || b.north < s)) return true;
  }
  return false;
}

// Polygon-based DEM tile classification (requires ensureFrancePoly() loaded)
// Returns 'inside' | 'border' | 'outside'
//
// IGN-first bias at high zoom: at z≥12 any tile whose Mercator bounds
// overlap FRANCE_BOUNDS is classified as at least 'border' — i.e. IGN is
// attempted even when the 6×6 polygon sampling finds 0 inside points.
// This fixes the Mont Blanc / Pyrénées / Corsican-coast summit bug where
// a z15-17 tile (~20-80 m wide) at a ridgeline can have every sample fall
// outside the France polygon while the LiDAR HD grid still covers part
// of the tile. Without this promotion we'd skip IGN entirely and fall
// back to Mapbox 30 m — exactly the symptom the user reported.
function classifyDemTile(z, x, y) {
  if (!francePoly) return 'inside'; // fallback if polygon not loaded
  const b = mercatorTileBounds(z, x, y);
  let insideCount = 0;
  const N = 6;
  for (let i = 0; i < N; i++) {
    for (let j = 0; j < N; j++) {
      const lng = b.west + (b.east - b.west) * (i + 0.5) / N;
      const lat = b.south + (b.north - b.south) * (j + 0.5) / N;
      if (pointInFrance(lng, lat)) insideCount++;
    }
  }
  const total = N * N;
  if (insideCount > 0 && insideCount < total) return 'border';
  if (hasPolyVertexInTile(b)) return 'border';
  if (insideCount === total) return 'inside';
  // 0 inside points + no polygon vertex: normally 'outside', but at high
  // zoom we give IGN a chance when the Mercator bbox overlaps France
  // (summit/border tiles where sampling misses the French sliver).
  const [w, s, e, n] = FRANCE_BOUNDS;
  const overlapsBounds = !(b.east < w || b.west > e || b.south > n || b.north < s);
  if (overlapsBounds && z >= 12) return 'border';
  return 'outside';
}
