// ============================================================================
// Real-terrain scene for the before/after image: Aiguilles Rouges (Chamonix),
// 3 km around Lac Blanc, IGN LiDAR HD DTM. The snow inputs are a plausible
// mid-winter situation, not measurements (there is no snow on 4 October):
//   - "AROME" cells hold a Chamonix-north mid-February profile (snow line
//     ~900 m, 95 cm at 1500 m, 215 cm at 2500 m), read at the model orography
//     (mean RGE ALTI over each 0.01° cell), 20 % low — AROME's usual kind of
//     bias that only measurements can reveal;
//   - flat-field stations at the real positions of the Météo-France and
//     Nivôse posts around (values from the same profile + 4 cm noise);
//   - NW storms, then a sunny week (drift and melt by exposure).
// ============================================================================

import proj4 from 'proj4';
import { DEFAULT_SNOW_ENGINE_CONFIG } from '../../src/features/snow/lib/engine/config';
import type { CoarseSnowGrid, FarDem, SnowEngineInput, SnowObservation, WeatherHistory } from '../../src/features/snow/lib/engine/types';
import { fetchIgnDem, fetchIgnDemWgs84, sampleWgs84 } from './ignDem';
import { Rng } from './noise';

proj4.defs('EPSG:2154', '+proj=lcc +lat_0=46.5 +lon_0=3 +lat_1=49 +lat_2=44 +x_0=700000 +y_0=6600000 +ellps=GRS80 +towgs84=0,0,0,0,0,0,0 +units=m +no_defs');

const CENTER_X = 1_000_500;
const CENTER_Y = 6_550_500;
const SIZE_M = 3000;
const N = 640;

/** Mid-February snow depth on open flat ground, Chamonix north side, cm. */
export function chamonixProfile(z: number): number {
  if (z <= 900) return 0;
  if (z <= 1500) return (95 * (z - 900)) / 600;
  if (z <= 2500) return 95 + (120 * (z - 1500)) / 1000;
  return 215 + (6 * (z - 2500)) / 100;
}

const STATIONS: Array<[string, string, number, number, number]> = [
  ['mf:74056405', 'AIGUILLES ROUGES-NIVOSE', 45.986333, 6.896833, 2365],
  ['mf:74056417', 'LA FLEGERE', 45.9625, 6.889167, 1850],
  ['mf:74056416', 'Lognan', 45.968333, 6.942833, 1970],
  ['mf:74056418', 'LE TOUR BALME', 46.020833, 6.970833, 2196],
  ['mf:74056005', 'LE TOUR', 46.003833, 6.9485, 1500],
  ['mf:74290003', 'VALLORCINE', 46.020333, 6.919167, 1326],
  ['mf:74056001', 'CHAMONIX', 45.9295, 6.8775, 1042],
  ['mf:74056421', 'COUVERCLE-NIVOSE', 45.909667, 6.958833, 2758],
];

export interface RealScene {
  input: SnowEngineInput;
  z: Float32Array;
  n: number;
  cell: number;
  legacy: { aromeData: Float32Array; aromeW: number; aromeH: number; aromeBounds: [number, number, number, number] };
  label: string;
}

function weather(analysisMs: number, rng: Rng): WeatherHistory {
  const hours = 60 * 24;
  const startMs = analysisMs - (hours - 1) * 3_600_000;
  const t = new Float32Array(hours), p = new Float32Array(hours), sf = new Float32Array(hours), u = new Float32Array(hours), d = new Float32Array(hours);
  const storms = [[50, 36], [36, 30], [22, 44], [12, 24]];
  for (let h = 0; h < hours; h++) {
    const daysAgo = (hours - 1 - h) / 24;
    const hourUtc = new Date(startMs + h * 3_600_000).getUTCHours();
    const sunnyEnd = daysAgo < 8;
    t[h] = (sunnyEnd ? -1 : -5) + 0.08 * (60 - daysAgo) * 0.3 + 4.5 * Math.cos((2 * Math.PI * (hourUtc - 13)) / 24);
    u[h] = 3 + 2 * rng.next();
    d[h] = 180 + 120 * rng.next();
  }
  for (const [ago, len] of storms) {
    const h0 = hours - 1 - ago * 24;
    for (let k = 0; k < len + 12; k++) {
      const h = h0 + k;
      if (h < 0 || h >= hours) continue;
      if (k < len) { p[h] = 2 + rng.next(); sf[h] = p[h]; t[h] -= 3; }
      u[h] = 14 + 5 * rng.next();
      d[h] = 305 + 20 * rng.normal();
    }
  }
  return { startMs, elevationM: 2000, temperatureC: t, precipitationMm: p, snowfallCm: sf, windSpeedMs: u, windDirDeg: d };
}

export async function buildRealScene(cacheDir: string): Promise<RealScene> {
  const rng = new Rng(2026);
  const minX = CENTER_X - SIZE_M / 2, minY = CENTER_Y - SIZE_M / 2;
  const maxX = CENTER_X + SIZE_M / 2, maxY = CENTER_Y + SIZE_M / 2;
  const dem = await fetchIgnDem(minX, minY, maxX, maxY, N, cacheDir);
  const toLL = (x: number, y: number) => {
    const [lon, lat] = proj4('EPSG:2154', 'EPSG:4326', [x, y]) as [number, number];
    return { lon, lat };
  };
  const corners: SnowEngineInput['geo']['corners'] = [toLL(minX, minY), toLL(maxX, minY), toLL(maxX, maxY), toLL(minX, maxY)];
  const c0 = toLL(CENTER_X, CENTER_Y);
  const c1 = toLL(CENTER_X, CENTER_Y + 1000);
  const gridNorthBearingDeg = (Math.atan2((c1.lon - c0.lon) * Math.cos((c0.lat * Math.PI) / 180), c1.lat - c0.lat) * 180) / Math.PI;

  // Coarse cells and the wide DEM for the model orography and the far field.
  const lonMin = Math.round((c0.lon - 0.4) * 100) / 100;
  const latMin = Math.round((c0.lat - 0.3) * 100) / 100;
  const aw = 81, ah = 61;
  const wide = await fetchIgnDemWgs84(lonMin - 0.02, latMin - 0.02, lonMin + 0.82, latMin + 0.62, 600, 450, cacheDir);
  const oro = new Float32Array(aw * ah);
  const hs = new Float32Array(aw * ah);
  for (let j = 0; j < ah; j++) {
    for (let i = 0; i < aw; i++) {
      const lon = lonMin + i * 0.01, lat = latMin + j * 0.01;
      let s = 0;
      for (let b = -2; b <= 2; b++) for (let a = -2; a <= 2; a++) s += sampleWgs84(wide, lon + a * 0.00375, lat + b * 0.00375);
      const z = s / 25;
      oro[j * aw + i] = z;
      const anomaly = 1 + 0.08 * Math.sin(lon * 37) * Math.cos(lat * 29);
      hs[j * aw + i] = 0.8 * chamonixProfile(z) * anomaly;
    }
  }
  const coarse: CoarseSnowGrid = { source: 'arome', width: aw, height: ah, lonMin, latMin, dLon: 0.01, dLat: 0.01, hsCm: hs, orographyM: oro, resolutionM: 1100 };

  // Far field ±7 km at 50 m, scene-local metres.
  const margin = 7000, fcell = 50;
  const fw = Math.round((SIZE_M + 2 * margin) / fcell) + 1;
  const farData = new Float32Array(fw * fw);
  for (let j = 0; j < fw; j++) {
    for (let i = 0; i < fw; i++) {
      const p = toLL(minX - margin + i * fcell, minY - margin + j * fcell);
      farData[j * fw + i] = sampleWgs84(wide, p.lon, p.lat);
    }
  }
  const farDem: FarDem = { data: farData, width: fw, height: fw, originX: -margin, originY: -margin, cell: fcell };

  const observations: SnowObservation[] = STATIONS.map(([id, name, lat, lon, z]) => ({
    id, source: 'meteofrance', name, lon, lat, elevationM: z,
    hsCm: Math.max(0, Math.round(chamonixProfile(z) + 4 * rng.normal())), kind: 'flat',
  }));

  const analysisTimeMs = Date.parse('2026-03-05T06:00:00Z');
  const input: SnowEngineInput = {
    dem: { data: dem.data, width: N, height: N, sizeX: SIZE_M, sizeY: SIZE_M },
    geo: { corners, gridNorthBearingDeg },
    coarse,
    farDem,
    canopy: null,
    observations,
    bra: null,
    weather: weather(analysisTimeMs, rng),
    analysisTimeMs,
    config: { ...DEFAULT_SNOW_ENGINE_CONFIG, maxResolution: N },
  };

  // v1 took the AROME bbox as an axis-aligned box in the scene CRS.
  const envPts = [[lonMin, latMin], [lonMin + (aw - 1) * 0.01, latMin], [lonMin + (aw - 1) * 0.01, latMin + (ah - 1) * 0.01], [lonMin, latMin + (ah - 1) * 0.01]]
    .map(([lo, la]) => proj4('EPSG:4326', 'EPSG:2154', [lo, la]) as [number, number]);
  const env: [number, number, number, number] = [
    Math.min(...envPts.map((p) => p[0])) - minX,
    Math.min(...envPts.map((p) => p[1])) - minY,
    Math.max(...envPts.map((p) => p[0])) - minX,
    Math.max(...envPts.map((p) => p[1])) - minY,
  ];

  return {
    input,
    z: dem.data,
    n: N,
    cell: SIZE_M / (N - 1),
    legacy: { aromeData: hs, aromeW: aw, aromeH: ah, aromeBounds: env },
    label: 'Aiguilles Rouges — Lac Blanc (Chamonix), 3 × 3 km, MNT LiDAR HD IGN',
  };
}
