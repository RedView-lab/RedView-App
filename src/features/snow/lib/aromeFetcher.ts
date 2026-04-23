// ============================================================================
// AROME snow fetcher — Météo-France WCS via /api/meteofrance proxy
// ----------------------------------------------------------------------------
// Port direct du client AROME de RedView v0.1
// (crates/redview-io/src/remote/arome_client). Le parsing GRIB2 est fait
// côté serverless (Node + @mattnucc/gribberish), le browser ne reçoit qu'un
// JSON compact { width, height, valuesCm, lonMin/Max, latMin/Max, ... }.
//
// Pourquoi ce détour : Open-Meteo n'expose PAS `snow_depth` pour AROME (ils
// publient seulement `snowfall` 1h). On revient donc sur l'API officielle
// Météo-France WCS, identique à v0.1 :
//   coverage = SNOW_DEPTH__GROUND_OR_WATER_SURFACE___<run>
//   premier pas de temps (analyse) → champ profondeur en mètres
// ============================================================================

import proj4 from 'proj4';
import type { AromeSnowGrid, SnowHeightmap } from '../types';

proj4.defs(
  'EPSG:2154',
  '+proj=lcc +lat_0=46.5 +lon_0=3 +lat_1=49 +lat_2=44 +x_0=700000 +y_0=6600000 +ellps=GRS80 +towgs84=0,0,0,0,0,0,0 +units=m +no_defs +type=crs',
);
proj4.defs(
  'EPSG:2975',
  '+proj=utm +zone=40 +south +ellps=GRS80 +towgs84=0,0,0,0,0,0,0 +units=m +no_defs +type=crs',
);

/** AROME native resolution (≈1.3 km). */
const AROME_RES_DEG = 0.01;

/** Minimum margin around LiDAR bbox so we always get ≥5×5 cells. */
const MIN_MARGIN_DEG = 0.05;

interface MeteoFranceResponse {
  width: number;
  height: number;
  valuesCm: number[];
  lonMin: number;
  latMin: number;
  lonMax: number;
  latMax: number;
  coverageId: string;
  runHour: string;
  timestamp: string;
  unitToCm: number;
  units: string;
  varAbbrev: string;
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

/** Récupère la grille AROME snow_depth pour la zone LiDAR. */
export async function fetchAromeSnowGrid(
  heightmap: SnowHeightmap,
  signal?: AbortSignal,
): Promise<AromeSnowGrid> {
  const wgs = bboxToWgs84(heightmap.bounds, heightmap.crs);

  // Marge identique à v0.1 (max 30% de la bbox, plancher 0.05°),
  // garantit ≥5×5 cellules AROME pour la régression terrain.
  const rangeLon = wgs.lonMax - wgs.lonMin;
  const rangeLat = wgs.latMax - wgs.latMin;
  let marginLon = Math.max(MIN_MARGIN_DEG, rangeLon * 0.3);
  let marginLat = Math.max(MIN_MARGIN_DEG, rangeLat * 0.3);
  if (rangeLon + 2 * marginLon < 5 * AROME_RES_DEG) {
    marginLon = (5 * AROME_RES_DEG - rangeLon) / 2 + AROME_RES_DEG;
  }
  if (rangeLat + 2 * marginLat < 5 * AROME_RES_DEG) {
    marginLat = (5 * AROME_RES_DEG - rangeLat) / 2 + AROME_RES_DEG;
  }

  const lonMin = wgs.lonMin - marginLon;
  const lonMax = wgs.lonMax + marginLon;
  const latMin = wgs.latMin - marginLat;
  const latMax = wgs.latMax + marginLat;

  const url =
    `/api/meteofrance` +
    `?lonMin=${lonMin.toFixed(4)}` +
    `&latMin=${latMin.toFixed(4)}` +
    `&lonMax=${lonMax.toFixed(4)}` +
    `&latMax=${latMax.toFixed(4)}`;

  const res = await fetch(url, { signal });
  if (!res.ok) {
    let detail = '';
    try {
      const j = await res.json();
      detail = j?.detail ?? j?.error ?? '';
    } catch {
      detail = res.statusText;
    }
    throw new Error(`Météo-France fetch failed: HTTP ${res.status} ${detail}`);
  }

  const json = (await res.json()) as MeteoFranceResponse;
  const { width, height, valuesCm } = json;

  if (!width || !height || valuesCm.length !== width * height) {
    throw new Error(
      `AROME response invalid: width=${width} height=${height} ` +
        `values=${valuesCm.length}`,
    );
  }

  // Reconvertir la bbox AROME (WGS84) → CRS de la heightmap
  const proj = projDef(heightmap.crs);
  const corners: [number, number][] = [
    [json.lonMin, json.latMin],
    [json.lonMax, json.latMin],
    [json.lonMax, json.latMax],
    [json.lonMin, json.latMax],
  ];
  let mxMin = Infinity, mxMax = -Infinity, myMin = Infinity, myMax = -Infinity;
  for (const [lon, lat] of corners) {
    const [x, y] = proj4('EPSG:4326', proj, [lon, lat]) as [number, number];
    if (x < mxMin) mxMin = x;
    if (x > mxMax) mxMax = x;
    if (y < myMin) myMin = y;
    if (y > myMax) myMax = y;
  }

  const data = Float32Array.from(valuesCm);

  // Stats debug
  let nonZero = 0, sum = 0, max = 0;
  for (let k = 0; k < data.length; k++) {
    const v = data[k];
    if (v > 0) {
      nonZero++;
      sum += v;
      if (v > max) max = v;
    }
  }
  const mean = nonZero > 0 ? sum / nonZero : 0;
  console.log(
    `[snow/arome] grid ${width}×${height}, ${nonZero}/${data.length} non-zero, ` +
      `mean=${mean.toFixed(1)}cm, max=${max.toFixed(1)}cm, ` +
      `coverage=${json.coverageId} run=${json.runHour}h ` +
      `var=${json.varAbbrev} units=${json.units} factor=${json.unitToCm}`,
  );

  // Résolution moyenne en mètres (WGS84 → ~111km/°, corrigé latitude)
  const midLat = (json.latMin + json.latMax) / 2;
  const dxDeg = width > 1 ? (json.lonMax - json.lonMin) / (width - 1) : AROME_RES_DEG;
  const dyDeg = height > 1 ? (json.latMax - json.latMin) / (height - 1) : AROME_RES_DEG;
  const dxM = dxDeg * 111_000 * Math.cos((midLat * Math.PI) / 180);
  const dyM = dyDeg * 111_000;
  const resolutionM = (dxM + dyM) / 2;

  return {
    width,
    height,
    snowDepthCm: data,
    boundsMeters: [mxMin, myMin, mxMax, myMax],
    resolutionM,
    timestamp: json.timestamp,
    runHour: json.runHour,
    // type union historique — la vraie source est désormais meteofrance-wcs
    source: 'open-meteo-arome',
  };
}
