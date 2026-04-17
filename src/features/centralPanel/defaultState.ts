/**
 * Defaults for the Central Panel — the shape rendered "at the start of a
 * session", before any routing / weather computation has run.
 *
 * Kept separate from the view so the container or tests can construct an
 * empty panel without importing React.
 */

import type {
  AnalysisAxisYMetric,
  CentralPanelItinerary,
  CentralPanelUiState,
  ChartOverlay,
} from './types';

export const ITINERARY_PALETTE = [
  '#c50000',
  '#ff8a3d',
  '#ffd13a',
  '#5ab95a',
  '#3d8bff',
  '#9b59ff',
] as const;

export const PRIMARY_METRIC_OPTIONS: {
  value: AnalysisAxisYMetric;
  label: string;
  unit: string;
}[] = [
  { value: 'elevation', label: 'Dénivelé', unit: 'm' },
  { value: 'slope', label: 'Pente', unit: '%' },
  { value: 'speed', label: 'Vitesse', unit: 'km/h' },
  { value: 'power', label: 'Puissance', unit: 'W' },
  { value: 'heartrate', label: 'FC', unit: 'bpm' },
];

export const SECONDARY_METRIC_OPTIONS: {
  value: AnalysisAxisYMetric;
  label: string;
  unit: string;
}[] = [
  { value: 'temperature', label: 'Température', unit: '°' },
  { value: 'humidity', label: 'Humidité', unit: '%' },
  { value: 'wind', label: 'Vent', unit: 'km/h' },
  { value: 'slope', label: 'Pente', unit: '%' },
];

export const OVERLAY_LABELS: Record<ChartOverlay, string> = {
  waypoint: 'Waypoint',
  poi: 'POI',
  pause: 'Pause',
  alerts: 'Alertes',
  slope: 'Pente',
  daynight: 'Jour/nuit',
};

export const DEFAULT_UI_STATE: CentralPanelUiState = {
  axis1: 'distance',
  axis1Mode: 'distance',
  primaryMetric: 'elevation',
  secondaryMetric: 'temperature',
  detail: 0.5,
  overlays: {
    waypoint: true,
    poi: true,
    pause: true,
    alerts: true,
    slope: true,
    daynight: true,
  },
  zoomRangeKm: null,
};

/**
 * Build an empty itinerary view-model — used when an itinerary has been
 * created in the left panel but its route hasn't been solved yet.
 */
export function createEmptyItinerary(
  id: string,
  name: string,
  color: string,
): CentralPanelItinerary {
  return {
    id,
    name,
    color,
    visible: true,
    stats: {
      distanceKm: null,
      durationSec: null,
      elevationGainM: null,
      elevationLossM: null,
      avgSlopePercent: null,
      surface: {
        tarmac: null,
        gravel: null,
        offroad: null,
      },
    },
    primary: [],
    secondary: [],
    temperaturesC: [],
  };
}
