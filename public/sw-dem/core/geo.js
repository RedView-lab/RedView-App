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

// Vrai quand la bbox de la tuile recoupe la bbox d'un territoire français
// d'outre-mer (REU / GLP / MTQ / MYT / GUF). Sert au dispatcher DEM pour engager
// le pipeline IGN HD hors de la métropole — même point d'accès WMTS, même
// TileMatrixSet mondial WGS84G, seule la bbox d'entrée change.
function tileOverlapsOverseasFrance(z, x, y) {
  const b = mercatorTileBounds(z, x, y);
  for (const [w, s, e, n] of OVERSEAS_FRANCE_BOUNDS) {
    if (!(b.east < w || b.west > e || b.south > n || b.north < s)) return true;
  }
  return false;
}

// Classement des tuiles DEM par polygone (exige que ensureFrancePoly() ait chargé)
// Renvoie 'inside' | 'border' | 'outside'
//
// Priorité IGN aux zooms élevés : à z≥12, toute tuile traversée par un bord de
// la France est classée au moins 'border' — l'IGN est donc tenté même quand
// l'échantillonnage 6×6 du polygone ne trouve aucun point intérieur.
// Corrige le bug des sommets du Mont Blanc / des Pyrénées / de la côte corse,
// où une tuile z15-17 (~20 à 80 m de large) sur une crête peut avoir tous ses
// échantillons hors du polygone France alors que la grille LiDAR HD couvre une
// partie de la tuile. Sans cette promotion, on sautait l'IGN et on retombait
// sur Mapbox à 30 m — exactement le symptôme signalé par l'utilisateur.
function classifyDemTile(z, x, y) {
  if (!francePoly) return 'inside'; // repli si le polygone n'est pas chargé
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
  // 0 point intérieur et aucun sommet du polygone : normalement 'outside', mais
  // aux zooms élevés on laisse sa chance à l'IGN quand un bord de la France
  // traverse vraiment la tuile (plus une marge de 10 %) — tuiles de sommet ou de
  // crête où l'échantillonnage rate la frange française. L'ancien test de bbox
  // FRANCE_BOUNDS classait le nord-ouest de l'Italie, la Belgique, le Luxembourg
  // et le sud-ouest de l'Allemagne en 'border' : l'IGN y échouait, le repli AWS
  // était sauté et le DEM / les pentes restaient vides.
  if (z >= 12) {
    const marginLng = (b.east - b.west) * 0.1;
    const marginLat = (b.north - b.south) * 0.1;
    if (franceBorderNearBBox(b, marginLng, marginLat)) return 'border';
  }
  return 'outside';
}
