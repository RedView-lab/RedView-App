// ============================================
// Photo mode — settings shared by the panel, the controller and the renderer
// ============================================

/** Cloud scenes of the photo mode (`cloudPresets.ts`). */
export type CloudPresetId = 'clear' | 'fair' | 'cumulus' | 'overcast' | 'storm';

export interface PhotoModeState {
  enabled: boolean;
  /** Local date of the scene, YYYY-MM-DD (independent of the Ensoleillement section). */
  date: string;
  /** Local time of the scene, HH:MM. */
  time: string;
  clouds: CloudPresetId;
  /** Cloud cover 0–100 (starts at the preset's value). */
  coverage: number;
  /** Cloud base relative to the automatic altitude of the scene (m). */
  cloudBaseOffsetM: number;
  /** Haze 0–100 (aerosol density of the atmosphere). */
  haze: number;
  /** Exposure correction in EV, −3 to +3. */
  exposureEv: number;
}

/** Settings remembered between sessions (date, time and the on/off state are not). */
export type PhotoModePreferences = Pick<PhotoModeState, 'clouds' | 'coverage' | 'cloudBaseOffsetM' | 'haze' | 'exposureEv'>;

export const DEFAULT_PHOTO_PREFERENCES: PhotoModePreferences = {
  clouds: 'cumulus',
  coverage: 30,
  cloudBaseOffsetM: 0,
  haze: 25,
  exposureEv: 0,
};

/** Capture progress shown by the panel's button. */
export interface PhotoCaptureStatus {
  busy: boolean;
  /** Accumulated still frames done / needed before the image is captured. */
  done: number;
  total: number;
  /** Why the last capture failed (shown under the button), null otherwise. */
  error: string | null;
}
