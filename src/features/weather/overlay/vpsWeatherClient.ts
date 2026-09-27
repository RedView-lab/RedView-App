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

const META_CACHE_TTL_MS = 5 * 60 * 1000; // 5 minutes

export function clearWeatherMetaCache(): void {
  cachedMeta = null;
  cachedMetaTime = 0;
  metaPromise = null;
}

export function getCachedWeatherMeta(): WeatherMeta | null {
  const now = Date.now();
  if (cachedMeta && now - cachedMetaTime < META_CACHE_TTL_MS) {
    return cachedMeta;
  }
  return null;
}

/**
 * Robust weather metadata fetcher.
 * An individual caller's transient AbortSignal will NOT kill the underlying network fetch,
 * preventing cascading AbortErrors and permanent 20% progress freezes across the app.
 */
export async function fetchWeatherMeta(signal?: AbortSignal, force = false): Promise<WeatherMeta> {
  const now = Date.now();
  if (!force && cachedMeta && now - cachedMetaTime < META_CACHE_TTL_MS) {
    return cachedMeta;
  }

  if (!metaPromise || force) {
    const fetchController = new AbortController();
    const timeoutTimer = window.setTimeout(() => fetchController.abort(), 12_000);

    metaPromise = (async () => {
      try {
        const res = await fetch('/api/weather/meta.json', { signal: fetchController.signal });
        window.clearTimeout(timeoutTimer);
        if (!res.ok) throw new Error(`Weather meta HTTP ${res.status}`);
        const data = (await res.json()) as WeatherMeta;
        cachedMeta = data;
        cachedMetaTime = Date.now();
        return data;
      } catch (err) {
        window.clearTimeout(timeoutTimer);
        if (cachedMeta) {
          // Graceful fallback to existing cached metadata on transient network drops
          return cachedMeta;
        }
        throw err;
      } finally {
        metaPromise = null;
      }
    })();
  }

  // If caller provided an abort signal, respect caller cancellation without aborting the background fetch
  if (signal) {
    if (signal.aborted) {
      throw new DOMException('Aborted', 'AbortError');
    }
    return new Promise<WeatherMeta>((resolve, reject) => {
      const onAbort = () => {
        signal.removeEventListener('abort', onAbort);
        reject(new DOMException('Aborted', 'AbortError'));
      };
      signal.addEventListener('abort', onAbort, { once: true });
      metaPromise!.then(
        (data) => {
          signal.removeEventListener('abort', onAbort);
          resolve(data);
        },
        (err) => {
          signal.removeEventListener('abort', onAbort);
          reject(err);
        },
      );
    });
  }

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
const MAX_IMAGE_CACHE_SIZE = 128; // Holds 48 hours for multiple metrics easily

export function hasCachedTileImage(url: string): boolean {
  return tileImageCache.has(url);
}

export function getCachedTileImage(url: string): HTMLImageElement | undefined {
  return tileImageCache.get(url);
}

/**
 * Resilient tile image loader.
 * Ensures concurrent callers and prefetching share identical requests without
 * abort cascades (an aborted caller detaches, but the image finishes downloading
 * into tileImageCache for immediate availability on subsequent scrub steps).
 */
export async function loadTileImage(url: string, signal?: AbortSignal): Promise<HTMLImageElement> {
  const cached = tileImageCache.get(url);
  if (cached) return cached;

  let inFlight = inFlightImagePromises.get(url);
  if (!inFlight) {
    inFlight = new Promise<HTMLImageElement>((resolve, reject) => {
      const img = new Image();
      img.crossOrigin = 'anonymous';

      const cleanup = () => {
        inFlightImagePromises.delete(url);
      };

      img.onload = async () => {
        cleanup();
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
        resolve(img);
      };

      img.onerror = () => {
        cleanup();
        reject(new Error(`Failed to load tile image: ${url}`));
      };

      img.src = url;
    });

    inFlightImagePromises.set(url, inFlight);
  }

  if (!signal) return inFlight;

  if (signal.aborted) {
    throw new DOMException('Aborted', 'AbortError');
  }

  return new Promise<HTMLImageElement>((resolve, reject) => {
    const onAbort = () => {
      signal.removeEventListener('abort', onAbort);
      reject(new DOMException('Aborted', 'AbortError'));
    };
    signal.addEventListener('abort', onAbort, { once: true });
    inFlight!.then(
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

let activePrefetchTimer: number | null = null;

export function cancelPrefetch(): void {
  if (activePrefetchTimer !== null) {
    window.clearTimeout(activePrefetchTimer);
    activePrefetchTimer = null;
  }
}

/**
 * Prefetches adjacent forecast hours without cancelling foreground tile loads.
 */
export function prefetchAdjacentHours(
  variable: string,
  currentHour: string,
  availableHours: string[],
  tileFormat: string = 'png',
  onTileLoaded?: (url: string, img: HTMLImageElement, hour: string) => void,
): void {
  cancelPrefetch();

  const currentIndex = availableHours.indexOf(currentHour);
  if (currentIndex === -1) return;

  const targetIndices = [
    currentIndex + 1,
    currentIndex + 2,
    currentIndex + 3,
    currentIndex - 1,
    currentIndex - 2,
  ];
  const itemsToPrefetch: { url: string; hour: string }[] = [];

  for (const idx of targetIndices) {
    if (idx >= 0 && idx < availableHours.length) {
      const h = availableHours[idx]!;
      const url = buildVpsTileUrl(variable, h, tileFormat);
      if (!tileImageCache.has(url) && !inFlightImagePromises.has(url)) {
        itemsToPrefetch.push({ url, hour: h });
      }
    }
  }

  if (itemsToPrefetch.length === 0) return;

  // Debounce background prefetch by 100ms so active timeline scrubbing has zero network contention
  activePrefetchTimer = window.setTimeout(() => {
    activePrefetchTimer = null;
    for (const item of itemsToPrefetch) {
      loadTileImage(item.url)
        .then((img) => {
          onTileLoaded?.(item.url, img, item.hour);
        })
        .catch(() => {});
    }
  }, 100);
}


