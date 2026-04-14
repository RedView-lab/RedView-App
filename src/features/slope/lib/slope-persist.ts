import type { SlopeState } from '../types';
import { DEFAULT_SLOPE_STATE } from './slope-config';

const STORAGE_KEY = 'redview_slope_prefs';

export function loadSlopeState(): SlopeState {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return { ...DEFAULT_SLOPE_STATE };

    const parsed = JSON.parse(raw) as Partial<SlopeState>;
    return {
      enabled: typeof parsed.enabled === 'boolean' ? parsed.enabled : DEFAULT_SLOPE_STATE.enabled,
      opacity: typeof parsed.opacity === 'number' ? parsed.opacity : DEFAULT_SLOPE_STATE.opacity,
      colorMode: parsed.colorMode === 'gradient' || parsed.colorMode === 'step'
        ? parsed.colorMode
        : DEFAULT_SLOPE_STATE.colorMode,
    };
  } catch {
    return { ...DEFAULT_SLOPE_STATE };
  }
}

export function saveSlopeState(state: SlopeState): void {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(state));
  } catch {
    // Quota exceeded — silently ignore
  }
}
