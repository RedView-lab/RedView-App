export { useAltitude } from './hooks/useAltitude';
export {
  ALTITUDE_LAYER_ID,
  ALTITUDE_SOURCE_ID,
  type AltitudeTileSourceOptions,
  type AltitudeZoneOptions,
} from './lib/altitude-source';
export {
  altitudeBandCountFromSetting,
  buildAltitudeCategories,
  clampAltitudeBreakpoints,
} from './lib/altitude-config';
export {
  loadAltitudeBreakpoints,
  loadAltitudeState,
  saveAltitudeBreakpoints,
  saveAltitudeState,
  type PersistedAltitudeBreakpoints,
} from './lib/altitude-persist';
export type {
  AltitudeCategory,
  AltitudeColorMode,
  AltitudeScaleSettingKey,
  AltitudeState,
} from './types';
