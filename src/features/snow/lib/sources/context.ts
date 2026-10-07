// ============================================================================
// Snow sources — measurements, avalanche bulletin and weather history
// (/api/snow-context, see api/snow-context.ts)
// ============================================================================

import type { BraSnowProfile, LonLat, SnowObservation, WeatherHistory } from '../engine/types';

interface ContextStation {
  id: string;
  source: string;
  name: string;
  lon: number;
  lat: number;
  elevationM: number;
  hsCm: number;
  time: string;
}

interface ContextResponse {
  stations: ContextStation[];
  rejectedStations: number;
  bra: BraSnowProfile | null;
  weather: {
    startMs: number;
    elevationM: number;
    temperatureC: number[];
    precipitationMm: number[];
    snowfallCm: number[];
    windSpeedMs: number[];
    windDirDeg: number[];
  } | null;
  sources: Record<string, string>;
}

export interface SnowContext {
  observations: SnowObservation[];
  rejectedStations: number;
  bra: BraSnowProfile | null;
  weather: WeatherHistory | null;
  sources: Record<string, string>;
}

export async function fetchSnowContext(
  center: LonLat,
  sceneAltitudeM: number,
  signal?: AbortSignal,
): Promise<SnowContext> {
  const q = new URLSearchParams({
    lat: center.lat.toFixed(5),
    lon: center.lon.toFixed(5),
    elevation: String(Math.round(sceneAltitudeM)),
    radiusKm: '50',
    pastDays: '60',
  });
  const res = await fetch(`/api/snow-context?${q.toString()}`, { signal });
  if (!res.ok) throw new Error(`snow-context HTTP ${res.status}`);
  const json = (await res.json()) as ContextResponse;
  const w = json.weather;
  return {
    observations: json.stations.map((s) => ({
      id: s.id,
      source: s.source,
      name: s.name,
      lon: s.lon,
      lat: s.lat,
      elevationM: s.elevationM,
      hsCm: s.hsCm,
      time: s.time,
      kind: 'flat' as const,
    })),
    rejectedStations: json.rejectedStations,
    bra: json.bra,
    weather: w
      ? {
        startMs: w.startMs,
        elevationM: w.elevationM,
        temperatureC: Float32Array.from(w.temperatureC),
        precipitationMm: Float32Array.from(w.precipitationMm),
        snowfallCm: Float32Array.from(w.snowfallCm),
        windSpeedMs: Float32Array.from(w.windSpeedMs),
        windDirDeg: Float32Array.from(w.windDirDeg),
      }
      : null,
    sources: json.sources,
  };
}
