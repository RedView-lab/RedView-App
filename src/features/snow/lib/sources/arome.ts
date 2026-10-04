// ============================================================================
// Snow sources — AROME snow depth (Météo-France WCS via /api/meteofrance)
// ----------------------------------------------------------------------------
// The analysis time step of the latest AROME 0.01° run, over a window of
// ±0.4° × ±0.3° around the scene: enough cells (≈ 60 × 60) to learn the local
// snow–elevation profile and to read the background at the stations.
// The GRIB2 is decoded server-side (api/meteofrance.ts).
// ============================================================================

import type { CoarseSnowGrid, LonLat } from '../engine/types';

const HALF_LON_DEG = 0.4;
const HALF_LAT_DEG = 0.3;

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
}

export interface AromeGrid {
  grid: CoarseSnowGrid;
  timestamp: string;
  runHour: string;
}

export async function fetchAromeSnow(center: LonLat, signal?: AbortSignal): Promise<AromeGrid> {
  const url =
    `/api/meteofrance` +
    `?lonMin=${(center.lon - HALF_LON_DEG).toFixed(4)}` +
    `&latMin=${(center.lat - HALF_LAT_DEG).toFixed(4)}` +
    `&lonMax=${(center.lon + HALF_LON_DEG).toFixed(4)}` +
    `&latMax=${(center.lat + HALF_LAT_DEG).toFixed(4)}`;
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
    throw new Error(`AROME response invalid: ${width}×${height}, ${valuesCm.length} values`);
  }
  const dLon = width > 1 ? (json.lonMax - json.lonMin) / (width - 1) : 0.01;
  const dLat = height > 1 ? (json.latMax - json.latMin) / (height - 1) : 0.01;
  const midLat = (json.latMin + json.latMax) / 2;
  const resolutionM = ((dLon * 111_320 * Math.cos((midLat * Math.PI) / 180)) + dLat * 110_540) / 2;
  return {
    grid: {
      source: 'arome',
      width,
      height,
      lonMin: json.lonMin,
      latMin: json.latMin,
      dLon,
      dLat,
      hsCm: Float32Array.from(valuesCm),
      orographyM: null,
      resolutionM,
    },
    timestamp: json.timestamp,
    runHour: json.runHour,
  };
}
