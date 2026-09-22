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
  const dateParts = targetDate.split('-').map(Number);
  const timeParts = targetTime.split(':').map(Number);
  const year = dateParts[0] || new Date().getFullYear();
  const month = (dateParts[1] || 1) - 1;
  const day = dateParts[2] || 1;
  const hour = timeParts[0] || 0;
  const minute = timeParts[1] || 0;

  // Local wall-clock Date converted to UTC timestamp
  const localDate = new Date(year, month, day, hour, minute, 0, 0);
  const targetMs = localDate.getTime();

  if (Number.isNaN(targetMs)) return availableHours[0]!;

  let bestHour = availableHours[0]!;
  let minDiff = Math.abs(new Date(bestHour).getTime() - targetMs);

  for (let i = 1; i < availableHours.length; i++) {
    const h = availableHours[i]!;
    const diff = Math.abs(new Date(h).getTime() - targetMs);
    if (diff < minDiff) {
      minDiff = diff;
      bestHour = h;
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
  if (inFlight) {
    if (!signal) return inFlight;
    return new Promise<HTMLImageElement>((resolve, reject) => {
      if (signal.aborted) {
        reject(new DOMException('Aborted', 'AbortError'));
        return;
      }
      const onAbort = () => reject(new DOMException('Aborted', 'AbortError'));
      signal.addEventListener('abort', onAbort, { once: true });
      inFlight.then(
        (img) => {
          signal.removeEventListener('abort', onAbort);
          resolve(img);
        },
        (err) => {
          signal.removeEventListener('abort', onAbort);
          reject(err);
        },
      );
    });
  }

  const promise = new Promise<HTMLImageElement>((resolve, reject) => {
    if (signal?.aborted) {
      reject(new DOMException('Aborted', 'AbortError'));
      return;
    }

    const img = new Image();
    img.crossOrigin = 'anonymous';

    const onAbort = () => {
      img.src = '';
      inFlightImagePromises.delete(url);
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

let activePrefetchTimer: number | null = null;
let prefetchAbortController: AbortController | null = null;

export function cancelPrefetch(): void {
  if (activePrefetchTimer !== null) {
    window.clearTimeout(activePrefetchTimer);
    activePrefetchTimer = null;
  }
  if (prefetchAbortController) {
    prefetchAbortController.abort();
    prefetchAbortController = null;
  }
}

export function prefetchAdjacentHours(
  variable: string,
  currentHour: string,
  availableHours: string[],
  tileFormat: string = 'png',
): void {
  cancelPrefetch();

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

  const controller = new AbortController();
  prefetchAbortController = controller;

  // Debounce background prefetch by 250ms so active timeline scrubbing isn't choked
  activePrefetchTimer = window.setTimeout(() => {
    activePrefetchTimer = null;
    if (controller.signal.aborted) return;

    for (const url of urlsToPrefetch) {
      loadTileImage(url, controller.signal).catch(() => {});
    }
  }, 250);
}


