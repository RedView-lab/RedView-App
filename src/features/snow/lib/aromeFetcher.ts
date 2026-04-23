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
//   5. Évaluer explicitement les champs par modèle et choisir l'instant le plus
//      proche du comportement RedView v0.1: première échéance exploitable du
//      run, avec fallback vers le snapshot non-nul le plus crédible
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
    // Quand on demande plusieurs `models=...`, Open-Meteo renvoie une clé par
    // modèle suffixée : `snow_depth_meteofrance_arome_france`, etc.
    // Sans suffixe = best_match.
    [key: string]: (number | null)[] | string[] | undefined;
  };
  // Format multi-location : Open-Meteo renvoie en fait un *tableau*
  // au top-level → on gère les deux dans `parseResponse`.
}

/**
 * Modèles consultés, par ordre de préférence. AROME France est très précis
 * mais maintient mal le manteau neigeux (forecast courte portée) → on le garde
 * en premier mais on fallback sur ECMWF IFS (analyse globale du manteau) puis
 * `best_match` qui utilise ARPEGE/ICON selon la zone.
 */
const SNOW_MODELS = [
  'meteofrance_arome_france',
  'ecmwf_ifs025',
  'best_match',
] as const;

type SnowModel = (typeof SNOW_MODELS)[number];

const MODEL_SOURCE: Record<SnowModel, AromeSnowGrid['source']> = {
  meteofrance_arome_france: 'open-meteo-arome',
  ecmwf_ifs025: 'open-meteo-ecmwf',
  best_match: 'open-meteo-best-match',
};

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

function modelFieldKey(model: SnowModel): string {
  return model === 'best_match' ? 'snow_depth' : `snow_depth_${model}`;
}

function readModelSnowDepth(
  hourly: OpenMeteoForecastResponse['hourly'] | undefined,
  model: SnowModel,
): (number | null)[] | null {
  const key = modelFieldKey(model);
  const values = hourly?.[key];
  return Array.isArray(values) ? (values as (number | null)[]) : null;
}

function chooseSnapshot(
  list: OpenMeteoForecastResponse[],
  times: string[],
): {
  model: SnowModel;
  hourIdx: number;
  source: AromeSnowGrid['source'];
  stats: { nonZero: number; meanCm: number; maxCm: number };
} {
  let best: {
    model: SnowModel;
    hourIdx: number;
    source: AromeSnowGrid['source'];
    stats: { nonZero: number; meanCm: number; maxCm: number };
    rank: number;
  } | null = null;

  for (const model of SNOW_MODELS) {
    const firstSeries = readModelSnowDepth(list[0]?.hourly, model);
    if (!firstSeries || firstSeries.length !== times.length) continue;

    for (let hourIdx = 0; hourIdx < times.length; hourIdx++) {
      let nonZero = 0;
      let sumCm = 0;
      let maxCm = 0;

      for (const point of list) {
        const series = readModelSnowDepth(point.hourly, model);
        const meters = series?.[hourIdx];
        if (typeof meters !== 'number' || !Number.isFinite(meters) || meters <= 0) {
          continue;
        }
        const cm = meters * 100;
        nonZero++;
        sumCm += cm;
        if (cm > maxCm) maxCm = cm;
      }

      const meanCm = nonZero > 0 ? sumCm / nonZero : 0;
      const isEarliestPositive = nonZero > 0 ? 1 : 0;
      const rank =
        isEarliestPositive * 1_000_000 +
        (times.length - hourIdx) * 10_000 +
        Math.round(meanCm * 10) * 10 +
        Math.round(maxCm);

      if (!best || rank > best.rank) {
        best = {
          model,
          hourIdx,
          source: MODEL_SOURCE[model],
          stats: { nonZero, meanCm, maxCm },
          rank,
        };
      }
    }
  }

  if (!best) {
    throw new Error('AROME response missing usable snow_depth series');
  }

  return best;
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
  // On demande plusieurs modèles : si AROME donne 0 (typique fin saison sur
  // forecast court), on fallback sur ECMWF puis best_match.
  const url =
    `/api/openmeteo/v1/forecast` +
    `?latitude=${lats.join(',')}` +
    `&longitude=${lons.join(',')}` +
    `&hourly=snow_depth` +
    `&models=${SNOW_MODELS.join(',')}` +
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

  // RedView v0.1 lit la première échéance exploitable du run sur le champ
  // `SNOW_DEPTH__GROUND_OR_WATER_SURFACE__`. Open-Meteo ne donne pas le run
  // WCS ni le step 0 explicitement, donc on choisit le snapshot le plus proche
  // de ce comportement: premier instant avec un manteau non nul sur la grille,
  // modèle par modèle, avec fallback vers le snapshot le plus crédible.
  const firstHourly = list[0]?.hourly;
  if (!firstHourly?.time) {
    throw new Error('AROME response missing hourly.time');
  }
  const selected = chooseSnapshot(list, firstHourly.time);
  const { model, hourIdx } = selected;

  // Extraire snow_depth (m) → cm. row-major sud→nord, comme v0.1.
  const data = new Float32Array(nx * ny);
  for (let j = 0; j < ny; j++) {
    for (let i = 0; i < nx; i++) {
      const flatIdx = j * nx + i;
      const point = list[flatIdx];
      const m = readModelSnowDepth(point?.hourly, model)?.[hourIdx];
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
    `mean=${meanCm.toFixed(1)}cm, max=${maxCm.toFixed(1)}cm, ` +
    `hour=${firstHourly.time[hourIdx]}, model=${model}, source=${selected.source}`,
  );

  return {
    width: nx,
    height: ny,
    snowDepthCm: data,
    boundsMeters: [mxMin, myMin, mxMax, myMax],
    resolutionM: AROME_RES_DEG * 111_000, // ≈ 2750m
    timestamp: firstHourly.time[hourIdx] + 'Z',
    runHour: firstHourly.time[hourIdx].slice(11, 13),
    source: selected.source,
  };
}
