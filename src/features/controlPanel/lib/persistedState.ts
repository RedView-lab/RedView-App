import type { LabelCategory } from '@/features/labels/types';
import { LABEL_CATEGORIES } from '@/features/labels/lib/label-config';
import type { AnalysisZone } from '@/features/analysisZone';
import type { PersistedAltitudeBreakpoints } from '@/features/altitude/lib/altitude-persist';
import type { AltitudeState } from '@/features/altitude/types';
import type { PersistedBreakpoints } from '@/features/slope/lib/slope-persist';
import type { SlopeState } from '@/features/slope/types';
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
    routesEnabled: boolean;
  };
  sunlightMapExpanded: boolean;
  /**
   * Single user-drawn polygon focusing the terrain widgets (slopes /
   * altitude / sunlight). The terrain widgets are zone-gated: without a zone
   * they stay off. Synced with the project via AnalysisZoneProjectBridge.
   */
  analysisZone?: AnalysisZone | null;
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

/**
 * Default label categories for a brand-new project.
 *
 * Without an explicit `labelsState`, `useOverlayLabelsState` falls back to the
 * GLOBAL `redview_label_prefs` localStorage entry — i.e. whatever categories
 * the user last toggled in a *previous* project. A new project must always
 * start with labels ON, so the defaults are materialised here from the label
 * config instead of being inherited.
 */
function buildDefaultLabelBackend(): Record<LabelCategory, boolean> {
  const backend = {} as Record<LabelCategory, boolean>;
  for (const category of LABEL_CATEGORIES) {
    backend[category.id] = category.defaultEnabled;
  }
  return backend;
}

/**
 * Default control-panel state for a brand-new project.
 *
 * Product defaults once a project is created:
 * - Basemap: satellite, 30 m resolution (`fast-30m`).
 * - Labels ON; contours / slopes / altitude / weather / wind / snow / sunlight OFF.
 * - Every collapsible section starts collapsed.
 */
export function createDefaultControlPanelPersistedState(): ControlPanelPersistedState {
  const labelBackend = buildDefaultLabelBackend();

  return {
    sectionsOpen: { ...DEFAULT_SECTIONS_OPEN },
    basemapId: 'satellite',
    basemap3dQuality: 'fast-30m',
    toggles: {
      labelsEnabled: true,
      contourLinesEnabled: false,
      slopesEnabled: false,
      altitudeEnabled: false,
      weatherEnabled: false,
      windEnabled: false,
      snowEnabled: false,
      sunlightEnabled: false,
      routesEnabled: true,
    },
    sunlightMapExpanded: false,
    labelsState: {
      backend: labelBackend,
      statesUiEnabled: labelBackend.states,
    },
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