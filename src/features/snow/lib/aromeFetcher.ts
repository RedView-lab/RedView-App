// ============================================================================
// AROME snow fetcher — Open-Meteo proxy
// ----------------------------------------------------------------------------
// L'équivalent de RedView v0.1 / arome_client.
//
// On évite de parser GRIB2 dans le browser : Open-Meteo expose le modèle
// `meteofrance_arome_france` (résolution 0.025°, mise à jour 3h, runs 0/3/6/9/
// 12/15/18/21h) via JSON. Variable utilisée : `snow_depth` (m).
//
// Stratégie :
//   1. Convertir la bbox LiDAR (Lambert93/UTM) → WGS84
//   2. Étendre la bbox de ±0.05° pour avoir au moins 5×5 points AROME
//   3. Construire une grille régulière à 0.025° (≈ résolution native AROME)
//   4. Une seule requête Open-Meteo avec toutes les coords (séparées par `,`)
//   5. Sélectionner l'heure courante (forecast `current_hour`)
//   6. Convertir en cm, retourner `AromeSnowGrid`
// ============================================================================

import proj4 from 'proj4';
import type { AromeSnowGrid, SnowHeightmap } from '../types';

// CRS déjà enregistrés par features/lidar/coordConvert.ts au moment où
// l'application charge ; on ré-enregistre par sécurité (workers, viewer).
proj4.defs(
  'EPSG:2154',
  '+proj=lcc +lat_0=46.5 +lon_0=3 +lat_1=49 +lat_2=44 +x_0=700000 +y_0=6600000 +ellps=GRS80 +towgs84=0,0,0,0,0,0,0 +units=m +no_defs +type=crs',
);
proj4.defs(
  'EPSG:2975',
  '+proj=utm +zone=40 +south +ellps=GRS80 +towgs84=0,0,0,0,0,0,0 +units=m +no_defs +type=crs',
);

/** Résolution native du modèle Open-Meteo AROME France. */
const AROME_RES_DEG = 0.025;

/** Marge minimum de bbox AROME (en degrés) autour de la zone LiDAR. */
const MIN_MARGIN_DEG = 0.05;

/** Plafond du nombre total de points dans une requête Open-Meteo. */
const MAX_POINTS = 100;

interface OpenMeteoForecastResponse {
  // Si plusieurs lat/lon sont passées, l'API renvoie un tableau d'objets.
  // Sinon un objet unique.
  latitude: number | number[];
  longitude: number | number[];
  hourly?: {
    time: string[];
    snow_depth?: (number | null)[];
  };
  // Format multi-location : Open-Meteo renvoie en fait un *tableau*
  // au top-level → on gère les deux dans `parseResponse`.
}

function projDef(crs: SnowHeightmap['crs']): string {
  return crs === 'RGR92UTM40S' ? 'EPSG:2975' : 'EPSG:2154';
}

/** Bbox CRS → WGS84 (4 coins, on prend l'enveloppe). */
function bboxToWgs84(
  bounds: SnowHeightmap['bounds'],
  crs: SnowHeightmap['crs'],
): { lonMin: number; latMin: number; lonMax: number; latMax: number } {
  const proj = projDef(crs);
  const corners: [number, number][] = [
    [bounds.minX, bounds.minY],
    [bounds.maxX, bounds.minY],
    [bounds.maxX, bounds.maxY],
    [bounds.minX, bounds.maxY],
  ];
  let lonMin = Infinity, lonMax = -Infinity;
  let latMin = Infinity, latMax = -Infinity;
  for (const [x, y] of corners) {
    const [lon, lat] = proj4(proj, 'EPSG:4326', [x, y]) as [number, number];
    if (lon < lonMin) lonMin = lon;
    if (lon > lonMax) lonMax = lon;
    if (lat < latMin) latMin = lat;
    if (lat > latMax) latMax = lat;
  }
  return { lonMin, latMin, lonMax, latMax };
}

/** Construit une grille régulière de points dans la bbox AROME. */
function buildSampleGrid(
  lonMin: number,
  latMin: number,
  lonMax: number,
  latMax: number,
): { lats: number[]; lons: number[]; nx: number; ny: number } {
  // Étape 1: snap aux multiples de 0.025° pour aligner avec la grille AROME
  const snap = (v: number) => Math.round(v / AROME_RES_DEG) * AROME_RES_DEG;
  const lo0 = snap(lonMin);
  const lo1 = snap(lonMax);
  const la0 = snap(latMin);
  const la1 = snap(latMax);

  let nx = Math.max(5, Math.round((lo1 - lo0) / AROME_RES_DEG) + 1);
  let ny = Math.max(5, Math.round((la1 - la0) / AROME_RES_DEG) + 1);

  // Cap au plafond MAX_POINTS — quitte à dégrader la résolution
  while (nx * ny > MAX_POINTS) {
    if (nx >= ny) nx = Math.max(5, nx - 1);
    else ny = Math.max(5, ny - 1);
    if (nx === 5 && ny === 5) break;
  }

  const dLon = nx > 1 ? (lo1 - lo0) / (nx - 1) : 0;
  const dLat = ny > 1 ? (la1 - la0) / (ny - 1) : 0;

  const lats: number[] = [];
  const lons: number[] = [];
  for (let j = 0; j < ny; j++) {
    for (let i = 0; i < nx; i++) {
      lats.push(+(la0 + j * dLat).toFixed(4));
      lons.push(+(lo0 + i * dLon).toFixed(4));
    }
  }
  return { lats, lons, nx, ny };
}

/** Trouve l'index horaire le plus proche de "maintenant" dans la timeline. */
function nearestHourIndex(times: string[]): number {
  if (times.length === 0) return -1;
  const now = Date.now();
  let bestIdx = 0;
  let bestDt = Infinity;
  for (let i = 0; i < times.length; i++) {
    const t = Date.parse(times[i] + ':00Z'); // Open-Meteo: "2026-04-23T12:00"
    const dt = Math.abs(t - now);
    if (dt < bestDt) { bestDt = dt; bestIdx = i; }
  }
  return bestIdx;
}

/** Récupère les données de neige AROME pour la zone LiDAR. */
export async function fetchAromeSnowGrid(
  heightmap: SnowHeightmap,
  signal?: AbortSignal,
): Promise<AromeSnowGrid> {
  const wgs = bboxToWgs84(heightmap.bounds, heightmap.crs);

  // Marge pour la régression terrain (besoin d'au moins 5×5 cellules)
  const range = Math.max(wgs.lonMax - wgs.lonMin, wgs.latMax - wgs.latMin);
  const margin = Math.max(MIN_MARGIN_DEG, range * 0.3);

  const lonMin = wgs.lonMin - margin;
  const lonMax = wgs.lonMax + margin;
  const latMin = wgs.latMin - margin;
  const latMax = wgs.latMax + margin;

  const { lats, lons, nx, ny } = buildSampleGrid(lonMin, latMin, lonMax, latMax);

  // Open-Meteo accepte plusieurs lat/lon en CSV. Réponse = tableau.
  const url =
    `/api/openmeteo/v1/forecast` +
    `?latitude=${lats.join(',')}` +
    `&longitude=${lons.join(',')}` +
    `&hourly=snow_depth` +
    `&models=meteofrance_arome_france` +
    `&forecast_days=1` +
    `&past_days=0` +
    `&timezone=UTC`;

  const res = await fetch(url, { signal });
  if (!res.ok) {
    throw new Error(`AROME fetch failed: HTTP ${res.status} ${res.statusText}`);
  }

  const json = await res.json();
  const list: OpenMeteoForecastResponse[] = Array.isArray(json) ? json : [json];

  if (list.length !== nx * ny) {
    throw new Error(
      `AROME response mismatch: expected ${nx * ny} points, got ${list.length}`,
    );
  }

  // Sélection du créneau horaire le plus proche (commun à toutes les locations)
  const firstHourly = list[0]?.hourly;
  if (!firstHourly?.time) {
    throw new Error('AROME response missing hourly.time');
  }
  const hourIdx = nearestHourIndex(firstHourly.time);
  if (hourIdx < 0) throw new Error('AROME no usable hourly data');

  // Extraire snow_depth (m) → cm. flip rows pour avoir row 0 = sud.
  const data = new Float32Array(nx * ny);
  for (let j = 0; j < ny; j++) {
    for (let i = 0; i < nx; i++) {
      const flatIdx = j * nx + i;
      const point = list[flatIdx];
      const m = point?.hourly?.snow_depth?.[hourIdx];
      data[flatIdx] = (typeof m === 'number' && Number.isFinite(m) && m > 0) ? m * 100 : 0;
    }
  }

  // Reconvertir la bbox AROME (WGS84) → CRS de la heightmap pour le couplage
  const proj = projDef(heightmap.crs);
  const corners: [number, number][] = [
    [lons[0], lats[0]],                        // SW
    [lons[nx - 1], lats[0]],                   // SE
    [lons[nx - 1], lats[(ny - 1) * nx]],       // NE  (lats stockés row-major)
    [lons[0], lats[(ny - 1) * nx]],            // NW
  ];
  let mxMin = Infinity, mxMax = -Infinity, myMin = Infinity, myMax = -Infinity;
  for (const [lon, lat] of corners) {
    const [x, y] = proj4('EPSG:4326', proj, [lon, lat]) as [number, number];
    if (x < mxMin) mxMin = x;
    if (x > mxMax) mxMax = x;
    if (y < myMin) myMin = y;
    if (y > myMax) myMax = y;
  }

  // Stats pour debug
  const validVals = Array.from(data).filter((v) => v > 0);
  const meanCm = validVals.length > 0
    ? validVals.reduce((a, b) => a + b, 0) / validVals.length
    : 0;
  const maxCm = validVals.length > 0 ? Math.max(...validVals) : 0;
  console.log(
    `[snow/arome] grid ${nx}×${ny}, ${validVals.length}/${data.length} non-zero, ` +
    `mean=${meanCm.toFixed(1)}cm, max=${maxCm.toFixed(1)}cm, hour=${firstHourly.time[hourIdx]}`,
  );

  return {
    width: nx,
    height: ny,
    snowDepthCm: data,
    boundsMeters: [mxMin, myMin, mxMax, myMax],
    resolutionM: AROME_RES_DEG * 111_000, // ≈ 2750m
    timestamp: firstHourly.time[hourIdx] + 'Z',
    runHour: '00',
    source: 'open-meteo-arome',
  };
}
