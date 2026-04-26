import type { WeatherOverlayMetric } from './types';

type WeatherMode = 'forecast' | 'trends';

const HIGH_DETAIL_METRICS = new Set<WeatherOverlayMetric>(['rain', 'feelsLike', 'cloudCover', 'humidity']);

function hasHighDetailMetric(metrics: readonly WeatherOverlayMetric[]): boolean {
  return metrics.some((metric) => HIGH_DETAIL_METRICS.has(metric));
}

export function weatherTargetCellPixels(
  mode: WeatherMode,
  zoom: number,
  metrics: readonly WeatherOverlayMetric[],
): number {
  const highDetail = hasHighDetailMetric(metrics);

  if (mode === 'forecast') {
    if (highDetail) {
      if (zoom <= 4.5) return 12;
      if (zoom <= 6.5) return 14;
      if (zoom <= 8.5) return 16;
      return 20;
    }
    if (zoom <= 4.5) return 18;
    if (zoom <= 6.5) return 20;
    if (zoom <= 8.5) return 22;
    return 26;
  }

  if (highDetail) {
    if (zoom <= 4.5) return 14;
    if (zoom <= 6.5) return 16;
    if (zoom <= 8.5) return 18;
    return 22;
  }
  if (zoom <= 4.5) return 20;
  if (zoom <= 6.5) return 22;
  if (zoom <= 8.5) return 24;
  return 28;
}

export function weatherResolutionDetailBoost(
  mode: WeatherMode,
  zoom: number,
  metrics: readonly WeatherOverlayMetric[],
): number {
  const highDetail = hasHighDetailMetric(metrics);
  if (!highDetail) {
    return mode === 'forecast' && zoom <= 5 ? 0.85 : 1;
  }
  if (mode === 'forecast') {
    if (zoom <= 4.5) return 0.35;
    if (zoom <= 6.5) return 0.45;
    if (zoom <= 8.5) return 0.6;
    return 0.8;
  }
  if (zoom <= 4.5) return 0.45;
  if (zoom <= 6.5) return 0.55;
  if (zoom <= 8.5) return 0.7;
  return 0.85;
}

export function weatherMetricPointBudgetBoost(metrics: readonly WeatherOverlayMetric[]): number {
  return hasHighDetailMetric(metrics) ? 2.25 : 1.4;
}