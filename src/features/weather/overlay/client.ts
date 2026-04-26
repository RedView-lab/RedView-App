import type { Map as MapboxMap } from 'mapbox-gl';
import type {
  WeatherGridDefinition,
  WeatherGridPoint,
  WeatherOverlayMetric,
  WeatherOverlaySample,
  WeatherSelection,
} from './types';
import {
  weatherMetricPointBudgetBoost,
  weatherResolutionDetailBoost,
  weatherTargetCellPixels,
} from './detailProfile';
import { OPENMETEO_FORECAST_URL, OPENMETEO_CLIMATE_URL } from '../lib/openMeteoConfig';

const FORECAST_API_BASE = OPENMETEO_FORECAST_URL;
const CLIMATE_API_BASE = OPENMETEO_CLIMATE_URL;
const FORECAST_CACHE_TTL_MS = 20 * 60 * 1000;
const TREND_CACHE_TTL_MS = 12 * 60 * 60 * 1000;
// Self-hosted VPS → we can push much bigger batches with no throttling.
const FORECAST_BATCH_SIZE = 400;
const TRENDS_BATCH_SIZE = 320;
const MAX_RETRIES = 2;
const INITIAL_BACKOFF_MS = 1_000;
const MIN_REQUEST_GAP_MS = 0;
const INTER_BATCH_DELAY_MS = 0;
const KM_PER_DEGREE_LATITUDE = 110.574;
// Tighter spacing tables = denser grid = more detail when zoomed out.
const FORECAST_SPACING_TABLE: [number, number][] = [
  [3, 0.6],
  [4, 0.3],
  [5, 0.16],
  [6, 0.08],
  [7, 0.04],
  [8, 0.02],
  [9, 0.01],
  [10, 0.005],
  [11, 0.0025],
  [12, 0.00125],
];
const TRENDS_SPACING_TABLE: [number, number][] = [
  [3, 1.0],
  [4, 0.6],
  [5, 0.32],
  [6, 0.16],
  [7, 0.08],
  [8, 0.04],
  [9, 0.02],
  [10, 0.01],
  [11, 0.005],
  [12, 0.0025],
];
const FORECAST_RESOLUTION_KM_TABLE: [number, number][] = [
  [3, 50],
  [4, 36],
  [5, 24],
  [6, 16],
  [7, 10],
  [8, 6],
  [9, 3],
  [10, 1.5],
  [11, 0.8],
  [12, 0.4],
];
const TRENDS_RESOLUTION_KM_TABLE: [number, number][] = [
  [3, 50],
  [4, 40],
  [5, 28],
  [6, 18],
  [7, 12],
  [8, 8],
  [9, 4],
  [10, 2],
  [11, 1],
  [12, 0.5],
];
const FORECAST_MIN_SPACING = 0.00125;
const TRENDS_MIN_SPACING = 0.0025;

interface WeatherViewport {
  north: number;
  south: number;
  east: number;
  west: number;
  zoom: number;
  pixelWidth: number;
  pixelHeight: number;
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

function maxPointsForZoom(
  mode: WeatherSelection['mode'],
  zoom: number,
  metrics: readonly WeatherOverlayMetric[],
  pixelWidth: number,
  pixelHeight: number,
): number {
  // Self-hosted VPS → we can afford much denser grids.
  const targetPx = weatherTargetCellPixels(mode, zoom, metrics);
  const targetCols = Math.max(2, Math.ceil(pixelWidth / Math.max(8, targetPx)) + 1);
  const targetRows = Math.max(2, Math.ceil(pixelHeight / Math.max(8, targetPx)) + 1);
  const screenBudget = Math.ceil(targetCols * targetRows * 1.5);
  const metricBoost = weatherMetricPointBudgetBoost(metrics);
  const hardCap = mode === 'forecast' ? 28000 : 18000;

  if (mode === 'forecast') {
    const base = zoom <= 4.5 ? 9000 : zoom <= 6.5 ? 6500 : zoom <= 8.5 ? 4200 : 2600;
    return Math.min(hardCap, Math.max(Math.round(base * metricBoost), screenBudget));
  }
  const base = zoom <= 4.5 ? 4200 : zoom <= 6.5 ? 2800 : zoom <= 8.5 ? 1800 : 1100;
  return Math.min(hardCap, Math.max(Math.round(base * metricBoost), screenBudget));
}

function gridDefaultsForMode(mode: WeatherSelection['mode']): {
  spacingTable: [number, number][];
  resolutionKmTable: [number, number][];
  minSpacing: number;
} {
  return mode === 'forecast'
    ? {
        spacingTable: FORECAST_SPACING_TABLE,
        resolutionKmTable: FORECAST_RESOLUTION_KM_TABLE,
        minSpacing: FORECAST_MIN_SPACING,
      }
    : {
        spacingTable: TRENDS_SPACING_TABLE,
        resolutionKmTable: TRENDS_RESOLUTION_KM_TABLE,
        minSpacing: TRENDS_MIN_SPACING,
      };
}

function degreeSpacingForKilometres(targetKm: number): number {
  return targetKm / KM_PER_DEGREE_LATITUDE;
}

function buildGridEnvelope(
  viewport: WeatherViewport,
  mode: WeatherSelection['mode'],
  metrics: readonly WeatherOverlayMetric[],
): {
  bounds: [west: number, south: number, east: number, north: number];
  rows: number;
  cols: number;
  spacing: number;
} {
  const { spacingTable, resolutionKmTable, minSpacing } = gridDefaultsForMode(mode);
  const padding = paddingForZoom(mode, viewport.zoom);
  const maxPoints = maxPointsForZoom(mode, viewport.zoom, metrics, viewport.pixelWidth, viewport.pixelHeight);
  const latPad = (viewport.north - viewport.south) * padding;
  const lngPad = (viewport.east - viewport.west) * padding;
  const paddedWest = clamp(viewport.west - lngPad, -180, 180);
  const paddedEast = clamp(viewport.east + lngPad, -180, 180);
  const paddedSouth = clamp(viewport.south - latPad, -85, 85);
  const paddedNorth = clamp(viewport.north + latPad, -85, 85);

  const targetResolutionKm = interpolateSpacing(viewport.zoom, resolutionKmTable)
    * weatherResolutionDetailBoost(mode, viewport.zoom, metrics);
  const targetSpacingDegrees = quantizeSpacing(degreeSpacingForKilometres(targetResolutionKm), minSpacing);
  const targetPx = weatherTargetCellPixels(mode, viewport.zoom, metrics);
  const targetCols = Math.max(2, Math.ceil(viewport.pixelWidth / Math.max(8, targetPx)) + 1);
  const targetRows = Math.max(2, Math.ceil(viewport.pixelHeight / Math.max(8, targetPx)) + 1);
  const screenSpacingDegrees = quantizeSpacing(
    Math.min(
      Math.abs(paddedEast - paddedWest) / Math.max(1, targetCols - 1),
      Math.abs(paddedNorth - paddedSouth) / Math.max(1, targetRows - 1),
    ),
    minSpacing,
  );
  let spacing = Math.min(
    quantizeSpacing(interpolateSpacing(viewport.zoom, spacingTable), minSpacing),
    targetSpacingDegrees,
    screenSpacingDegrees,
  );
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

function expandBoundsToCellEdges(
  bounds: [west: number, south: number, east: number, north: number],
  spacing: number,
): [west: number, south: number, east: number, north: number] {
  const halfSpacing = Math.max(0, spacing) * 0.5;
  return [
    clamp(bounds[0] - halfSpacing, -180, 180),
    clamp(bounds[1] - halfSpacing, -85, 85),
    clamp(bounds[2] + halfSpacing, -180, 180),
    clamp(bounds[3] + halfSpacing, -85, 85),
  ];
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

function firstFinite(values: number[] | undefined, fallback: number = Number.NaN): number {
  if (!values?.length) return fallback;
  for (const value of values) {
    if (Number.isFinite(value)) return value;
  }
  return fallback;
}

function meanFinite(values: number[] | undefined, fallback: number = Number.NaN): number {
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

export function buildWeatherGrid(
  map: MapboxMap,
  mode: WeatherSelection['mode'],
  metrics: readonly WeatherOverlayMetric[] = [],
): WeatherGridDefinition {
  const bounds = map.getBounds();
  const canvas = map.getCanvas();
  const pixelWidth = Math.max(320, canvas.clientWidth || canvas.width || 320);
  const pixelHeight = Math.max(240, canvas.clientHeight || canvas.height || 240);
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
    pixelWidth,
    pixelHeight,
  }, mode, metrics);
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

  const imageBounds = expandBoundsToCellEdges(envelope.bounds, envelope.spacing);

  return {
    bounds: imageBounds,
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
  metrics: readonly WeatherOverlayMetric[] = [],
): boolean {
  const desired = buildGridEnvelope(viewport, mode, metrics);
  const containsDesired = desired.bounds[0] >= grid.bounds[0]
    && desired.bounds[1] >= grid.bounds[1]
    && desired.bounds[2] <= grid.bounds[2]
    && desired.bounds[3] <= grid.bounds[3];
  const spacingCloseEnough = grid.spacing <= desired.spacing * 1.05;
  const rowsCloseEnough = grid.rows >= Math.floor(desired.rows * 0.9);
  const colsCloseEnough = grid.cols >= Math.floor(desired.cols * 0.9);

  return containsDesired && spacingCloseEnough && rowsCloseEnough && colsCloseEnough;
}

export async function fetchWeatherGridData(
  selection: WeatherSelection,
  grid: WeatherGridDefinition,
  signal?: AbortSignal,
  onProgress?: (completed: number, total: number) => void,
): Promise<WeatherOverlaySample[]> {
  const ttlMs = selection.mode === 'forecast' ? FORECAST_CACHE_TTL_MS : TREND_CACHE_TTL_MS;
  const batchSize = selection.mode === 'forecast' ? FORECAST_BATCH_SIZE : TRENDS_BATCH_SIZE;
  const samples = new Array<WeatherOverlaySample>(grid.points.length);
  const uncachedIndexes: number[] = [];
  const totalPoints = Math.max(1, grid.points.length);

  grid.points.forEach((point, index) => {
    const cached = getCached(selection.key, point, ttlMs);
    if (cached) samples[index] = cached;
    else uncachedIndexes.push(index);
  });

  onProgress?.(grid.points.length - uncachedIndexes.length, totalPoints);

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
    onProgress?.(
      Math.min(totalPoints, grid.points.length - uncachedIndexes.length + offset + batchIndexes.length),
      totalPoints,
    );
  }

  return samples;
}

export function clearWeatherOverlayCache(): void {
  cache.clear();
}