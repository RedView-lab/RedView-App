import type { WeatherOverlayMetric } from './types';

type WeatherMode = 'forecast' | 'trends';

// High-detail metrics get the densest sampling — these are the most
// spatially-variable fields (rain bursts, humidity gradients, felt-temp
// pockets).
const HIGH_DETAIL_METRICS = new Set<WeatherOverlayMetric>(['rain', 'feelsLike', 'humidity']);
// Medium-detail metrics: temperature & cloud cover. Temperature in
// particular shows visible per-valley variation when the grid is fine
// enough; the previous "default" tier produced ~25-30 km square blocks
// at France-wide zooms that read as noticeably low-res.
const MEDIUM_DETAIL_METRICS = new Set<WeatherOverlayMetric>(['temperature', 'cloudCover']);

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
      if (zoom <= 4.5) return 10;
      if (zoom <= 6.5) return 12;
      if (zoom <= 8.5) return 14;
      return 18;
    }
    if (mediumDetail) {
      if (zoom <= 4.5) return 11;
      if (zoom <= 6.5) return 13;
      if (zoom <= 8.5) return 15;
      return 19;
    }
    if (zoom <= 4.5) return 14;
    if (zoom <= 6.5) return 16;
    if (zoom <= 8.5) return 18;
    return 22;
  }

  if (highDetail) {
    if (zoom <= 4.5) return 12;
    if (zoom <= 6.5) return 14;
    if (zoom <= 8.5) return 16;
    return 20;
  }
  if (mediumDetail) {
    if (zoom <= 4.5) return 13;
    if (zoom <= 6.5) return 15;
    if (zoom <= 8.5) return 17;
    return 21;
  }
  if (zoom <= 4.5) return 16;
  if (zoom <= 6.5) return 18;
  if (zoom <= 8.5) return 20;
  return 24;
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
      // Tightened from the previous 0.6-0.94 range so temperature /
      // cloud cover gain meaningful spatial resolution without falling
      // all the way into the high-detail point-budget tier.
      if (mode === 'forecast') {
        if (zoom <= 4.5) return 0.45;
        if (zoom <= 6.5) return 0.55;
        if (zoom <= 8.5) return 0.7;
        return 0.85;
      }
      if (zoom <= 4.5) return 0.55;
      if (zoom <= 6.5) return 0.65;
      if (zoom <= 8.5) return 0.78;
      return 0.9;
    }
    return mode === 'forecast' && zoom <= 5 ? 0.7 : 0.9;
  }
  if (mode === 'forecast') {
    if (zoom <= 4.5) return 0.3;
    if (zoom <= 6.5) return 0.4;
    if (zoom <= 8.5) return 0.55;
    return 0.75;
  }
  if (zoom <= 4.5) return 0.4;
  if (zoom <= 6.5) return 0.5;
  if (zoom <= 8.5) return 0.65;
  return 0.8;
}

export function weatherMetricPointBudgetBoost(metrics: readonly WeatherOverlayMetric[]): number {
  if (hasHighDetailMetric(metrics)) return 2.5;
  if (hasMediumDetailMetric(metrics)) return 2.0;
  return 1.4;
}