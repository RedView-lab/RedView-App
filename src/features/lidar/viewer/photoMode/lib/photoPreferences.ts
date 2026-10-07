// ============================================
// Photo mode — settings remembered in this browser
// ============================================
//
// A per-viewer convenience: cloud scene, haze and exposure are kept in
// localStorage (validated on read; private windows or blocked storage fall
// back to the defaults). Date, time and the on/off state are not.

import { CLOUD_PRESETS } from './cloudPresets';
import { DEFAULT_PHOTO_PREFERENCES, type CloudPresetId, type PhotoModePreferences } from '../types';

const STORAGE_KEY = 'rv-viewer-photo-mode-v1';

function clamp(value: unknown, min: number, max: number, fallback: number): number {
  return typeof value === 'number' && Number.isFinite(value) ? Math.max(min, Math.min(max, value)) : fallback;
}

export function readPhotoPreferences(): PhotoModePreferences {
  const d = DEFAULT_PHOTO_PREFERENCES;
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return { ...d };
    const v = JSON.parse(raw) as Record<string, unknown>;
    const clouds = typeof v.clouds === 'string' && Object.prototype.hasOwnProperty.call(CLOUD_PRESETS, v.clouds)
      ? v.clouds as CloudPresetId
      : d.clouds;
    return {
      clouds,
      coverage: clamp(v.coverage, 0, 100, d.coverage),
      cloudBaseOffsetM: clamp(v.cloudBaseOffsetM, -10000, 10000, d.cloudBaseOffsetM),
      haze: clamp(v.haze, 0, 100, d.haze),
      exposureEv: clamp(v.exposureEv, -3, 3, d.exposureEv),
    };
  } catch {
    return { ...d };
  }
}

export function writePhotoPreferences(preferences: PhotoModePreferences): void {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(preferences));
  } catch {
    // Storage unavailable (private window, quota): settings stay for this session.
  }
}
