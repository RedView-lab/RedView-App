import type { WindPoint, WindDataSource, WindGridDefinition, WindTimeSelection } from '../types';
import { coordCacheKey } from './wind-grid';
import { OPENMETEO_FORECAST_URL } from './openMeteoConfig';
import {
  normaliseWindRequestedHourKey,
  normaliseWindSelection,
  windSelectionKey,
  WIND_TIMEZONE,
} from './windSelection';

// ── Configuration ─────────────────────────────────────────────────────

const API_BASE = OPENMETEO_FORECAST_URL;
const CACHE_TTL_MS = 45 * 60 * 1000; // 45 minutes
// Self-hosted VPS → we can hammer it. Bigger batches, no inter-batch
// gap, only a tiny safety retry budget for transient errors.
const BATCH_SIZE = 200; // Keep URLs below proxy/browser limits for multi-point requests
const MAX_RETRIES = 2;
const INITIAL_BACKOFF_MS = 1_000;
const MIN_REQUEST_GAP_MS = 0;
const INTER_BATCH_DELAY_MS = 0;

// ── Global rate-limit cooldown ────────────────────────────────────────

let rateLimitedUntil = 0;
let lastRequestTime = 0;

// ── In-memory cache ───────────────────────────────────────────────────

interface WindHourlyCacheEntry {
  hours: Map<string, WindPoint>;
  fetchedAt: number;
}

const cache = new Map<string, WindHourlyCacheEntry>();
const inFlightGridFetches = new Map<string, Promise<{ points: WindPoint[]; source: WindDataSource | null }>>();

function toDailyCacheKey(lat: number, lng: number, dateIso: string): string {
  return `${coordCacheKey(lat, lng)}|${dateIso}`;
}

function normaliseApiHourKey(timeValue: string): string | null {
  const match = /^(\d{4}-\d{2}-\d{2}T\d{2})/.exec(timeValue);
  return match ? `${match[1]}:00` : null;
}

function getCached(lat: number, lng: number, selection: WindTimeSelection): WindPoint | null {
  const key = toDailyCacheKey(lat, lng, selection.date);
  const entry = cache.get(key);
  if (!entry) return null;
  if (Date.now() - entry.fetchedAt > CACHE_TTL_MS) {
    cache.delete(key);
    return null;
  }
  const exact = entry.hours.get(normaliseWindRequestedHourKey(selection.date, selection.time));
  if (exact) return exact;

  let fallback: WindPoint | null = null;
  let bestDelta = Number.POSITIVE_INFINITY;
  const targetHour = Number(normaliseWindRequestedHourKey(selection.date, selection.time).slice(11, 13));
  for (const [hourKey, point] of entry.hours) {
    if (!hourKey.startsWith(`${selection.date}T`)) continue;
    const hour = Number(hourKey.slice(11, 13));
    const delta = Math.abs(targetHour - hour);
    if (delta < bestDelta) {
      bestDelta = delta;
      fallback = point;
    }
  }
  return fallback;
}

function setCache(lat: number, lng: number, dateIso: string, hours: Map<string, WindPoint>): void {
  cache.set(toDailyCacheKey(lat, lng, dateIso), { hours, fetchedAt: Date.now() });
}

function gridSelectionCacheKey(grid: WindGridDefinition, selection: WindTimeSelection): string {
  const { north, south, east, west, spacing } = grid.bounds;
  const normalisedSelection = normaliseWindSelection(selection);
  return [
    normalisedSelection.date,
    normalisedSelection.time,
    grid.rows,
    grid.cols,
    north.toFixed(6),
    south.toFixed(6),
    east.toFixed(6),
    west.toFixed(6),
    spacing.toFixed(6),
  ].join('|');
}

// ── API fetch ─────────────────────────────────────────────────────────

interface OpenMeteoResponse {
  latitude: number | number[];
  longitude: number | number[];
  hourly: {
    time: string[];
    wind_speed_10m: Array<number | null>;
    wind_direction_10m: Array<number | null>;
    wind_gusts_10m: Array<number | null>;
  };
}

interface FetchBatchResult {
  points: WindPoint[];
  source: WindDataSource;
}

export interface WindFetchProgress {
  completedBatches: number;
  totalBatches: number;
  source: WindDataSource | null;
  detail: string;
}

function normaliseBatchPoint(
  item: OpenMeteoResponse | undefined,
  fallbackCoord: { lat: number; lng: number },
  selection: WindTimeSelection,
): WindPoint {
  if (!item?.hourly?.time?.length) {
    throw new Error(`Wind batch returned no hourly data for ${fallbackCoord.lat.toFixed(4)},${fallbackCoord.lng.toFixed(4)}`);
  }

  const lat = Array.isArray(item.latitude) ? item.latitude[0] : item.latitude;
  const lng = Array.isArray(item.longitude) ? item.longitude[0] : item.longitude;
  const resolvedLat = Number.isFinite(lat) ? lat : fallbackCoord.lat;
  const resolvedLng = Number.isFinite(lng) ? lng : fallbackCoord.lng;
  const hours = new Map<string, WindPoint>();

  item.hourly.time.forEach((timeValue, hourlyIndex) => {
    const hourKey = normaliseApiHourKey(timeValue);
    if (!hourKey) return;
    hours.set(hourKey, {
      lat: resolvedLat,
      lng: resolvedLng,
      speed: item.hourly.wind_speed_10m[hourlyIndex] ?? 0,
      direction: item.hourly.wind_direction_10m[hourlyIndex] ?? 0,
      gusts: item.hourly.wind_gusts_10m[hourlyIndex] ?? 0,
    });
  });

  if (hours.size === 0) {
    throw new Error(`Wind batch returned no usable hours for ${fallbackCoord.lat.toFixed(4)},${fallbackCoord.lng.toFixed(4)}`);
  }

  setCache(resolvedLat, resolvedLng, selection.date, hours);
  const selectedPoint = getCached(resolvedLat, resolvedLng, selection);
  if (!selectedPoint) {
    throw new Error(`Wind batch missing selected hour for ${fallbackCoord.lat.toFixed(4)},${fallbackCoord.lng.toFixed(4)}`);
  }

  return selectedPoint;
}

function resolveWindSource(url: string, response: Response): WindDataSource {
  const header = response.headers.get('X-Weather-Source');
  if (header === 'self-hosted-vps' || header === 'public-api') return header;
  if (url.startsWith('/api/openmeteo')) return 'unknown';
  if (url.includes('api.open-meteo.com') || url.includes('climate-api.open-meteo.com')) return 'public-api';
  return 'direct';
}

/**
 * Fetch a single batch of wind data (up to BATCH_SIZE coordinates).
 */
async function fetchBatch(
  coords: { lat: number; lng: number }[],
  selection: WindTimeSelection,
  signal?: AbortSignal,
): Promise<FetchBatchResult> {
  const lats = coords.map((c) => c.lat.toFixed(4)).join(',');
  const lngs = coords.map((c) => c.lng.toFixed(4)).join(',');

  // Use Météo-France AROME HD (1.5km) when all points fall within France coverage
  const inFrance = coords.every(
    (c) => c.lat >= 41 && c.lat <= 52 && c.lng >= -6 && c.lng <= 10,
  );
  const modelParam = inFrance ? '&models=meteofrance_arome_france_hd' : '';

  const url =
    `${API_BASE}?latitude=${lats}&longitude=${lngs}` +
    `&hourly=wind_speed_10m,wind_direction_10m,wind_gusts_10m` +
    `&start_date=${selection.date}&end_date=${selection.date}` +
    `&wind_speed_unit=ms&timeformat=iso8601&timezone=${encodeURIComponent(WIND_TIMEZONE)}&cell_selection=nearest` +
    modelParam;

  let lastError: Error | null = null;

  for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
    if (signal?.aborted) throw new DOMException('Aborted', 'AbortError');

    // Respect global cooldown from previous 429
    const cooldownWait = rateLimitedUntil - Date.now();
    // Respect minimum gap between any two requests
    const gapWait = (lastRequestTime + MIN_REQUEST_GAP_MS) - Date.now();
    const waitMs = Math.max(0, cooldownWait, gapWait);

    if (waitMs > 0) {
      await new Promise<void>((resolve, reject) => {
        const timer = setTimeout(resolve, waitMs);
        signal?.addEventListener('abort', () => { clearTimeout(timer); reject(new DOMException('Aborted', 'AbortError')); }, { once: true });
      });
    }

    lastRequestTime = Date.now();
    const res = await fetch(url, { signal });

    if (res.status === 429) {
      const backoff = INITIAL_BACKOFF_MS * Math.pow(2, attempt);
      rateLimitedUntil = Date.now() + backoff;
      console.warn(`[wind] Open-Meteo 429, backing off ${backoff}ms (attempt ${attempt + 1}/${MAX_RETRIES + 1})`);
      lastError = new Error(`Open-Meteo 429: Too Many Requests`);
      if (attempt < MAX_RETRIES) continue;
      throw lastError;
    }

    if (!res.ok) throw new Error(`Open-Meteo ${res.status}: ${res.statusText}`);

    const source = resolveWindSource(url, res);
    console.info(`[wind] Open-Meteo batch ${coords.length} coords via ${source}`);

    const json = await res.json();

    // Single coordinate → response is an object; multiple → array
    const items: OpenMeteoResponse[] = Array.isArray(json) ? json : [json];

    if (items.length !== coords.length) {
      throw new Error(`Wind batch cardinality mismatch: requested ${coords.length}, received ${items.length}`);
    }

    return {
      source,
      points: coords.map((fallbackCoord, index) => normaliseBatchPoint(items[index], fallbackCoord, selection)),
    };
  }

  throw lastError ?? new Error('Open-Meteo fetch failed');
}

/**
 * Fetch a full regular wind grid from the self-hosted VPS.
 * Results preserve the grid's row-major ordering for direct GPU upload.
 * Supports cancellation via AbortSignal.
 */
async function fetchWindGridForSelectionInternal(
  grid: WindGridDefinition,
  selection: WindTimeSelection,
  signal?: AbortSignal,
  onProgress?: (progress: WindFetchProgress) => void,
): Promise<{ points: WindPoint[]; source: WindDataSource | null }> {
  const normalisedSelection = normaliseWindSelection(selection);
  const results = new Array<WindPoint>(grid.points.length);
  const uncachedIndexes: number[] = [];

  // 1. Check cache first
  for (let index = 0; index < grid.points.length; index += 1) {
    const point = grid.points[index];
    const cached = getCached(point.lat, point.lng, selection);
    if (cached) {
      results[index] = {
        ...cached,
        lat: point.lat,
        lng: point.lng,
      };
    } else {
      uncachedIndexes.push(index);
    }
  }

  if (uncachedIndexes.length === 0) {
    return { points: results, source: null };
  }

  const totalBatches = Math.max(1, Math.ceil(uncachedIndexes.length / BATCH_SIZE));
  let lastSource: WindDataSource | null = null;
  onProgress?.({
    completedBatches: 0,
    totalBatches,
    source: null,
    detail: `Préparation vent ${normalisedSelection.date} ${normalisedSelection.time} (${grid.cols}×${grid.rows})`,
  });

  // 2. Batch fetch uncached coordinates (with inter-batch delay)
  for (let i = 0; i < uncachedIndexes.length; i += BATCH_SIZE) {
    if (signal?.aborted) throw new DOMException('Aborted', 'AbortError');

    // Inter-batch delay to avoid 429 on consecutive batches
    if (i > 0) {
      await new Promise<void>((resolve, reject) => {
        const timer = setTimeout(resolve, INTER_BATCH_DELAY_MS);
        signal?.addEventListener('abort', () => { clearTimeout(timer); reject(new DOMException('Aborted', 'AbortError')); }, { once: true });
      });
    }

    const batchIndexes = uncachedIndexes.slice(i, i + BATCH_SIZE);
    const batch = batchIndexes.map((index) => grid.points[index]);
    const batchNumber = Math.floor(i / BATCH_SIZE) + 1;
    const { points, source } = await fetchBatch(batch, normalisedSelection, signal);
    lastSource = source;

    points.forEach((point, batchIndex) => {
      const pointIndex = batchIndexes[batchIndex];
      const gridPoint = grid.points[pointIndex];
      const normalisedPoint: WindPoint = {
        ...point,
        lat: gridPoint.lat,
        lng: gridPoint.lng,
      };
      results[pointIndex] = normalisedPoint;
    });

    onProgress?.({
      completedBatches: batchNumber,
      totalBatches,
      source,
      detail: `Vent ${normalisedSelection.date} ${normalisedSelection.time} ${batchNumber}/${totalBatches} via ${source}`,
    });
  }

  if (lastSource) {
    console.info(`[wind] fetched grid ${grid.cols}x${grid.rows} (${results.length} points) via ${lastSource}`);
  }

  const missingPoints = results.reduce((count, point) => count + (point ? 0 : 1), 0);
  if (missingPoints > 0) {
    throw new Error(`Wind grid incomplete after fetch: ${missingPoints} missing points out of ${results.length}`);
  }

  return { points: results, source: lastSource };
}

async function fetchWindGridForSelection(
  grid: WindGridDefinition,
  selection: WindTimeSelection,
  signal?: AbortSignal,
  onProgress?: (progress: WindFetchProgress) => void,
): Promise<{ points: WindPoint[]; source: WindDataSource | null }> {
  const key = gridSelectionCacheKey(grid, selection);
  const existing = inFlightGridFetches.get(key);
  if (existing) {
    onProgress?.({
      completedBatches: 0,
      totalBatches: 1,
      source: null,
      detail: `Réutilisation du chargement vent en cours ${windSelectionKey(selection)} (${grid.cols}×${grid.rows})`,
    });
    return existing;
  }

  const request = fetchWindGridForSelectionInternal(grid, selection, signal, onProgress)
    .finally(() => {
      if (inFlightGridFetches.get(key) === request) {
        inFlightGridFetches.delete(key);
      }
    });

  inFlightGridFetches.set(key, request);
  return request;
}

export function hasWindGridSelectionCached(
  grid: WindGridDefinition,
  selection: WindTimeSelection,
): boolean {
  return grid.points.every((point) => getCached(point.lat, point.lng, selection));
}

export async function fetchWindGridData(
  grid: WindGridDefinition,
  selection: WindTimeSelection,
  signal?: AbortSignal,
  onProgress?: (progress: WindFetchProgress) => void,
): Promise<WindPoint[]> {
  const { points } = await fetchWindGridForSelection(grid, selection, signal, onProgress);
  return points;
}

export async function prefetchWindGridData(
  grid: WindGridDefinition,
  selection: WindTimeSelection,
  signal?: AbortSignal,
): Promise<void> {
  const baseDate = new Date(`${selection.date}T00:00:00`);
  if (Number.isNaN(baseDate.getTime())) return;

  for (let dayOffset = 1; dayOffset <= 2; dayOffset += 1) {
    const nextDate = new Date(baseDate);
    nextDate.setDate(baseDate.getDate() + dayOffset);
    const dateIso = `${nextDate.getFullYear()}-${String(nextDate.getMonth() + 1).padStart(2, '0')}-${String(nextDate.getDate()).padStart(2, '0')}`;
    const nextSelection: WindTimeSelection = {
      ...selection,
      date: dateIso,
    };

    if (hasWindGridSelectionCached(grid, nextSelection)) continue;

    try {
      await fetchWindGridForSelection(grid, nextSelection, signal);
      if (signal?.aborted) return;
      console.info(`[wind] prefetched hourly cache for ${dateIso}`);
    } catch (error) {
      if (error instanceof DOMException && error.name === 'AbortError') return;
      console.warn(`[wind] background prefetch failed for ${dateIso}`, error);
      return;
    }
  }
}

/**
 * Clear the wind data cache.
 */
export function clearWindCache(): void {
  cache.clear();
}
