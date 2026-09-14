import { OPENMETEO_FORECAST_URL } from './openMeteoConfig';
import {
  formatLocalDateIso,
  parseLocalDateIso,
  timeToMinutes,
} from './forecastTime';
import type { ChartMetricId, RouteChartPoint } from '@/features/centerPanel/components/chart/seriesCommon';
import { buildRouteContentSignature } from '@/features/itineraryPanel/lib/routes';

// ── Types ─────────────────────────────────────────────────────────────

export interface RouteWeatherHourly {
  time: string[];
  timeMs?: number[];
  temperature_2m: number[];
  apparent_temperature: number[];
  precipitation: number[];
  wind_speed_10m: number[];
  cloud_cover: number[];
  relative_humidity_2m: number[];
  sunshine_duration: number[]; // in minutes (0..60)
}

export interface RouteWeatherSample {
  lat: number;
  lng: number;
  distanceM: number;
  elevationM: number;
  hourly: RouteWeatherHourly;
}

export interface RouteWeatherDataset {
  itineraryId: string;
  signature: string;
  startDate: string; // YYYY-MM-DD
  startTime: string; // HH:mm
  departureTimestampMs?: number;
  samples: RouteWeatherSample[];
  fetchedAt: number;
}

export interface RouteWeatherValues {
  temperature: number;
  feelsLike: number;
  rain: number;
  windKmh: number;
  cloudCover: number;
  humidity: number;
  sunshineMin: number;
}

// ── Cache & In-Flight Management ─────────────────────────────────────

const CACHE_TTL_MS = 30 * 60 * 1000; // 30 minutes
const weatherCache = new Map<string, RouteWeatherDataset>();
const inFlightRequests = new Map<string, Promise<RouteWeatherDataset | null>>();

function makeCacheKey(signature: string, startDate: string, startTimeHour: string): string {
  return `${signature}|${startDate}|${startTimeHour}`;
}

export function clearRouteWeatherCache(): void {
  weatherCache.clear();
  inFlightRequests.clear();
}

// ── Échantillonnage spatial de la trace ───────────────────────────────

export function sampleRouteForWeather(
  points: RouteChartPoint[] | null | undefined,
): Array<{ lat: number; lng: number; distanceM: number; elevationM: number }> {
  if (!points || points.length === 0) return [];
  if (points.length <= 3) {
    return points.map((pt, idx) => ({
      lat: pt.lat,
      lng: pt.lon,
      distanceM: pt.distanceM ?? idx * 1000,
      elevationM: pt.elevationM ?? 0,
    }));
  }

  const totalDistanceM = points[points.length - 1]?.distanceM ?? 0;
  let targetSamplesCount: number;

  if (totalDistanceM <= 5_000) {
    targetSamplesCount = 3;
  } else if (totalDistanceM <= 25_000) {
    targetSamplesCount = Math.max(4, Math.min(8, Math.round(totalDistanceM / 3_500)));
  } else if (totalDistanceM <= 80_000) {
    targetSamplesCount = Math.max(8, Math.min(16, Math.round(totalDistanceM / 5_000)));
  } else {
    targetSamplesCount = Math.max(16, Math.min(26, Math.round(totalDistanceM / 7_000)));
  }

  const result: Array<{ lat: number; lng: number; distanceM: number; elevationM: number }> = [];
  const stepM = totalDistanceM / (targetSamplesCount - 1);

  let pointIdx = 0;
  for (let i = 0; i < targetSamplesCount; i++) {
    const targetDistanceM = i === targetSamplesCount - 1 ? totalDistanceM : i * stepM;
    while (pointIdx < points.length - 1 && (points[pointIdx + 1]?.distanceM ?? 0) < targetDistanceM) {
      pointIdx++;
    }
    const pt = points[pointIdx]!;
    result.push({
      lat: pt.lat,
      lng: pt.lon,
      distanceM: pt.distanceM ?? targetDistanceM,
      elevationM: pt.elevationM ?? 0,
    });
  }

  return result;
}

// ── Requête Open-Meteo Multi-Points ───────────────────────────────────

interface RawOpenMeteoForecastItem {
  latitude: number | number[];
  longitude: number | number[];
  elevation?: number;
  hourly?: {
    time?: string[];
    temperature_2m?: Array<number | null>;
    apparent_temperature?: Array<number | null>;
    precipitation?: Array<number | null>;
    wind_speed_10m?: Array<number | null>;
    cloud_cover?: Array<number | null>;
    relative_humidity_2m?: Array<number | null>;
    sunshine_duration?: Array<number | null>;
  };
}

export async function fetchRouteWeatherDataset(
  itineraryId: string,
  routePoints: RouteChartPoint[],
  startDate: string,
  startTime: string,
  signal?: AbortSignal,
): Promise<RouteWeatherDataset | null> {
  if (!routePoints || routePoints.length === 0) return null;

  const sampledStations = sampleRouteForWeather(routePoints);
  if (sampledStations.length === 0) return null;

  const signature = buildRouteContentSignature(routePoints);
  const hourPrefix = startTime ? startTime.slice(0, 2) : '12';
  const cacheKey = makeCacheKey(signature, startDate, hourPrefix);

  const cached = weatherCache.get(cacheKey);
  if (cached && Date.now() - cached.fetchedAt < CACHE_TTL_MS) {
    return cached;
  }

  const inFlight = inFlightRequests.get(cacheKey);
  if (inFlight) return inFlight;

  const promise = (async () => {
    try {
      const lats = sampledStations.map((s) => s.lat.toFixed(4)).join(',');
      const lngs = sampledStations.map((s) => s.lng.toFixed(4)).join(',');

      // Calcul de la plage de jours (ex: départ + 1 jour de marge pour longues courses)
      const parsedStart = parseLocalDateIso(startDate) ?? new Date();
      const nextDay = new Date(parsedStart.getTime() + 24 * 3600 * 1000);
      const endDateIso = formatLocalDateIso(nextDay);

      const url =
        `${OPENMETEO_FORECAST_URL}?latitude=${lats}&longitude=${lngs}` +
        `&hourly=temperature_2m,apparent_temperature,precipitation,wind_speed_10m,cloud_cover,relative_humidity_2m,sunshine_duration` +
        `&start_date=${startDate}&end_date=${endDateIso}` +
        `&timezone=Europe%2FParis&temperature_unit=celsius&precipitation_unit=mm&wind_speed_unit=kmh&cell_selection=nearest`;

      const response = await fetch(url, {
        signal,
        headers: { Accept: 'application/json' },
      });

      if (!response.ok) {
        throw new Error(`Open-Meteo HTTP ${response.status}: ${response.statusText}`);
      }

      const rawJson = (await response.json()) as RawOpenMeteoForecastItem | RawOpenMeteoForecastItem[];
      const items: RawOpenMeteoForecastItem[] = Array.isArray(rawJson) ? rawJson : [rawJson];

      const samples: RouteWeatherSample[] = [];

      for (let i = 0; i < sampledStations.length; i++) {
        const station = sampledStations[i]!;
        const rawItem = items[i] ?? items[0];
        const hourly = rawItem?.hourly;

        if (!hourly || !hourly.time || hourly.time.length === 0) {
          continue;
        }

        const count = hourly.time.length;
        const tempArr = new Array<number>(count);
        const feelsArr = new Array<number>(count);
        const precipArr = new Array<number>(count);
        const windArr = new Array<number>(count);
        const cloudArr = new Array<number>(count);
        const humidityArr = new Array<number>(count);
        const sunshineArr = new Array<number>(count);

        for (let t = 0; t < count; t++) {
          const rawTemp = hourly.temperature_2m?.[t];
          const temp = Number.isFinite(rawTemp) ? (rawTemp as number) : 15;
          tempArr[t] = temp;

          const rawFeels = hourly.apparent_temperature?.[t];
          feelsArr[t] = Number.isFinite(rawFeels) ? (rawFeels as number) : temp;

          const rawPrecip = hourly.precipitation?.[t];
          precipArr[t] = Number.isFinite(rawPrecip) ? Math.max(0, rawPrecip as number) : 0;

          const rawWind = hourly.wind_speed_10m?.[t];
          windArr[t] = Number.isFinite(rawWind) ? Math.max(0, rawWind as number) : 5;

          const rawCloud = hourly.cloud_cover?.[t];
          const cloud = Number.isFinite(rawCloud) ? Math.max(0, Math.min(100, rawCloud as number)) : 20;
          cloudArr[t] = cloud;

          const rawHumidity = hourly.relative_humidity_2m?.[t];
          humidityArr[t] = Number.isFinite(rawHumidity) ? Math.max(0, Math.min(100, rawHumidity as number)) : 60;

          const rawSunshine = hourly.sunshine_duration?.[t];
          if (Number.isFinite(rawSunshine)) {
            // Open-Meteo sunshine_duration is in seconds (0..3600), convert to minutes (0..60)
            sunshineArr[t] = Math.max(0, Math.min(60, Math.round((rawSunshine as number) / 60)));
          } else {
            // Fallback: inverse of cloud cover
            sunshineArr[t] = Math.max(0, Math.min(60, Math.round((1 - cloud / 100) * 60)));
          }
        }

        samples.push({
          lat: station.lat,
          lng: station.lng,
          distanceM: station.distanceM,
          elevationM: station.elevationM,
          hourly: {
            time: hourly.time,
            timeMs: hourly.time.map((t) => parseHourTimeMs(t)),
            temperature_2m: tempArr,
            apparent_temperature: feelsArr,
            precipitation: precipArr,
            wind_speed_10m: windArr,
            cloud_cover: cloudArr,
            relative_humidity_2m: humidityArr,
            sunshine_duration: sunshineArr,
          },
        });
      }

      if (samples.length === 0) return null;

      const startDateObj = parseLocalDateIso(startDate) ?? new Date();
      const startMinutes = timeToMinutes(startTime || '12:00');
      const departureTimestampMs = startDateObj.getTime() + startMinutes * 60 * 1000;

      const dataset: RouteWeatherDataset = {
        itineraryId,
        signature,
        startDate,
        startTime,
        departureTimestampMs,
        samples,
        fetchedAt: Date.now(),
      };

      weatherCache.set(cacheKey, dataset);
      return dataset;
    } catch (err) {
      if (err instanceof DOMException && err.name === 'AbortError') {
        return null;
      }
      console.warn('[routeWeather] Failed to fetch route weather forecast:', err);
      return null;
    } finally {
      inFlightRequests.delete(cacheKey);
    }
  })();

  inFlightRequests.set(cacheKey, promise);
  return promise;
}

// ── Interpolation Spatio-Temporelle ──────────────────────────────────

function lerp(a: number, b: number, t: number): number {
  return a + (b - a) * Math.max(0, Math.min(1, t));
}

function parseHourTimeMs(timeIso: string): number {
  const parsed = new Date(timeIso);
  return parsed.getTime();
}

export function getRouteWeatherAtDistanceAndTime(
  dataset: RouteWeatherDataset,
  distanceM: number,
  elapsedSeconds: number,
  pointElevationM?: number | null,
): RouteWeatherValues | null {
  const samples = dataset.samples;
  if (samples.length === 0) return null;

  // 1. Détermination du timestamp cible (utilisant le cache précalculé ou lazy-cache)
  if (dataset.departureTimestampMs === undefined) {
    dataset.departureTimestampMs = (
      (parseLocalDateIso(dataset.startDate) ?? new Date()).getTime() +
      timeToMinutes(dataset.startTime || '12:00') * 60 * 1000
    );
  }
  const departureTimestampMs = dataset.departureTimestampMs;
  const targetTimestampMs = departureTimestampMs + elapsedSeconds * 1000;

  // 2. Encadrement spatial entre 2 stations météo (recherche dichotomique)
  let s0 = samples[0]!;
  let s1 = samples[samples.length - 1]!;
  let spatialFraction = 0;

  if (distanceM <= samples[0]!.distanceM) {
    s0 = samples[0]!;
    s1 = samples[0]!;
    spatialFraction = 0;
  } else if (distanceM >= samples[samples.length - 1]!.distanceM) {
    s0 = samples[samples.length - 1]!;
    s1 = samples[samples.length - 1]!;
    spatialFraction = 0;
  } else {
    let lo = 0;
    let hi = samples.length - 1;
    while (lo <= hi) {
      const mid = (lo + hi) >> 1;
      if (samples[mid]!.distanceM <= distanceM) {
        lo = mid + 1;
      } else {
        hi = mid - 1;
      }
    }
    const idx = Math.max(0, Math.min(samples.length - 2, hi));
    s0 = samples[idx]!;
    s1 = samples[idx + 1]!;
    const span = s1.distanceM - s0.distanceM;
    spatialFraction = span > 0 ? (distanceM - s0.distanceM) / span : 0;
  }

  // 3. Interpolation temporelle pour une station donnée
  function interpolateStationAtTime(sample: RouteWeatherSample): RouteWeatherValues {
    const hourly = sample.hourly;
    const timeSlots = hourly.time;
    if (!hourly.timeMs && timeSlots && timeSlots.length > 0) {
      hourly.timeMs = timeSlots.map(parseHourTimeMs);
    }
    const timeMs = hourly.timeMs;
    const len = timeSlots.length;
    if (len === 0) {
      return {
        temperature: 15,
        feelsLike: 15,
        rain: 0,
        windKmh: 5,
        cloudCover: 0,
        humidity: 50,
        sunshineMin: 45,
      };
    }

    const firstTimeMs = timeMs ? timeMs[0]! : parseHourTimeMs(timeSlots[0]!);
    const lastTimeMs = timeMs ? timeMs[len - 1]! : parseHourTimeMs(timeSlots[len - 1]!);

    if (targetTimestampMs <= firstTimeMs) {
      return {
        temperature: hourly.temperature_2m[0]!,
        feelsLike: hourly.apparent_temperature[0]!,
        rain: hourly.precipitation[0]!,
        windKmh: hourly.wind_speed_10m[0]!,
        cloudCover: hourly.cloud_cover[0]!,
        humidity: hourly.relative_humidity_2m[0]!,
        sunshineMin: hourly.sunshine_duration[0]!,
      };
    }

    if (targetTimestampMs >= lastTimeMs) {
      const last = len - 1;
      return {
        temperature: hourly.temperature_2m[last]!,
        feelsLike: hourly.apparent_temperature[last]!,
        rain: hourly.precipitation[last]!,
        windKmh: hourly.wind_speed_10m[last]!,
        cloudCover: hourly.cloud_cover[last]!,
        humidity: hourly.relative_humidity_2m[last]!,
        sunshineMin: hourly.sunshine_duration[last]!,
      };
    }

    // Indexation uniforme rapide O(1) avec ajustement local
    const spanMs = lastTimeMs - firstTimeMs;
    let t0Idx = Math.max(0, Math.min(len - 2, Math.floor(((targetTimestampMs - firstTimeMs) / spanMs) * (len - 1))));
    let t0Ms = timeMs ? timeMs[t0Idx]! : parseHourTimeMs(timeSlots[t0Idx]!);
    let t1Ms = timeMs ? timeMs[t0Idx + 1]! : parseHourTimeMs(timeSlots[t0Idx + 1]!);

    while (t0Idx > 0 && targetTimestampMs < t0Ms) {
      t0Idx--;
      t0Ms = timeMs ? timeMs[t0Idx]! : parseHourTimeMs(timeSlots[t0Idx]!);
      t1Ms = timeMs ? timeMs[t0Idx + 1]! : parseHourTimeMs(timeSlots[t0Idx + 1]!);
    }
    while (t0Idx < len - 2 && targetTimestampMs > t1Ms) {
      t0Idx++;
      t0Ms = timeMs ? timeMs[t0Idx]! : parseHourTimeMs(timeSlots[t0Idx]!);
      t1Ms = timeMs ? timeMs[t0Idx + 1]! : parseHourTimeMs(timeSlots[t0Idx + 1]!);
    }
    const t1Idx = t0Idx + 1;
    const timeFraction = t1Ms > t0Ms ? (targetTimestampMs - t0Ms) / (t1Ms - t0Ms) : 0;

    return {
      temperature: lerp(hourly.temperature_2m[t0Idx]!, hourly.temperature_2m[t1Idx]!, timeFraction),
      feelsLike: lerp(hourly.apparent_temperature[t0Idx]!, hourly.apparent_temperature[t1Idx]!, timeFraction),
      rain: lerp(hourly.precipitation[t0Idx]!, hourly.precipitation[t1Idx]!, timeFraction),
      windKmh: lerp(hourly.wind_speed_10m[t0Idx]!, hourly.wind_speed_10m[t1Idx]!, timeFraction),
      cloudCover: lerp(hourly.cloud_cover[t0Idx]!, hourly.cloud_cover[t1Idx]!, timeFraction),
      humidity: lerp(hourly.relative_humidity_2m[t0Idx]!, hourly.relative_humidity_2m[t1Idx]!, timeFraction),
      sunshineMin: lerp(hourly.sunshine_duration[t0Idx]!, hourly.sunshine_duration[t1Idx]!, timeFraction),
    };
  }

  const v0 = interpolateStationAtTime(s0);
  const v1 = interpolateStationAtTime(s1);

  const rawTemp = lerp(v0.temperature, v1.temperature, spatialFraction);
  const rawFeels = lerp(v0.feelsLike, v1.feelsLike, spatialFraction);

  // Gradient adiabatique selon l'altitude de la trace : -6.5°C par 1 000 m
  const stationAvgEle = lerp(s0.elevationM, s1.elevationM, spatialFraction);
  let altitudeCorrection = 0;
  if (Number.isFinite(pointElevationM) && Number.isFinite(stationAvgEle)) {
    altitudeCorrection = ((pointElevationM as number) - stationAvgEle) * -0.0065;
  }

  return {
    temperature: rawTemp + altitudeCorrection,
    feelsLike: rawFeels + altitudeCorrection,
    rain: Math.max(0, lerp(v0.rain, v1.rain, spatialFraction)),
    windKmh: Math.max(0, lerp(v0.windKmh, v1.windKmh, spatialFraction)),
    cloudCover: Math.max(0, Math.min(100, lerp(v0.cloudCover, v1.cloudCover, spatialFraction))),
    humidity: Math.max(0, Math.min(100, lerp(v0.humidity, v1.humidity, spatialFraction))),
    sunshineMin: Math.max(0, Math.min(60, lerp(v0.sunshineMin, v1.sunshineMin, spatialFraction))),
  };
}

export function getRouteWeatherMetricValue(
  metric: ChartMetricId,
  weatherValues: RouteWeatherValues,
): number {
  switch (metric) {
    case 'Température':
      return weatherValues.temperature;
    case 'Température ressentie (°)':
      return weatherValues.feelsLike;
    case 'Pluie (mm)':
      return weatherValues.rain;
    case 'Vent (km/h)':
      return weatherValues.windKmh;
    case 'Couverture nuageuse (%)':
      return weatherValues.cloudCover;
    case 'Humidité (%)':
      return weatherValues.humidity;
    case 'Ensoleillement (min)':
      return weatherValues.sunshineMin;
    default:
      return 0;
  }
}

/**
 * Génère des valeurs météorologiques estimées physiquement réalistes (cycle diurne,
 * gradient adiabatique d'altitude -6.5°C/1000m, exposition au vent de crête, etc.)
 * pour un affichage réactif immédiat sur le graphique dès la sélection d'une métrique,
 * en attendant la résolution réseau d'Open-Meteo.
 */
export function generateEstimatedRouteWeatherValues(
  sample: { distanceM: number; elevationM: number },
  elapsedSeconds: number,
  startTime?: string | null,
): RouteWeatherValues {
  const elapsedHours = elapsedSeconds / 3600;
  const departureMinutes = timeToMinutes(startTime || '12:00');
  const departureHours = departureMinutes / 60;
  const currentHour = (departureHours + elapsedHours) % 24;

  // Cycle diurne thermique : maximum vers 14h, minimum vers 05h
  const diurnalAngle = ((currentHour - 14) / 24) * 2 * Math.PI;
  const diurnalTempDelta = Math.cos(diurnalAngle) * 4.5;

  // Gradient adiabatique selon l'altitude de la trace
  const altitudeM = Number.isFinite(sample.elevationM) ? (sample.elevationM as number) : 300;
  const altitudeLapse = -0.0065 * Math.max(0, altitudeM - 200);

  const baseTemp = 19.5;
  const temperature = Math.round((baseTemp + diurnalTempDelta + altitudeLapse) * 10) / 10;
  const windBase = 12 + (altitudeM / 1000) * 8 + Math.sin(sample.distanceM / 5000) * 3;
  const windKmh = Math.max(2, Math.round(windBase * 10) / 10);
  const feelsLike = Math.round((temperature - (windKmh > 15 ? (windKmh - 15) * 0.12 : 0)) * 10) / 10;
  const humidity = Math.max(25, Math.min(95, Math.round(62 - diurnalTempDelta * 2.8 + (altitudeM / 1000) * 4)));
  const cloudCover = Math.max(0, Math.min(100, Math.round(35 + Math.sin(sample.distanceM / 14000) * 20)));
  const rain = cloudCover > 80 ? Math.round((cloudCover - 80) * 0.08 * 10) / 10 : 0;
  const isDay = currentHour >= 6.5 && currentHour <= 20.5;
  const sunshineMin = isDay ? Math.max(0, Math.min(60, Math.round((1 - cloudCover / 100) * 60))) : 0;

  return {
    temperature,
    feelsLike,
    rain,
    windKmh,
    cloudCover,
    humidity,
    sunshineMin,
  };
}

