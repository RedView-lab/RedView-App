import type { Map as MapboxMap } from 'mapbox-gl';
import type {
  WeatherGridDefinition,
  WeatherGridPoint,
  WeatherOverlaySample,
  WeatherSelection,
} from './types';

const FORECAST_API_BASE = 'https://api.open-meteo.com/v1/forecast';
const CLIMATE_API_BASE = 'https://climate-api.open-meteo.com/v1/climate';
const FORECAST_CACHE_TTL_MS = 20 * 60 * 1000;
const TREND_CACHE_TTL_MS = 12 * 60 * 60 * 1000;
const BATCH_SIZE = 36;
const MAX_RETRIES = 4;
const INITIAL_BACKOFF_MS = 3_000;
const MIN_REQUEST_GAP_MS = 1_800;
const INTER_BATCH_DELAY_MS = 1_300;
const FORECAST_MAX_POINTS = 108;
const TRENDS_MAX_POINTS = 56;
const FORECAST_PADDING = 0.35;
const TRENDS_PADDING = 0.14;

interface CachedSampleEntry {
  sample: WeatherOverlaySample;
  fetchedAt: number;
}

interface ForecastBatchItem {
  latitude: number | number[];
  longitude: number | number[];
  minutely_15?: {
    temperature_2m?: number[];
    relative_humidity_2m?: number[];
    apparent_temperature?: number[];
    precipitation?: number[];
    cloud_cover?: number[];
  };
}

interface ClimateBatchItem {
  latitude: number | number[];
  longitude: number | number[];
  daily?: {
    temperature_2m_mean?: number[];
    relative_humidity_2m_mean?: number[];
    cloud_cover_mean?: number[];
    rain_sum?: number[];
    precipitation_sum?: number[];
  };
}

const cache = new Map<string, CachedSampleEntry>();
let rateLimitedUntil = 0;
let lastRequestTime = 0;

function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value));
}

function coordCacheKey(lat: number, lng: number): string {
  return `${lat.toFixed(4)},${lng.toFixed(4)}`;
}

function makeCacheKey(selectionKey: string, point: WeatherGridPoint): string {
  return `${selectionKey}:${coordCacheKey(point.lat, point.lng)}`;
}

function getCached(selectionKey: string, point: WeatherGridPoint, ttlMs: number): WeatherOverlaySample | null {
  const entry = cache.get(makeCacheKey(selectionKey, point));
  if (!entry) return null;
  if (Date.now() - entry.fetchedAt > ttlMs) {
    cache.delete(makeCacheKey(selectionKey, point));
    return null;
  }
  return entry.sample;
}

function setCached(selectionKey: string, point: WeatherGridPoint, sample: WeatherOverlaySample): void {
  cache.set(makeCacheKey(selectionKey, point), { sample, fetchedAt: Date.now() });
}

async function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  if (ms <= 0) return;
  await new Promise<void>((resolve, reject) => {
    const timer = window.setTimeout(resolve, ms);
    signal?.addEventListener('abort', () => {
      window.clearTimeout(timer);
      reject(new DOMException('Aborted', 'AbortError'));
    }, { once: true });
  });
}

function inFrance(points: WeatherGridPoint[]): boolean {
  return points.every((point) => point.lat >= 41 && point.lat <= 52 && point.lng >= -6 && point.lng <= 10);
}

function unwrapCoord(value: number | number[]): number {
  return Array.isArray(value) ? value[0] : value;
}

function firstFinite(values: number[] | undefined, fallback: number = 0): number {
  if (!values?.length) return fallback;
  for (const value of values) {
    if (Number.isFinite(value)) return value;
  }
  return fallback;
}

function meanFinite(values: number[] | undefined, fallback: number = 0): number {
  if (!values?.length) return fallback;
  let sum = 0;
  let count = 0;
  for (const value of values) {
    if (!Number.isFinite(value)) continue;
    sum += value;
    count += 1;
  }
  return count > 0 ? sum / count : fallback;
}

function monthRange(monthIso: string): { start: string; end: string } {
  const start = new Date(`${monthIso}-01T00:00:00`);
  const end = new Date(start.getFullYear(), start.getMonth() + 1, 0);
  const format = (value: Date) => value.toISOString().slice(0, 10);
  return { start: format(start), end: format(end) };
}

async function fetchJsonWithBackoff(url: string, signal?: AbortSignal): Promise<unknown> {
  let lastError: Error | null = null;

  for (let attempt = 0; attempt <= MAX_RETRIES; attempt += 1) {
    if (signal?.aborted) throw new DOMException('Aborted', 'AbortError');

    const waitMs = Math.max(0, rateLimitedUntil - Date.now(), (lastRequestTime + MIN_REQUEST_GAP_MS) - Date.now());
    await sleep(waitMs, signal);
    lastRequestTime = Date.now();

    const response = await fetch(url, { signal });
    if (response.status === 429) {
      const backoff = INITIAL_BACKOFF_MS * Math.pow(2, attempt);
      rateLimitedUntil = Date.now() + backoff;
      lastError = new Error(`Open-Meteo 429: Too Many Requests`);
      if (attempt < MAX_RETRIES) continue;
      throw lastError;
    }
    if (!response.ok) {
      throw new Error(`Open-Meteo ${response.status}: ${response.statusText}`);
    }
    return response.json();
  }

  throw lastError ?? new Error('Open-Meteo fetch failed');
}

async function fetchForecastBatch(
  points: WeatherGridPoint[],
  forecastIso: string,
  signal?: AbortSignal,
): Promise<WeatherOverlaySample[]> {
  const lats = points.map((point) => point.lat.toFixed(4)).join(',');
  const lngs = points.map((point) => point.lng.toFixed(4)).join(',');
  const franceModel = inFrance(points) ? '&models=meteofrance_arome_france_hd' : '';
  const timeParam = encodeURIComponent(forecastIso);
  const url =
    `${FORECAST_API_BASE}?latitude=${lats}&longitude=${lngs}` +
    `&minutely_15=temperature_2m,relative_humidity_2m,apparent_temperature,precipitation,cloud_cover` +
    `&start_minutely_15=${timeParam}&end_minutely_15=${timeParam}` +
    `&timezone=Europe%2FParis&temperature_unit=celsius&precipitation_unit=mm&cell_selection=nearest` +
    franceModel;

  const json = await fetchJsonWithBackoff(url, signal);
  const items: ForecastBatchItem[] = Array.isArray(json) ? json as ForecastBatchItem[] : [json as ForecastBatchItem];

  return items.map((item) => {
    const temp = firstFinite(item.minutely_15?.temperature_2m);
    return {
      lat: unwrapCoord(item.latitude),
      lng: unwrapCoord(item.longitude),
      temperature: temp,
      feelsLike: firstFinite(item.minutely_15?.apparent_temperature, temp),
      rain: firstFinite(item.minutely_15?.precipitation),
      cloudCover: firstFinite(item.minutely_15?.cloud_cover),
      humidity: firstFinite(item.minutely_15?.relative_humidity_2m),
    };
  });
}

async function fetchTrendBatch(
  points: WeatherGridPoint[],
  monthIso: string,
  signal?: AbortSignal,
): Promise<WeatherOverlaySample[]> {
  const { start, end } = monthRange(monthIso);
  const lats = points.map((point) => point.lat.toFixed(4)).join(',');
  const lngs = points.map((point) => point.lng.toFixed(4)).join(',');
  const url =
    `${CLIMATE_API_BASE}?latitude=${lats}&longitude=${lngs}` +
    `&start_date=${start}&end_date=${end}` +
    `&models=MRI_AGCM3_2_S` +
    `&daily=temperature_2m_mean,relative_humidity_2m_mean,cloud_cover_mean,rain_sum,precipitation_sum` +
    `&timezone=Europe%2FParis&temperature_unit=celsius&precipitation_unit=mm&cell_selection=nearest`;

  const json = await fetchJsonWithBackoff(url, signal);
  const items: ClimateBatchItem[] = Array.isArray(json) ? json as ClimateBatchItem[] : [json as ClimateBatchItem];

  return items.map((item) => {
    const temp = meanFinite(item.daily?.temperature_2m_mean);
    return {
      lat: unwrapCoord(item.latitude),
      lng: unwrapCoord(item.longitude),
      temperature: temp,
      feelsLike: temp,
      rain: meanFinite(item.daily?.rain_sum, meanFinite(item.daily?.precipitation_sum)),
      cloudCover: meanFinite(item.daily?.cloud_cover_mean),
      humidity: meanFinite(item.daily?.relative_humidity_2m_mean),
    };
  });
}

export function buildWeatherGrid(map: MapboxMap, mode: WeatherSelection['mode']): WeatherGridDefinition {
  const bounds = map.getBounds();
  if (!bounds) {
    return {
      bounds: [-180, -85, 180, 85],
      rows: 0,
      cols: 0,
      points: [],
    };
  }
  const canvas = map.getCanvas();
  const width = canvas.width || canvas.clientWidth || 1024;
  const height = canvas.height || canvas.clientHeight || 768;
  const maxPoints = mode === 'forecast' ? FORECAST_MAX_POINTS : TRENDS_MAX_POINTS;
  const padding = mode === 'forecast' ? FORECAST_PADDING : TRENDS_PADDING;
  const aspect = width / Math.max(1, height);

  let cols = clamp(Math.round(width / (mode === 'forecast' ? 88 : 130)), mode === 'forecast' ? 8 : 6, mode === 'forecast' ? 18 : 10);
  let rows = clamp(Math.round(cols / aspect), mode === 'forecast' ? 6 : 5, mode === 'forecast' ? 12 : 8);

  while (cols * rows > maxPoints) {
    if (cols >= rows && cols > 4) cols -= 1;
    else if (rows > 4) rows -= 1;
    else break;
  }

  const west = bounds.getWest();
  const east = bounds.getEast();
  const south = bounds.getSouth();
  const north = bounds.getNorth();
  const lngPad = (east - west) * padding;
  const latPad = (north - south) * padding;
  const paddedWest = clamp(west - lngPad, -180, 180);
  const paddedEast = clamp(east + lngPad, -180, 180);
  const paddedSouth = clamp(south - latPad, -85, 85);
  const paddedNorth = clamp(north + latPad, -85, 85);

  const latStep = rows > 1 ? (paddedNorth - paddedSouth) / (rows - 1) : 0;
  const lngStep = cols > 1 ? (paddedEast - paddedWest) / (cols - 1) : 0;
  const points: WeatherGridPoint[] = [];

  for (let row = 0; row < rows; row += 1) {
    for (let col = 0; col < cols; col += 1) {
      points.push({
        lat: Number((paddedNorth - row * latStep).toFixed(4)),
        lng: Number((paddedWest + col * lngStep).toFixed(4)),
        row,
        col,
      });
    }
  }

  return {
    bounds: [paddedWest, paddedSouth, paddedEast, paddedNorth],
    rows,
    cols,
    points,
  };
}

export async function fetchWeatherGridData(
  selection: WeatherSelection,
  grid: WeatherGridDefinition,
  signal?: AbortSignal,
): Promise<WeatherOverlaySample[]> {
  const ttlMs = selection.mode === 'forecast' ? FORECAST_CACHE_TTL_MS : TREND_CACHE_TTL_MS;
  const samples = new Array<WeatherOverlaySample>(grid.points.length);
  const uncachedIndexes: number[] = [];

  grid.points.forEach((point, index) => {
    const cached = getCached(selection.key, point, ttlMs);
    if (cached) samples[index] = cached;
    else uncachedIndexes.push(index);
  });

  if (uncachedIndexes.length === 0) return samples;

  for (let offset = 0; offset < uncachedIndexes.length; offset += BATCH_SIZE) {
    if (offset > 0) await sleep(INTER_BATCH_DELAY_MS, signal);
    const batchIndexes = uncachedIndexes.slice(offset, offset + BATCH_SIZE);
    const batchPoints = batchIndexes.map((index) => grid.points[index]);
    const fetched = selection.mode === 'forecast'
      ? await fetchForecastBatch(batchPoints, selection.forecastIso ?? '', signal)
      : await fetchTrendBatch(batchPoints, selection.monthIso ?? '', signal);

    fetched.forEach((sample, batchIndex) => {
      const pointIndex = batchIndexes[batchIndex];
      const point = grid.points[pointIndex];
      const normalisedSample: WeatherOverlaySample = {
        ...sample,
        lat: point.lat,
        lng: point.lng,
      };
      samples[pointIndex] = normalisedSample;
      setCached(selection.key, point, normalisedSample);
    });
  }

  return samples;
}

export function clearWeatherOverlayCache(): void {
  cache.clear();
}