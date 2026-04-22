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
}

const DEFAULT_SECTIONS_OPEN: ControlPanelSectionsOpenState = {
  basemaps: true,
  lidarTiles: true,
  labels: true,
  routes: true,
  slopes: true,
  altitude: true,
  weather: true,
  wind: true,
  sunlight: true,
};

export function createDefaultControlPanelPersistedState(): ControlPanelPersistedState {
  return {
    sectionsOpen: { ...DEFAULT_SECTIONS_OPEN },
    toggles: {
      labelsEnabled: true,
      slopesEnabled: true,
      altitudeEnabled: true,
      weatherEnabled: true,
      windEnabled: true,
      snowEnabled: true,
      sunlightEnabled: true,
    },
    sunlightMapExpanded: true,
  };
}