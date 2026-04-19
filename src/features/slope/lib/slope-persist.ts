import type { SlopeResolutionKey, SlopeState } from '../types';
import { DEFAULT_SLOPE_STATE } from './slope-config';

const STORAGE_KEY = 'redview_slope_prefs';
const BREAKPOINTS_KEY = 'redview_slope_breakpoints';

const VALID_RESOLUTIONS: SlopeResolutionKey[] = ['0.40m (LIDAR)', '1m', '5m', '10m'];

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
      resolution:
        parsed.resolution && VALID_RESOLUTIONS.includes(parsed.resolution as SlopeResolutionKey)
          ? (parsed.resolution as SlopeResolutionKey)
          : DEFAULT_SLOPE_STATE.resolution,
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

// ── Custom breakpoints persistence ────────────────────────────────────

export interface PersistedBreakpoints {
  /** Number of bands (e.g. 4) */
  bandCount: number;
  /** Internal breakpoints between bands (length = bandCount - 1).
   *  Key is the band count so each count has its own breakpoints. */
  byCount: Record<number, number[]>;
}

const DEFAULT_PERSISTED: PersistedBreakpoints = {
  bandCount: 4,
  byCount: {},
};

export function loadBreakpoints(): PersistedBreakpoints {
  try {
    const raw = localStorage.getItem(BREAKPOINTS_KEY);
    if (!raw) return { ...DEFAULT_PERSISTED };
    const parsed = JSON.parse(raw) as Partial<PersistedBreakpoints>;
    return {
      bandCount: typeof parsed.bandCount === 'number' ? parsed.bandCount : DEFAULT_PERSISTED.bandCount,
      byCount: parsed.byCount && typeof parsed.byCount === 'object' ? parsed.byCount : {},
    };
  } catch {
    return { ...DEFAULT_PERSISTED };
  }
}

export function saveBreakpoints(data: PersistedBreakpoints): void {
  try {
    localStorage.setItem(BREAKPOINTS_KEY, JSON.stringify(data));
  } catch {
    // Quota exceeded — silently ignore
  }
}
