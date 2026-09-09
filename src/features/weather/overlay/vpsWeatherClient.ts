/**
 * RedView VPS Weather Client
 * High-performance client for Oracle VPS weather tiles (France + bordering countries, 48h).
 * Replaces the multi-batch 2,000-point JSON queries and 2M-pixel CPU bilinear loops.
 */

export interface WeatherMetaBbox {
  west: number;
  south: number;
  east: number;
  north: number;
}

export interface WeatherMetaVariable {
  unit: string;
  min: number;
  max: number;
}

export interface WeatherMeta {
  updatedAt: string;
  model: string;
  bbox: WeatherMetaBbox;
  resolutionDeg: number;
  gridSize: { width: number; height: number };
  forecastHours: number;
  hours: string[];
  variables: Record<string, WeatherMetaVariable>;
  tileFormat?: string;
}

export type ImageCoords = [[number, number], [number, number], [number, number], [number, number]];

export const DEFAULT_WEATHER_BBOX: WeatherMetaBbox = {
  west: -18.0,
  south: 34.0,
  east: 32.0,
  north: 62.0,
};

let cachedMeta: WeatherMeta | null = null;
let cachedMetaTime = 0;
let metaPromise: Promise<WeatherMeta> | null = null;

const META_CACHE_TTL_MS = 3 * 60 * 1000; // 3 minutes

export function clearWeatherMetaCache(): void {
  cachedMeta = null;
  cachedMetaTime = 0;
  metaPromise = null;
}

export async function fetchWeatherMeta(signal?: AbortSignal, force = false): Promise<WeatherMeta> {
  const now = Date.now();
  if (!force && cachedMeta && now - cachedMetaTime < META_CACHE_TTL_MS) return cachedMeta;
  if (metaPromise) return metaPromise;

  metaPromise = (async () => {
    try {
      const res = await fetch('/api/weather/meta.json', { signal });
      if (!res.ok) throw new Error(`Weather meta HTTP ${res.status}`);
      const data = (await res.json()) as WeatherMeta;
      cachedMeta = data;
      cachedMetaTime = Date.now();
      return data;
    } catch (err) {
      cachedMeta = null;
      metaPromise = null;
      throw err;
    } finally {
      metaPromise = null;
    }
  })();

  return metaPromise;
}

export function bboxToImageCoords(bbox: WeatherMetaBbox = DEFAULT_WEATHER_BBOX): ImageCoords {
  return [
    [bbox.west, bbox.north],
    [bbox.east, bbox.north],
    [bbox.east, bbox.south],
    [bbox.west, bbox.south],
  ];
}

export function findClosestForecastHour(targetDate: string, targetTime: string, availableHours: string[]): string {
  if (!availableHours.length) return '';
  const targetIso = `${targetDate}T${targetTime.slice(0, 5)}:00Z`;
  const targetMs = new Date(targetIso).getTime();

  if (Number.isNaN(targetMs)) return availableHours[0]!;

  let bestHour = availableHours[0]!;
  let minDiff = Math.abs(new Date(bestHour).getTime() - targetMs);

  for (let i = 1; i < availableHours.length; i++) {
    const hour = availableHours[i]!;
    const diff = Math.abs(new Date(hour).getTime() - targetMs);
    if (diff < minDiff) {
      minDiff = diff;
      bestHour = hour;
    }
  }

  return bestHour;
}

export function buildVpsTileUrl(variable: string, isoHour: string, tileFormat: string = 'png'): string {
  return `/api/weather/tiles/${variable}_${isoHour}.${tileFormat}`;
}

const tileImageCache = new Map<string, HTMLImageElement>();
const inFlightImagePromises = new Map<string, Promise<HTMLImageElement>>();
const MAX_IMAGE_CACHE_SIZE = 64;

export async function loadTileImage(url: string, signal?: AbortSignal): Promise<HTMLImageElement> {
  const cached = tileImageCache.get(url);
  if (cached) return cached;

  const inFlight = inFlightImagePromises.get(url);
  if (inFlight) return inFlight;

  const promise = new Promise<HTMLImageElement>((resolve, reject) => {
    if (signal?.aborted) {
      reject(new DOMException('Aborted', 'AbortError'));
      return;
    }

    const img = new Image();
    img.crossOrigin = 'anonymous';

    const onAbort = () => {
      img.src = '';
      reject(new DOMException('Aborted', 'AbortError'));
    };

    signal?.addEventListener('abort', onAbort, { once: true });

    img.onload = async () => {
      signal?.removeEventListener('abort', onAbort);
      try {
        await img.decode();
      } catch {
        // onload is enough
      }
      if (tileImageCache.size >= MAX_IMAGE_CACHE_SIZE) {
        const oldestKey = tileImageCache.keys().next().value;
        if (oldestKey) tileImageCache.delete(oldestKey);
      }
      tileImageCache.set(url, img);
      inFlightImagePromises.delete(url);
      resolve(img);
    };

    img.onerror = () => {
      signal?.removeEventListener('abort', onAbort);
      inFlightImagePromises.delete(url);
      reject(new Error(`Failed to load tile image: ${url}`));
    };

    img.src = url;
  });

  inFlightImagePromises.set(url, promise);
  return promise;
}

export function prefetchAdjacentHours(
  variable: string,
  currentHour: string,
  availableHours: string[],
  tileFormat: string = 'png',
): void {
  const currentIndex = availableHours.indexOf(currentHour);
  if (currentIndex === -1) return;

  const targetIndices = [currentIndex + 1, currentIndex + 2, currentIndex - 1];
  const urlsToPrefetch: string[] = [];

  for (const idx of targetIndices) {
    if (idx >= 0 && idx < availableHours.length) {
      const h = availableHours[idx]!;
      const url = buildVpsTileUrl(variable, h, tileFormat);
      if (!tileImageCache.has(url) && !inFlightImagePromises.has(url)) {
        urlsToPrefetch.push(url);
      }
    }
  }

  if (urlsToPrefetch.length === 0) return;

  const schedule = typeof window !== 'undefined' && 'requestIdleCallback' in window
    ? (window as unknown as { requestIdleCallback: (fn: () => void) => number }).requestIdleCallback
    : (fn: () => void) => window.setTimeout(fn, 50);

  schedule(() => {
    for (const url of urlsToPrefetch) {
      loadTileImage(url).catch(() => {});
    }
  });
}

