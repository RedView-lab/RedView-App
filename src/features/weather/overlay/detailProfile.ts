import type { WeatherOverlayMetric } from './types';

type WeatherMode = 'forecast' | 'trends';

const HIGH_DETAIL_METRICS = new Set<WeatherOverlayMetric>(['rain', 'feelsLike', 'humidity']);
const MEDIUM_DETAIL_METRICS = new Set<WeatherOverlayMetric>(['cloudCover']);

function hasHighDetailMetric(metrics: readonly WeatherOverlayMetric[]): boolean {
  return metrics.some((metric) => HIGH_DETAIL_METRICS.has(metric));
}

function hasMediumDetailMetric(metrics: readonly WeatherOverlayMetric[]): boolean {
  return metrics.some((metric) => MEDIUM_DETAIL_METRICS.has(metric));
}

export function weatherTargetCellPixels(
  mode: WeatherMode,
  zoom: number,
  metrics: readonly WeatherOverlayMetric[],
): number {
  const highDetail = hasHighDetailMetric(metrics);
  const mediumDetail = hasMediumDetailMetric(metrics);

  if (mode === 'forecast') {
    if (highDetail) {
      if (zoom <= 4.5) return 12;
      if (zoom <= 6.5) return 14;
      if (zoom <= 8.5) return 16;
      return 20;
    }
    if (mediumDetail) {
      if (zoom <= 4.5) return 15;
      if (zoom <= 6.5) return 17;
      if (zoom <= 8.5) return 19;
      return 23;
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
  if (mediumDetail) {
    if (zoom <= 4.5) return 16;
    if (zoom <= 6.5) return 18;
    if (zoom <= 8.5) return 20;
    return 24;
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
  const mediumDetail = hasMediumDetailMetric(metrics);
  if (!highDetail) {
    if (mediumDetail) {
      if (mode === 'forecast') {
        if (zoom <= 4.5) return 0.6;
        if (zoom <= 6.5) return 0.7;
        if (zoom <= 8.5) return 0.82;
        return 0.9;
      }
      if (zoom <= 4.5) return 0.7;
      if (zoom <= 6.5) return 0.78;
      if (zoom <= 8.5) return 0.88;
      return 0.94;
    }
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
  if (hasHighDetailMetric(metrics)) return 2.25;
  if (hasMediumDetailMetric(metrics)) return 1.7;
  return 1.4;
}