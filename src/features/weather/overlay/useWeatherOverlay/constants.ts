import type { WeatherOverlayMetric } from '../types';

export const SOURCE_PREFIX = 'weather-overlay-source';
export const LAYER_PREFIX = 'weather-overlay-layer';
export const SUPPORTED_KEYS: WeatherOverlayMetric[] = ['temperature', 'feelsLike', 'rain', 'cloudCover', 'humidity'];
export const MOVE_DEBOUNCE_MS = 220;
export const MIN_FETCH_INTERVAL_MS = 800;
export const STYLE_SYNC_RETRY_MS = 96;
export const STYLE_SYNC_WATCHDOG_MS = 15_000;
export const STYLE_SYNC_POLL_MS = 2_000;
export const STYLE_SYNC_MAX_POLLS = 15;
export const STATUS_ID = 'weather';

export type RefreshReason = 'normal' | 'force' | 'reload';

export function sourceId(key: WeatherOverlayMetric): string {
  return `${SOURCE_PREFIX}-${key}`;
}

export function layerId(key: WeatherOverlayMetric): string {
  return `${LAYER_PREFIX}-${key}`;
}