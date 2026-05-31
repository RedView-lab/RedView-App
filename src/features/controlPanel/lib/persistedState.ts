import type { LabelCategory } from '@/features/labels/types';
import type { PersistedAltitudeBreakpoints } from '@/features/altitude/lib/altitude-persist';
import type { AltitudeState } from '@/features/altitude/types';
import type { PersistedBreakpoints } from '@/features/slope/lib/slope-persist';
import type { SlopeState } from '@/features/slope/types';
import { DEFAULT_BASEMAP_ID } from './basemaps';
import type {
  BasemapId,
  Basemap3dQualityId,
  ContourIntervalSetting,
  SlopeScale,
  SlopeScaleSetting,
  SunlightState,
  WeatherState,
  WindPanelState,
} from '../types';

export type ControlPanelSectionKey =
  | 'basemaps'
  | 'lidarTiles'
  | 'labels'
  | 'contourLines'
  | 'routes'
  | 'slopes'
  | 'altitude'
  | 'weather'
  | 'wind'
  | 'sunlight';

export type ControlPanelSectionsOpenState = Record<ControlPanelSectionKey, boolean>;

export interface ControlPanelLabelsPersistedState {
  backend: Record<LabelCategory, boolean>;
  statesUiEnabled: boolean;
}

export interface ControlPanelSlopePersistedState {
  state: SlopeState;
  scale: SlopeScale;
  scaleSetting: SlopeScaleSetting;
  bandVisibility: Record<string, boolean>;
  customColors: Record<string, string>;
  breakpoints: PersistedBreakpoints;
}

export interface ControlPanelAltitudePersistedState {
  state: AltitudeState;
  breakpoints: PersistedAltitudeBreakpoints;
}

export interface ControlPanelContourLinesPersistedState {
  interval: ContourIntervalSetting;
  opacity: number;
}

export interface ControlPanelRoutesPersistedState {
  traceWidthPx: number;
}

export type ControlPanelSunlightPersistedState = Omit<
  SunlightState,
  'enabled' | 'sunriseTime' | 'sunsetTime'
>;

export type ControlPanelWindPersistedState = Pick<
  WindPanelState,
  'date' | 'time' | 'forecastDay' | 'particlesEnabled' | 'terrainOverlayEnabled'
>;

export interface ControlPanelPersistedState {
  sectionsOpen: ControlPanelSectionsOpenState;
  basemapId: BasemapId;
  basemap3dQuality: Basemap3dQualityId;
  toggles: {
    labelsEnabled: boolean;
    contourLinesEnabled: boolean;
    slopesEnabled: boolean;
    altitudeEnabled: boolean;
    weatherEnabled: boolean;
    windEnabled: boolean;
    snowEnabled: boolean;
    sunlightEnabled: boolean;
  };
  sunlightMapExpanded: boolean;
  lidarTilesHidden?: Record<string, boolean>;
  labelsState?: ControlPanelLabelsPersistedState;
  contourLines?: ControlPanelContourLinesPersistedState;
  routes?: ControlPanelRoutesPersistedState;
  slopes?: ControlPanelSlopePersistedState;
  altitude?: ControlPanelAltitudePersistedState;
  weather?: WeatherState;
  wind?: ControlPanelWindPersistedState;
  sunlight?: ControlPanelSunlightPersistedState;
}

const DEFAULT_SECTIONS_OPEN: ControlPanelSectionsOpenState = {
  basemaps: false,
  lidarTiles: false,
  labels: false,
  contourLines: false,
  routes: false,
  slopes: false,
  altitude: false,
  weather: false,
  wind: false,
  sunlight: false,
};

export function createDefaultControlPanelPersistedState(): ControlPanelPersistedState {
  return {
    sectionsOpen: { ...DEFAULT_SECTIONS_OPEN },
    basemapId: DEFAULT_BASEMAP_ID,
    basemap3dQuality: 'slow-040',
    toggles: {
      labelsEnabled: false,
      contourLinesEnabled: false,
      slopesEnabled: false,
      altitudeEnabled: false,
      weatherEnabled: false,
      windEnabled: false,
      snowEnabled: false,
      sunlightEnabled: false,
    },
    sunlightMapExpanded: false,
    contourLines: {
      interval: '200m',
      opacity: 100,
    },
    routes: {
      traceWidthPx: 8,
    },
    weather: undefined,
  };
}