import type {
  AltitudeResolutionKey,
  AltitudeScaleSettingKey,
  AltitudeState,
} from '../types';
import { DEFAULT_ALTITUDE_STATE } from './altitude-config';

const STORAGE_KEY = 'redview_altitude_prefs';
const BREAKPOINTS_KEY = 'redview_altitude_breakpoints';

const VALID_RESOLUTIONS: AltitudeResolutionKey[] = ['0.40 m (LIDAR)', '1 m', '5 m', '10 m'];
const VALID_SCALE_SETTINGS: AltitudeScaleSettingKey[] = [
  '2 couleurs',
  '3 couleurs',
  '4 couleurs',
  '6 couleurs',
];

export function loadAltitudeState(): AltitudeState {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return { ...DEFAULT_ALTITUDE_STATE };

    const parsed = JSON.parse(raw) as Partial<AltitudeState>;
    return {
      enabled:
        typeof parsed.enabled === 'boolean' ? parsed.enabled : DEFAULT_ALTITUDE_STATE.enabled,
      opacity:
        typeof parsed.opacity === 'number' ? parsed.opacity : DEFAULT_ALTITUDE_STATE.opacity,
      colorMode:
        parsed.colorMode === 'gradient' || parsed.colorMode === 'step'
          ? parsed.colorMode
          : DEFAULT_ALTITUDE_STATE.colorMode,
      resolution:
        parsed.resolution && VALID_RESOLUTIONS.includes(parsed.resolution as AltitudeResolutionKey)
          ? (parsed.resolution as AltitudeResolutionKey)
          : DEFAULT_ALTITUDE_STATE.resolution,
      scaleSetting:
        parsed.scaleSetting
          && VALID_SCALE_SETTINGS.includes(parsed.scaleSetting as AltitudeScaleSettingKey)
          ? (parsed.scaleSetting as AltitudeScaleSettingKey)
          : DEFAULT_ALTITUDE_STATE.scaleSetting,
      hiddenBandIds: Array.isArray(parsed.hiddenBandIds)
        ? parsed.hiddenBandIds.filter((value): value is string => typeof value === 'string')
        : DEFAULT_ALTITUDE_STATE.hiddenBandIds,
      customColors:
        parsed.customColors && typeof parsed.customColors === 'object'
          ? Object.fromEntries(
              Object.entries(parsed.customColors).filter(
                ([key, value]) => typeof key === 'string' && typeof value === 'string',
              ),
            )
          : DEFAULT_ALTITUDE_STATE.customColors,
    };
  } catch {
    return { ...DEFAULT_ALTITUDE_STATE };
  }
}

export function saveAltitudeState(state: AltitudeState): void {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(state));
  } catch {
    // Quota exceeded — silently ignore.
  }
}

export interface PersistedAltitudeBreakpoints {
  bandCount: number;
  byCount: Record<number, number[]>;
}

const DEFAULT_BREAKPOINTS: PersistedAltitudeBreakpoints = {
  bandCount: 4,
  byCount: {},
};

export function loadAltitudeBreakpoints(): PersistedAltitudeBreakpoints {
  try {
    const raw = localStorage.getItem(BREAKPOINTS_KEY);
    if (!raw) return { ...DEFAULT_BREAKPOINTS };

    const parsed = JSON.parse(raw) as Partial<PersistedAltitudeBreakpoints>;
    return {
      bandCount: typeof parsed.bandCount === 'number' ? parsed.bandCount : DEFAULT_BREAKPOINTS.bandCount,
      byCount: parsed.byCount && typeof parsed.byCount === 'object' ? parsed.byCount : {},
    };
  } catch {
    return { ...DEFAULT_BREAKPOINTS };
  }
}

export function saveAltitudeBreakpoints(data: PersistedAltitudeBreakpoints): void {
  try {
    localStorage.setItem(BREAKPOINTS_KEY, JSON.stringify(data));
  } catch {
    // Quota exceeded — silently ignore.
  }
}