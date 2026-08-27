import type {
  AltitudeBand,
  AltitudeColorization,
  AltitudeScaleSetting,
  SlopeBand,
  SlopeColorization,
  SlopeScale,
  SlopeScaleSetting,
  SunlightState,
} from '@/features/controlPanel/types';
import type { ViewerRouteState } from '../route/types';

export type { SunlightState, ViewerRouteState };

export interface ViewerSlopeState {
  enabled: boolean;
  opacity: number; // 0 to 100
  colorization: SlopeColorization; // 'gradient' | 'stepped'
  scale: SlopeScale; // 'percent' | 'degree'
  scaleSetting: SlopeScaleSetting;
  bands: SlopeBand[];
}

export interface ViewerAltitudeState {
  enabled: boolean;
  opacity: number; // 0 to 100
  colorization: AltitudeColorization; // 'gradient' | 'stepped'
  scaleSetting: AltitudeScaleSetting;
  bands: AltitudeBand[];
}
