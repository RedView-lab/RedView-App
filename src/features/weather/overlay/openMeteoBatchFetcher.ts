import type { WeatherGridPoint, WeatherOverlaySample } from './types';
import { OPENMETEO_CLIMATE_URL, OPENMETEO_FORECAST_URL } from '../lib/openMeteoConfig';

export const FORECAST_API_BASE = OPENMETEO_FORECAST_URL;
export const CLIMATE_API_BASE = OPENMETEO_CLIMATE_URL;
export const FORECAST_BATCH_SIZE = 200;
export const TRENDS_BATCH_SIZE = 96;
export const MAX_RETRIES = 2;
export const INITIAL_BACKOFF_MS = 1_000;
export const MIN_REQUEST_GAP_MS = 0;

export interface ForecastBatchItem {
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

export interface ClimateBatchItem {
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

let rateLimitedUntil = 0;
let lastRequestTime = 0;

export function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  if (ms <= 0) return Promise.resolve();
  return new Promise<void>((resolve, reject) => {
    const timer = window.setTimeout(resolve, ms);
    signal?.addEventListener('abort', () => {
      window.clearTimeout(timer);
      reject(new DOMException('Aborted', 'AbortError'));
    }, { once: true });
  });
}

export function supportsFranceHdForecast(point: WeatherGridPoint): boolean {
  return point.lat >= 41 && point.lat <= 52 && point.lng >= -6 && point.lng <= 10;
}

export function unwrapCoord(value: number | number[]): number {
  return Array.isArray(value) ? value[0]! : value;
}

export function firstFinite(values: number[] | undefined, fallback: number = Number.NaN): number {
  if (!values?.length) return fallback;
  for (const value of values) {
    if (Number.isFinite(value)) return value;
  }
  return fallback;
}

export function meanFinite(values: number[] | undefined, fallback: number = Number.NaN): number {
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

export function monthRange(monthIso: string): { start: string; end: string } {
  const start = new Date(`${monthIso}-01T00:00:00`);
  const end = new Date(start.getFullYear(), start.getMonth() + 1, 0);
  const format = (value: Date) => value.toISOString().slice(0, 10);
  return { start: format(start), end: format(end) };
}

export function previewResponseText(text: string, maxLength = 180): string {
  const compact = text.replace(/\s+/g, ' ').trim();
  if (!compact) return '';
  return compact.length > maxLength ? `${compact.slice(0, maxLength)}...` : compact;
}

export function describeErrorPayload(text: string, contentType: string): string {
  if (!text.trim()) return '';
  if (contentType.includes('json')) {
    try {
      const parsed = JSON.parse(text) as {
        error?: unknown;
        detail?: unknown;
        reason?: unknown;
        message?: unknown;
      };
      const detail = [parsed.error, parsed.detail, parsed.reason, parsed.message]
        .filter((value): value is string => typeof value === 'string' && value.trim().length > 0)
        .join(' — ');
      if (detail) return detail;
    } catch {
      /* fallback to preview */
    }
  }
  return previewResponseText(text);
}

export function parseJsonPayload(text: string, contentType: string): unknown {
  const trimmed = text.trim();
  if (!trimmed) {
    throw new Error('Open-Meteo returned an empty response');
  }
  try {
    return JSON.parse(trimmed) as unknown;
  } catch (error) {
    const preview = previewResponseText(trimmed);
    const reason = error instanceof Error ? error.message : String(error);
    throw new Error(
      `Open-Meteo returned invalid JSON${contentType ? ` (${contentType})` : ''}: ${reason}${preview ? ` — ${preview}` : ''}`,
    );
  }
}

export async function fetchJsonWithBackoff(url: string, signal?: AbortSignal): Promise<unknown> {
  let lastError: Error | null = null;

  for (let attempt = 0; attempt <= MAX_RETRIES; attempt += 1) {
    if (signal?.aborted) throw new DOMException('Aborted', 'AbortError');

    const waitMs = Math.max(0, rateLimitedUntil - Date.now(), (lastRequestTime + MIN_REQUEST_GAP_MS) - Date.now());
    await sleep(waitMs, signal);
    lastRequestTime = Date.now();

    const response = await fetch(url, {
      signal,
      headers: { Accept: 'application/json, text/plain;q=0.8' },
    });
    if (response.status === 429) {
      const backoff = INITIAL_BACKOFF_MS * Math.pow(2, attempt);
      rateLimitedUntil = Date.now() + backoff;
      lastError = new Error(`Open-Meteo 429: Too Many Requests`);
      if (attempt < MAX_RETRIES) continue;
      throw lastError;
    }
    const contentType = response.headers.get('content-type') ?? '';
    const text = await response.text();
    if (!response.ok) {
      const detail = describeErrorPayload(text, contentType);
      throw new Error(
        `Open-Meteo ${response.status}${response.statusText ? ` ${response.statusText}` : ''}${detail ? ` — ${detail}` : ''}`,
      );
    }
    return parseJsonPayload(text, contentType);
  }

  throw lastError ?? new Error('Open-Meteo fetch failed');
}

export async function fetchForecastBatchSubset(
  points: WeatherGridPoint[],
  forecastIso: string,
  franceModel: boolean,
  signal?: AbortSignal,
): Promise<WeatherOverlaySample[]> {
  const lats = points.map((point) => point.lat.toFixed(4)).join(',');
  const lngs = points.map((point) => point.lng.toFixed(4)).join(',');
  const timeParam = encodeURIComponent(forecastIso);
  const url =
    `${FORECAST_API_BASE}?latitude=${lats}&longitude=${lngs}` +
    `&hourly=temperature_2m,relative_humidity_2m,apparent_temperature,precipitation,cloud_cover` +
    `&start_hour=${timeParam}&end_hour=${timeParam}` +
    `&timezone=Europe%2FParis&temperature_unit=celsius&precipitation_unit=mm&cell_selection=nearest` +
    (franceModel ? '&models=meteofrance_arome_france_hd' : '');

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

export async function fetchClimateBatchSubset(
  points: WeatherGridPoint[],
  monthIso: string,
  signal?: AbortSignal,
): Promise<WeatherOverlaySample[]> {
  const lats = points.map((point) => point.lat.toFixed(4)).join(',');
  const lngs = points.map((point) => point.lng.toFixed(4)).join(',');
  const { start, end } = monthRange(monthIso);
  const url =
    `${CLIMATE_API_BASE}?latitude=${lats}&longitude=${lngs}` +
    `&daily=temperature_2m_mean,relative_humidity_2m_mean,cloud_cover_mean,rain_sum,precipitation_sum` +
    `&start_date=${start}&end_date=${end}&models=EC_Earth3P_HR`;

  const json = await fetchJsonWithBackoff(url, signal);
  const items: ClimateBatchItem[] = Array.isArray(json) ? json as ClimateBatchItem[] : [json as ClimateBatchItem];

  return items.map((item) => {
    const rainSum = meanFinite(item.daily?.rain_sum);
    const precipSum = meanFinite(item.daily?.precipitation_sum);
    const rain = Number.isFinite(rainSum) ? rainSum : precipSum;
    return {
      lat: unwrapCoord(item.latitude),
      lng: unwrapCoord(item.longitude),
      temperature: meanFinite(item.daily?.temperature_2m_mean),
      feelsLike: meanFinite(item.daily?.temperature_2m_mean),
      rain,
      cloudCover: meanFinite(item.daily?.cloud_cover_mean),
      humidity: meanFinite(item.daily?.relative_humidity_2m_mean),
    };
  });
}
