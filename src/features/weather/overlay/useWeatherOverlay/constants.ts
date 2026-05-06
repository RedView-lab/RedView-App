import type { WeatherOverlayMetric } from '../types';

export const SOURCE_PREFIX = 'weather-overlay-source';
export const LAYER_PREFIX = 'weather-overlay-layer';
export const SUPPORTED_KEYS: WeatherOverlayMetric[] = ['temperature', 'feelsLike', 'rain', 'cloudCover', 'humidity'];
export const MOVE_DEBOUNCE_MS = 220;
export const MIN_FETCH_INTERVAL_MS = 800;
// Style-sync recovery timings.
//
// Background: `map.isStyleLoaded()` can stay false for surprisingly long
// stretches under heavy DEM/slope/altitude tile churn (every styledata event
// flips the internal flag back to false). The previous 15 s watchdog meant
// the user could see "Météo · Synchronisation du style 75 %" for up to a
// quarter of a minute before the fallback path kicked in — feeling stuck.
//
// New strategy:
//   * `canMutateStyle()` (in hook.ts) auto-promotes the source-count-based
//     fallback inline whenever the strict `isStyleLoaded()` returns false
//     but the style + sources actually exist. This eliminates the wait
//     entirely in the common case.
//   * The watchdog timer below is now a much shorter safety net for the
//     truly degenerate case (mid-style-swap, totally empty style).
//   * Retry interval relaxed from 96 ms (status spam) to 250 ms — still
//     near-instant from the user's perspective, with one tenth the timer
//     churn.
export const STYLE_SYNC_RETRY_MS = 250;
export const STYLE_SYNC_WATCHDOG_MS = 1_500;
export const STYLE_SYNC_POLL_MS = 600;
export const STYLE_SYNC_MAX_POLLS = 20;
export const STATUS_ID = 'weather';

export type RefreshReason = 'normal' | 'force' | 'reload';

export function sourceId(key: WeatherOverlayMetric): string {
  return `${SOURCE_PREFIX}-${key}`;
}

export function layerId(key: WeatherOverlayMetric): string {
  return `${LAYER_PREFIX}-${key}`;
}