import type { WindPoint, WindCacheEntry, WindDataSource, WindGridDefinition } from '../types';
import { coordCacheKey } from './wind-grid';
import { OPENMETEO_FORECAST_URL } from './openMeteoConfig';

// ── Configuration ─────────────────────────────────────────────────────

const API_BASE = OPENMETEO_FORECAST_URL;
const CACHE_TTL_MS = 45 * 60 * 1000; // 45 minutes
// Self-hosted VPS → we can hammer it. Bigger batches, no inter-batch
// gap, only a tiny safety retry budget for transient errors.
const BATCH_SIZE = 400; // Max coordinates per request
const MAX_RETRIES = 2;
const INITIAL_BACKOFF_MS = 1_000;
const MIN_REQUEST_GAP_MS = 0;
const INTER_BATCH_DELAY_MS = 0;

// ── Global rate-limit cooldown ────────────────────────────────────────

let rateLimitedUntil = 0;
let lastRequestTime = 0;

// ── In-memory cache ───────────────────────────────────────────────────

const cache = new Map<string, WindCacheEntry>();

function getCached(lat: number, lng: number): WindPoint | null {
  const key = coordCacheKey(lat, lng);
  const entry = cache.get(key);
  if (!entry) return null;
  if (Date.now() - entry.fetchedAt > CACHE_TTL_MS) {
    cache.delete(key);
    return null;
  }
  return entry.point;
}

function setCache(point: WindPoint): void {
  const key = coordCacheKey(point.lat, point.lng);
  cache.set(key, { point, fetchedAt: Date.now() });
}

// ── API fetch ─────────────────────────────────────────────────────────

interface OpenMeteoResponse {
  latitude: number | number[];
  longitude: number | number[];
  current: {
    wind_speed_10m: number;
    wind_direction_10m: number;
    wind_gusts_10m: number;
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
    `&current=wind_speed_10m,wind_direction_10m,wind_gusts_10m` +
    `&wind_speed_unit=ms&timeformat=unixtime&cell_selection=nearest` +
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

    return {
      source,
      points: items.map((item) => {
        const lat = Array.isArray(item.latitude) ? item.latitude[0] : item.latitude;
        const lng = Array.isArray(item.longitude) ? item.longitude[0] : item.longitude;
        return {
          lat,
          lng,
          speed: item.current.wind_speed_10m,
          direction: item.current.wind_direction_10m,
          gusts: item.current.wind_gusts_10m,
        };
      }),
    };
  }

  throw lastError ?? new Error('Open-Meteo fetch failed');
}

/**
 * Fetch a full regular wind grid from the self-hosted VPS.
 * Results preserve the grid's row-major ordering for direct GPU upload.
 * Supports cancellation via AbortSignal.
 */
export async function fetchWindGridData(
  grid: WindGridDefinition,
  signal?: AbortSignal,
  onProgress?: (progress: WindFetchProgress) => void,
): Promise<WindPoint[]> {
  const results = new Array<WindPoint>(grid.points.length);
  const uncachedIndexes: number[] = [];

  // 1. Check cache first
  for (let index = 0; index < grid.points.length; index += 1) {
    const point = grid.points[index];
    const cached = getCached(point.lat, point.lng);
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

  if (uncachedIndexes.length === 0) return results;

  const totalPoints = Math.max(1, grid.points.length);
  const totalBatches = Math.max(1, Math.ceil(uncachedIndexes.length / BATCH_SIZE));
  let lastSource: WindDataSource | null = null;
  onProgress?.({
    completedBatches: 0,
    totalBatches,
    source: null,
    detail: `Préparation grille ${grid.cols}×${grid.rows} (${grid.points.length} points)` ,
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
    const { points, source } = await fetchBatch(batch, signal);
    lastSource = source;

    points.forEach((point, batchIndex) => {
      const pointIndex = batchIndexes[batchIndex];
      const gridPoint = grid.points[pointIndex];
      const normalisedPoint: WindPoint = {
        ...point,
        lat: gridPoint.lat,
        lng: gridPoint.lng,
      };
      setCache(normalisedPoint);
      results[pointIndex] = normalisedPoint;
    });

    onProgress?.({
      completedBatches: batchNumber,
      totalBatches,
      source,
      detail: `Grille vent ${batchNumber}/${totalBatches} via ${source} (${Math.min(totalPoints, i + batchIndexes.length)}/${totalPoints})`,
    });
  }

  if (lastSource) {
    console.info(`[wind] fetched grid ${grid.cols}x${grid.rows} (${results.length} points) via ${lastSource}`);
  }

  return results;
}

/**
 * Clear the wind data cache.
 */
export function clearWindCache(): void {
  cache.clear();
}
