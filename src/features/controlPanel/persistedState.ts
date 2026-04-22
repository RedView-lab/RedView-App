import type { WeatherState } from './types';

export type ControlPanelSectionKey =
  | 'basemaps'
  | 'lidarTiles'
  | 'labels'
  | 'routes'
  | 'slopes'
  | 'altitude'
  | 'weather'
  | 'wind'
  | 'sunlight';

export type ControlPanelSectionsOpenState = Record<ControlPanelSectionKey, boolean>;

export interface ControlPanelPersistedState {
  sectionsOpen: ControlPanelSectionsOpenState;
  toggles: {
    labelsEnabled: boolean;
    slopesEnabled: boolean;
    altitudeEnabled: boolean;
    weatherEnabled: boolean;
    windEnabled: boolean;
    snowEnabled: boolean;
    sunlightEnabled: boolean;
  };
  sunlightMapExpanded: boolean;
  weather?: WeatherState;
}

const DEFAULT_SECTIONS_OPEN: ControlPanelSectionsOpenState = {
  basemaps: false,
  lidarTiles: false,
  labels: false,
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
    toggles: {
      labelsEnabled: false,
      slopesEnabled: false,
      altitudeEnabled: false,
      weatherEnabled: false,
      windEnabled: false,
      snowEnabled: false,
      sunlightEnabled: false,
    },
    sunlightMapExpanded: false,
    weather: undefined,
  };
}