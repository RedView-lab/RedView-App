import type { LabelCategory } from '@/features/labels/types';
import { LABEL_CATEGORIES } from '@/features/labels/lib/label-config';
import type { AnalysisZone } from '@/features/analysisZone';
import type { PersistedAltitudeBreakpoints } from '@/features/altitude/lib/altitude-persist';
import type { AltitudeState } from '@/features/altitude/types';
import type { PersistedBreakpoints } from '@/features/slope/lib/slope-persist';
import type { SlopeState } from '@/features/slope/types';
import type { RouteDisplayQuality } from '@/features/itineraryPanel/types';
import { DEFAULT_ROUTE_TRACE_WIDTH_PX } from '@/features/itineraryPanel/lib/route-layer/constants';
import type {
  BasemapId,
  Basemap3dQualityId,
  ContourIntervalSetting,
  MapEnvironmentId,
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

interface ControlPanelLabelsPersistedState {
  backend: Record<LabelCategory, boolean>;
  statesUiEnabled: boolean;
}

interface ControlPanelSlopePersistedState {
  state: SlopeState;
  scale: SlopeScale;
  scaleSetting: SlopeScaleSetting;
  bandVisibility: Record<string, boolean>;
  customColors: Record<string, string>;
  breakpoints: PersistedBreakpoints;
}

interface ControlPanelAltitudePersistedState {
  state: AltitudeState;
  breakpoints: PersistedAltitudeBreakpoints;
}

interface ControlPanelContourLinesPersistedState {
  interval: ContourIntervalSetting;
  opacity: number;
}

interface ControlPanelRoutesPersistedState {
  traceWidthPx: number;
  /** Finesse des traces dessinées ; absente = `auto` (suit la 2D / 3D et le relief). */
  quality?: RouteDisplayQuality;
}

type ControlPanelSunlightPersistedState = Omit<
  SunlightState,
  'enabled' | 'sunriseTime' | 'sunsetTime'
>;

type ControlPanelWindPersistedState = Pick<
  WindPanelState,
  'date' | 'time' | 'forecastDay' | 'particlesEnabled' | 'terrainOverlayEnabled'
>;

export interface ControlPanelPersistedState {
  sectionsOpen: ControlPanelSectionsOpenState;
  basemapId: BasemapId;
  basemap3dQuality: Basemap3dQualityId;
  /** Scene lighting (jour / crépuscule / nuit). Absent on older projects → day. */
  mapEnvironment?: MapEnvironmentId;
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
   * Polygone unique dessiné par l'utilisateur, qui concentre les widgets de
   * terrain (pentes / altitude / ensoleillement). Le dessin de zone est
   * actuellement désactivé (le panneau de contrôle passe
   * `analysisZone: null`), donc il reste null.
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
 * Catégories d'étiquettes par défaut d'un tout nouveau projet.
 *
 * Sans `labelsState` explicite, `useOverlayLabelsState` se replie sur l'entrée
 * localStorage GLOBALE `redview_label_prefs` — c'est-à-dire les catégories que
 * l'utilisateur a basculées en dernier dans un projet *précédent*. Un nouveau
 * projet doit toujours démarrer avec les étiquettes ACTIVÉES : les valeurs par
 * défaut sont donc matérialisées ici depuis la configuration des étiquettes au
 * lieu d'être héritées.
 */
function buildDefaultLabelBackend(): Record<LabelCategory, boolean> {
  const backend = {} as Record<LabelCategory, boolean>;
  for (const category of LABEL_CATEGORIES) {
    backend[category.id] = category.defaultEnabled;
  }
  return backend;
}

/**
 * État par défaut du panneau de contrôle d'un tout nouveau projet.
 *
 * Valeurs produit à la création d'un projet :
 * - Fond de carte : satellite, résolution 30 m (`fast-30m`).
 * - Étiquettes ACTIVÉES ; courbes / pentes / altitude / météo / vent / neige / ensoleillement DÉSACTIVÉS.
 * - Toutes les sections repliables démarrent repliées.
 */
export function createDefaultControlPanelPersistedState(): ControlPanelPersistedState {
  const labelBackend = buildDefaultLabelBackend();

  return {
    sectionsOpen: { ...DEFAULT_SECTIONS_OPEN },
    basemapId: 'satellite',
    basemap3dQuality: 'fast-30m',
    mapEnvironment: 'day',
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
      traceWidthPx: DEFAULT_ROUTE_TRACE_WIDTH_PX,
    },
    weather: undefined,
  };
}