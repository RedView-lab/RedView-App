/**
 * Géométrie du corridor POI (POST /corridor) — fonctions pures, sans base,
 * importées par server.js et par les bancs d'essai.
 *
 * La trace reçue est une POLYLIGNE : chaque couple de points consécutifs est
 * un segment, et un POI est retenu s'il est à moins de `radius` d'un segment
 * (pas seulement d'un point). Les clients récents envoient une trace
 * simplifiée (segments longs en ligne droite) ; les anciens clients envoient
 * des points rapprochés — les deux donnent le même résultat.
 *
 * Métrique : équirectangulaire locale par segment (kx = 111320·cos(lat
 * moyenne du segment), ky = 110574), identique à l'ancienne version.
 */

const M_PER_DEG_LAT = 110574;
const M_PER_DEG_LON_EQ = 111320;
const DEG = Math.PI / 180;

/** Longueur max (m) de la portion de trace couverte par une même bbox R*Tree. */
function maxBoxSpanM(radius) {
  return Math.max(25 * radius, 2_000);
}

/**
 * Bbox de requête candidates : tronçons consécutifs d'au plus `chunkPoints`
 * points ET d'au plus `maxBoxSpanM(radius)` de long, chaque bbox élargie du
 * rayon. Un segment plus long que cette portée est découpé en morceaux
 * (sinon une diagonale de 50 km interrogerait 50 × 50 km de POI).
 *
 * Correction : chaque segment (ou morceau de segment) est entièrement dans
 * au moins une bbox ; élargie de `radius` (en longitude au |lat| max de la
 * bbox, cos minimal), elle contient tout POI à moins de `radius` de lui.
 *
 * @param {Array<[number, number]>} points [lat, lon]
 * @returns {Array<[number, number, number, number]>} [minLon, maxLon, minLat, maxLat]
 */
export function corridorQueryBoxes(points, radius, chunkPoints = 50) {
  const boxes = [];
  if (points.length < 2) return boxes;
  const span = maxBoxSpanM(radius);
  const degLat = radius / M_PER_DEG_LAT;

  let box = null;
  let boxPoints = 0;
  let boxLen = 0;
  const flush = () => {
    if (!box) return;
    const cosLat = Math.max(0.01, Math.cos(box.maxAbsLat * DEG));
    const degLon = radius / (M_PER_DEG_LON_EQ * cosLat);
    boxes.push([box.minLon - degLon, box.maxLon + degLon, box.minLat - degLat, box.maxLat + degLat]);
    box = null;
    boxPoints = 0;
    boxLen = 0;
  };
  const add = (lat, lon) => {
    if (!box) {
      box = { minLat: lat, maxLat: lat, minLon: lon, maxLon: lon, maxAbsLat: Math.abs(lat) };
    } else {
      if (lat < box.minLat) box.minLat = lat;
      if (lat > box.maxLat) box.maxLat = lat;
      if (lon < box.minLon) box.minLon = lon;
      if (lon > box.maxLon) box.maxLon = lon;
      if (Math.abs(lat) > box.maxAbsLat) box.maxAbsLat = Math.abs(lat);
    }
    boxPoints++;
  };

  for (let i = 0; i < points.length - 1; i++) {
    const [lat1, lon1] = points[i];
    const [lat2, lon2] = points[i + 1];
    const len = segmentLengthM(lat1, lon1, lat2, lon2);
    const pieces = Math.max(1, Math.ceil(len / span));
    const pieceLen = len / pieces;
    for (let k = 0; k < pieces; k++) {
      const t0 = k / pieces;
      const t1 = (k + 1) / pieces;
      const aLat = lat1 + t0 * (lat2 - lat1);
      const aLon = lon1 + t0 * (lon2 - lon1);
      const bLat = lat1 + t1 * (lat2 - lat1);
      const bLon = lon1 + t1 * (lon2 - lon1);
      // Nouveau tronçon si celui-ci est plein (points ou longueur) : il
      // repart du début du morceau, qui reste ainsi couvert.
      if (box && (boxPoints >= chunkPoints || boxLen + pieceLen > span)) flush();
      if (!box) add(aLat, aLon);
      add(bLat, bLon);
      boxLen += pieceLen;
    }
  }
  flush();
  return boxes;
}

function segmentLengthM(lat1, lon1, lat2, lon2) {
  const kx = M_PER_DEG_LON_EQ * Math.cos(((lat1 + lat2) / 2) * DEG);
  const dx = (lon2 - lon1) * kx;
  const dy = (lat2 - lat1) * M_PER_DEG_LAT;
  return Math.sqrt(dx * dx + dy * dy);
}

/** Distance² (m²) d'un point à un segment, métrique locale du segment. */
export function segmentDistanceSq(lat1, lon1, lat2, lon2, lat, lon) {
  const kx = M_PER_DEG_LON_EQ * Math.cos(((lat1 + lat2) / 2) * DEG);
  const ky = M_PER_DEG_LAT;
  const x2 = (lon2 - lon1) * kx;
  const y2 = (lat2 - lat1) * ky;
  const px = (lon - lon1) * kx;
  const py = (lat - lat1) * ky;
  const segLenSq = x2 * x2 + y2 * y2;
  let t = segLenSq === 0 ? 0 : (px * x2 + py * y2) / segLenSq;
  t = Math.max(0, Math.min(1, t));
  const ddx = px - t * x2;
  const ddy = py - t * y2;
  return ddx * ddx + ddy * ddy;
}

/** Plafond d'entrées de la grille (cellules × segments) : borne mémoire/CPU. */
const MAX_GRID_STEPS = 500_000;

/**
 * Filtre les candidats à moins de `radius` de la polyligne.
 *
 * Index : grille de côté `cellM >= 2 × radius`. Chaque segment est parcouru
 * par pas <= cellM/2 et inscrit dans la cellule de chaque pas ; un POI ne
 * teste que les segments inscrits dans son voisinage 3×3.
 *
 * Correction : si un POI P est à <= radius d'un segment (point le plus
 * proche Q), un pas S du segment est à <= cellM/4 de Q, donc
 * |PS| <= radius + cellM/4 <= 3/4·cellM. L'échelle en longitude de la grille
 * utilise le cos minimal de la trace (|lat| max) : les écarts dans la grille
 * sont <= aux écarts réels, donc S tombe dans le voisinage 3×3 de P.
 * L'ancienne version n'inscrivait que les points d'échantillonnage : un POI
 * au milieu d'un segment plus long que ~2 × radius était perdu.
 *
 * @param {Array<[number, number]>} points [lat, lon]
 * @param {number} radius mètres
 * @param {Array<{lat: number, lon: number}>} candidates
 * @returns {Array} candidats retenus (mêmes objets)
 */
export function selectCorridorCandidates(points, radius, candidates) {
  if (candidates.length === 0 || points.length === 0) return [];
  if (points.length === 1) {
    const [lat, lon] = points[0];
    return candidates.filter((poi) => segmentDistanceSq(lat, lon, lat, lon, poi.lat, poi.lon) <= radius * radius);
  }

  let minLat = 90, maxLat = -90, minLon = 180, maxLon = -180, maxAbsLat = 0;
  let totalLen = 0;
  for (let i = 0; i < points.length; i++) {
    const [lat, lon] = points[i];
    if (lat < minLat) minLat = lat;
    if (lat > maxLat) maxLat = lat;
    if (lon < minLon) minLon = lon;
    if (lon > maxLon) maxLon = lon;
    if (Math.abs(lat) > maxAbsLat) maxAbsLat = Math.abs(lat);
    if (i > 0) totalLen += segmentLengthM(points[i - 1][0], points[i - 1][1], lat, lon);
  }
  const originLat = (minLat + maxLat) / 2;
  const originLon = (minLon + maxLon) / 2;
  const mPerDegLon = M_PER_DEG_LON_EQ * Math.max(0.01, Math.cos(Math.min(90, maxAbsLat) * DEG));

  // Des cellules plus grandes ne coûtent que des segments candidats en plus
  // (le test de distance reste exact) ; on les agrandit pour borner le nombre
  // de pas sur des traces démesurées.
  const cellM = Math.max(radius * 2, 100, (2 * totalLen) / MAX_GRID_STEPS);
  const stepM = cellM / 2;
  const toCellX = (lon) => Math.floor(((lon - originLon) * mPerDegLon) / cellM);
  const toCellY = (lat) => Math.floor(((lat - originLat) * M_PER_DEG_LAT) / cellM);
  const cellKey = (cx, cy) => `${cx}:${cy}`;

  const grid = new Map();
  const register = (key, seg) => {
    const bucket = grid.get(key);
    if (!bucket) grid.set(key, [seg]);
    else if (bucket[bucket.length - 1] !== seg) bucket.push(seg);
  };
  for (let i = 0; i < points.length - 1; i++) {
    const [lat1, lon1] = points[i];
    const [lat2, lon2] = points[i + 1];
    const steps = Math.max(1, Math.ceil(segmentLengthM(lat1, lon1, lat2, lon2) / stepM));
    let prevKey = null;
    for (let k = 0; k <= steps; k++) {
      const t = k / steps;
      const key = cellKey(toCellX(lon1 + t * (lon2 - lon1)), toCellY(lat1 + t * (lat2 - lat1)));
      if (key === prevKey) continue;
      prevKey = key;
      register(key, i);
    }
  }

  const radiusSq = radius * radius;
  const accepted = [];
  for (const poi of candidates) {
    const cx = toCellX(poi.lon);
    const cy = toCellY(poi.lat);
    const seen = new Set();
    let inside = false;
    for (let dx = -1; dx <= 1 && !inside; dx++) {
      for (let dy = -1; dy <= 1 && !inside; dy++) {
        const bucket = grid.get(cellKey(cx + dx, cy + dy));
        if (!bucket) continue;
        for (const i of bucket) {
          if (seen.has(i)) continue;
          seen.add(i);
          const [lat1, lon1] = points[i];
          const [lat2, lon2] = points[i + 1];
          if (segmentDistanceSq(lat1, lon1, lat2, lon2, poi.lat, poi.lon) <= radiusSq) {
            inside = true;
            break;
          }
        }
      }
    }
    if (inside) accepted.push(poi);
  }
  return accepted;
}
