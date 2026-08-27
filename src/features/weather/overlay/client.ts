import type {
  WeatherGridDataset,
  WeatherGridDefinition,
  WeatherGridPoint,
  WeatherOverlayMetric,
  WeatherOverlaySample,
  WeatherSelection,
} from './types';
import {
  FORECAST_BATCH_SIZE,
  TRENDS_BATCH_SIZE,
  fetchClimateBatchSubset,
  fetchForecastBatchSubset,
  supportsFranceHdForecast,
} from './openMeteoBatchFetcher';

export {
  buildWeatherGrid,
  weatherGridSupportsViewport,
} from './gridCalculator';

const FORECAST_CACHE_TTL_MS = 20 * 60 * 1000;
const TREND_CACHE_TTL_MS = 12 * 60 * 60 * 1000;

interface CachedSampleEntry {
  sample: WeatherOverlaySample;
  fetchedAt: number;
}

const cache = new Map<string, CachedSampleEntry>();

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

export function clearWeatherOverlayCache(): void {
  cache.clear();
}

function needsGlobalForecastModel(metrics: readonly WeatherOverlayMetric[]): boolean {
  return metrics.includes('cloudCover');
}

export function weatherDataSelectionKey(
  selection: WeatherSelection,
  metrics: readonly WeatherOverlayMetric[] = [],
): string {
  if (selection.mode !== 'forecast') return selection.key;
  return `${selection.key}:${needsGlobalForecastModel(metrics) ? 'default-model' : 'france-hd'}`;
}

/**
 * Récupère les données météorologiques interpolées sur la grille d'overlay
 * (mode prévisions ou tendances climatiques) avec cache mémoire et batching intelligent.
 */
export async function fetchWeatherGridData(
  grid: WeatherGridDefinition,
  selection: WeatherSelection,
  signal?: AbortSignal,
  onProgress?: (progress: number) => void,
  metrics: readonly WeatherOverlayMetric[] = [],
): Promise<WeatherGridDataset> {
  const ttlMs = selection.mode === 'forecast' ? FORECAST_CACHE_TTL_MS : TREND_CACHE_TTL_MS;
  const cacheKey = weatherDataSelectionKey(selection, metrics);
  const samples: WeatherOverlaySample[] = new Array(grid.points.length);
  const missingPoints: { point: WeatherGridPoint; index: number }[] = [];

  for (let i = 0; i < grid.points.length; i++) {
    const point = grid.points[i]!;
    const cached = getCached(cacheKey, point, ttlMs);
    if (cached) {
      samples[i] = cached;
    } else {
      missingPoints.push({ point, index: i });
    }
  }

  if (missingPoints.length === 0) {
    onProgress?.(1.0);
    return {
      grid,
      samples,
      selectionKey: cacheKey,
      fetchedAt: Date.now(),
    };
  }

  const batchSize = selection.mode === 'forecast' ? FORECAST_BATCH_SIZE : TRENDS_BATCH_SIZE;
  const totalBatches = Math.ceil(missingPoints.length / batchSize);
  let completedBatches = 0;

  for (let b = 0; b < missingPoints.length; b += batchSize) {
    if (signal?.aborted) throw new DOMException('Aborted', 'AbortError');
    const batch = missingPoints.slice(b, b + batchSize);
    const batchPoints = batch.map((item) => item.point);

    let batchSamples: WeatherOverlaySample[];
    if (selection.mode === 'forecast') {
      const useFranceModel = !needsGlobalForecastModel(metrics) && batchPoints.every(supportsFranceHdForecast);
      batchSamples = await fetchForecastBatchSubset(batchPoints, selection.forecastIso ?? '', useFranceModel, signal);
    } else {
      batchSamples = await fetchClimateBatchSubset(batchPoints, selection.monthIso ?? '', signal);
    }

    for (let j = 0; j < batch.length; j++) {
      const sample = batchSamples[j];
      const target = batch[j]!;
      if (sample) {
        samples[target.index] = sample;
        setCached(cacheKey, target.point, sample);
      } else {
        const fallbackSample: WeatherOverlaySample = {
          lat: target.point.lat,
          lng: target.point.lng,
          temperature: NaN,
          feelsLike: NaN,
          rain: NaN,
          cloudCover: NaN,
          humidity: NaN,
        };
        samples[target.index] = fallbackSample;
      }
    }

    completedBatches++;
    onProgress?.(completedBatches / totalBatches);
  }

  return {
    grid,
    samples,
    selectionKey: cacheKey,
    fetchedAt: Date.now(),
  };
}