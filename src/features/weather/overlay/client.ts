import type { Map as MapboxMap } from 'mapbox-gl';
import type {
  WeatherGridDefinition,
  WeatherGridPoint,
  WeatherOverlaySample,
  WeatherSelection,
} from './types';
import { OPENMETEO_FORECAST_URL, OPENMETEO_CLIMATE_URL } from '../lib/openMeteoConfig';

const FORECAST_API_BASE = OPENMETEO_FORECAST_URL;
const CLIMATE_API_BASE = OPENMETEO_CLIMATE_URL;
const FORECAST_CACHE_TTL_MS = 20 * 60 * 1000;
const TREND_CACHE_TTL_MS = 12 * 60 * 60 * 1000;
const FORECAST_BATCH_SIZE = 84;
const TRENDS_BATCH_SIZE = 96;
const MAX_RETRIES = 4;
const INITIAL_BACKOFF_MS = 3_000;
const MIN_REQUEST_GAP_MS = 1_800;
const INTER_BATCH_DELAY_MS = 1_300;
const FORECAST_SPACING_TABLE: [number, number][] = [
  [4, 1.0],
  [5, 0.5],
  [6, 0.25],
  [7, 0.125],
  [8, 0.0625],
  [9, 0.03125],
  [10, 0.02],
  [11, 0.01],
  [12, 0.005],
];
const TRENDS_SPACING_TABLE: [number, number][] = [
  [4, 1.5],
  [5, 1.0],
  [6, 0.5],
  [7, 0.25],
  [8, 0.125],
  [9, 0.0625],
  [10, 0.03125],
  [11, 0.02],
  [12, 0.01],
];
const FORECAST_MIN_SPACING = 0.005;
const TRENDS_MIN_SPACING = 0.01;

interface WeatherViewport {
  north: number;
  south: number;
  east: number;
  west: number;
  zoom: number;
}

interface CachedSampleEntry {
  sample: WeatherOverlaySample;
  fetchedAt: number;
}

interface ForecastBatchItem {
  latitude: number | number[];
  longitude: number | number[];
  hourly?: {
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

function interpolateSpacing(zoom: number, table: [number, number][]): number {
  if (zoom <= table[0][0]) return table[0][1];

  for (let index = 1; index < table.length; index += 1) {
    const [z0, spacing0] = table[index - 1];
    const [z1, spacing1] = table[index];
    if (zoom <= z1) {
      const t = (zoom - z0) / Math.max(0.0001, z1 - z0);
      return spacing0 + t * (spacing1 - spacing0);
    }
  }

  return table[table.length - 1][1];
}

function quantizeSpacing(step: number, minSpacing: number): number {
  let next = Math.max(step, minSpacing);
  if (next >= 0.03125) {
    const log2 = Math.round(Math.log2(1 / next));
    next = 1 / Math.pow(2, log2);
  } else if (next >= 0.01) {
    next = Math.ceil(next / 0.005) * 0.005;
  } else {
    next = Math.ceil(next / 0.0025) * 0.0025;
  }
  return Math.max(next, minSpacing);
}

function snapDown(value: number, step: number): number {
  return Math.floor(value / step) * step;
}

function snapUp(value: number, step: number): number {
  return Math.ceil(value / step) * step;
}

function paddingForZoom(mode: WeatherSelection['mode'], zoom: number): number {
  if (mode === 'forecast') {
    if (zoom >= 9) return 0.24;
    if (zoom >= 7) return 0.2;
    return 0.15;
  }
  if (zoom >= 9) return 0.12;
  if (zoom >= 7) return 0.1;
  return 0.08;
}

function maxPointsForZoom(mode: WeatherSelection['mode'], zoom: number): number {
  if (mode === 'forecast') {
    if (zoom <= 5.5) return 384;
    if (zoom <= 7.5) return 320;
    return 256;
  }
  if (zoom <= 5.5) return 224;
  if (zoom <= 7.5) return 180;
  return 140;
}

function gridDefaultsForMode(mode: WeatherSelection['mode']): { spacingTable: [number, number][]; minSpacing: number } {
  return mode === 'forecast'
    ? { spacingTable: FORECAST_SPACING_TABLE, minSpacing: FORECAST_MIN_SPACING }
    : { spacingTable: TRENDS_SPACING_TABLE, minSpacing: TRENDS_MIN_SPACING };
}

function buildGridEnvelope(viewport: WeatherViewport, mode: WeatherSelection['mode']): {
  bounds: [west: number, south: number, east: number, north: number];
  rows: number;
  cols: number;
  spacing: number;
} {
  const { spacingTable, minSpacing } = gridDefaultsForMode(mode);
  const padding = paddingForZoom(mode, viewport.zoom);
  const maxPoints = maxPointsForZoom(mode, viewport.zoom);
  const latPad = (viewport.north - viewport.south) * padding;
  const lngPad = (viewport.east - viewport.west) * padding;
  const paddedWest = clamp(viewport.west - lngPad, -180, 180);
  const paddedEast = clamp(viewport.east + lngPad, -180, 180);
  const paddedSouth = clamp(viewport.south - latPad, -85, 85);
  const paddedNorth = clamp(viewport.north + latPad, -85, 85);

  let spacing = quantizeSpacing(interpolateSpacing(viewport.zoom, spacingTable), minSpacing);
  let rows = 0;
  let cols = 0;
  let west = paddedWest;
  let east = paddedEast;
  let south = paddedSouth;
  let north = paddedNorth;

  for (let attempt = 0; attempt < 10; attempt += 1) {
    west = clamp(snapDown(paddedWest, spacing), -180, 180);
    east = clamp(snapUp(paddedEast, spacing), -180, 180);
    south = clamp(snapDown(paddedSouth, spacing), -85, 85);
    north = clamp(snapUp(paddedNorth, spacing), -85, 85);

    cols = Math.max(2, Math.round((east - west) / spacing) + 1);
    rows = Math.max(2, Math.round((north - south) / spacing) + 1);
    if (cols * rows <= maxPoints) break;

    const scaledSpacing = spacing * Math.sqrt((cols * rows) / maxPoints) * 1.08;
    const widenedSpacing = quantizeSpacing(scaledSpacing, minSpacing);
    spacing = widenedSpacing > spacing ? widenedSpacing : quantizeSpacing(spacing * 1.5, minSpacing);
  }

  return {
    bounds: [west, south, east, north],
    rows,
    cols,
    spacing,
  };
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
    `&hourly=temperature_2m,relative_humidity_2m,apparent_temperature,precipitation,cloud_cover` +
    `&start_hour=${timeParam}&end_hour=${timeParam}` +
    `&timezone=Europe%2FParis&temperature_unit=celsius&precipitation_unit=mm&cell_selection=nearest` +
    franceModel;

  const json = await fetchJsonWithBackoff(url, signal);
  const items: ForecastBatchItem[] = Array.isArray(json) ? json as ForecastBatchItem[] : [json as ForecastBatchItem];

  return items.map((item) => {
    const temp = firstFinite(item.hourly?.temperature_2m);
    return {
      lat: unwrapCoord(item.latitude),
      lng: unwrapCoord(item.longitude),
      temperature: temp,
      feelsLike: firstFinite(item.hourly?.apparent_temperature, temp),
      rain: firstFinite(item.hourly?.precipitation),
      cloudCover: firstFinite(item.hourly?.cloud_cover),
      humidity: firstFinite(item.hourly?.relative_humidity_2m),
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
      spacing: mode === 'forecast' ? FORECAST_MIN_SPACING : TRENDS_MIN_SPACING,
      points: [],
    };
  }
  const envelope = buildGridEnvelope({
    north: bounds.getNorth(),
    south: bounds.getSouth(),
    east: bounds.getEast(),
    west: bounds.getWest(),
    zoom: map.getZoom(),
  }, mode);
  const points: WeatherGridPoint[] = [];

  for (let row = 0; row < envelope.rows; row += 1) {
    for (let col = 0; col < envelope.cols; col += 1) {
      points.push({
        lat: Number((envelope.bounds[3] - row * envelope.spacing).toFixed(4)),
        lng: Number((envelope.bounds[0] + col * envelope.spacing).toFixed(4)),
        row,
        col,
      });
    }
  }

  return {
    bounds: envelope.bounds,
    rows: envelope.rows,
    cols: envelope.cols,
    spacing: envelope.spacing,
    points,
  };
}

export function weatherGridSupportsViewport(
  grid: WeatherGridDefinition,
  viewport: WeatherViewport,
  mode: WeatherSelection['mode'],
): boolean {
  const desired = buildGridEnvelope(viewport, mode);
  const containsViewport = viewport.west >= grid.bounds[0]
    && viewport.south >= grid.bounds[1]
    && viewport.east <= grid.bounds[2]
    && viewport.north <= grid.bounds[3];

  return containsViewport && grid.spacing <= desired.spacing + 1e-6;
}

export async function fetchWeatherGridData(
  selection: WeatherSelection,
  grid: WeatherGridDefinition,
  signal?: AbortSignal,
): Promise<WeatherOverlaySample[]> {
  const ttlMs = selection.mode === 'forecast' ? FORECAST_CACHE_TTL_MS : TREND_CACHE_TTL_MS;
  const batchSize = selection.mode === 'forecast' ? FORECAST_BATCH_SIZE : TRENDS_BATCH_SIZE;
  const samples = new Array<WeatherOverlaySample>(grid.points.length);
  const uncachedIndexes: number[] = [];

  grid.points.forEach((point, index) => {
    const cached = getCached(selection.key, point, ttlMs);
    if (cached) samples[index] = cached;
    else uncachedIndexes.push(index);
  });

  if (uncachedIndexes.length === 0) return samples;

  for (let offset = 0; offset < uncachedIndexes.length; offset += batchSize) {
    if (offset > 0) await sleep(INTER_BATCH_DELAY_MS, signal);
    const batchIndexes = uncachedIndexes.slice(offset, offset + batchSize);
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