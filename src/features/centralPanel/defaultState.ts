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
  ChartMarker,
  ChartOverlay,
  DayNightBand,
  ProfileSample,
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

/**
 * Sample itineraries used as a visual placeholder while the routing engine
 * is not yet wired to the dashboard. Mirrors the Figma "SYNTHESIS" mock
 * (1036:17515) so the panel feels alive in the meantime.
 */
export const SAMPLE_ITINERARIES: CentralPanelItinerary[] = [
  {
    id: 'sample-1',
    name: 'Itinéraire 1',
    color: ITINERARY_PALETTE[0],
    visible: true,
    stats: {
      distanceKm: 12.78,
      durationSec: 23,
      elevationGainM: 346,
      elevationLossM: 33,
      avgSlopePercent: 7,
      surface: { tarmac: 7, gravel: 7, offroad: 7 },
    },
    primary: [],
    secondary: [],
    temperaturesC: [],
  },
  {
    id: 'sample-2',
    name: 'Variante 2',
    color: ITINERARY_PALETTE[1],
    visible: true,
    stats: {
      distanceKm: 12.78,
      durationSec: 23,
      elevationGainM: 346,
      elevationLossM: 33,
      avgSlopePercent: 7,
      surface: { tarmac: 7, gravel: 7, offroad: 7 },
    },
    primary: [],
    secondary: [],
    temperaturesC: [],
  },
  {
    id: 'sample-3',
    name: 'GPX Jerem',
    color: ITINERARY_PALETTE[2],
    visible: true,
    stats: {
      distanceKm: 12.78,
      durationSec: 23,
      elevationGainM: 346,
      elevationLossM: 33,
      avgSlopePercent: 7,
      surface: { tarmac: 7, gravel: 7, offroad: 7 },
    },
    primary: [],
    secondary: [],
    temperaturesC: [],
  },
];

/* -------------------------------------------------------------------------- */
/* Demo curves — Figma 1688:22814 placeholder. Remove once the routing       */
/* engine starts feeding real samples through the container props.            */
/* -------------------------------------------------------------------------- */

const DEMO_TOTAL_KM = 95;
const DEMO_SAMPLES = 200;
const DEMO_TEMP_BINS = 11;

function buildElevation(seed: number, base: number, amp: number): ProfileSample[] {
  const out: ProfileSample[] = [];
  for (let i = 0; i < DEMO_SAMPLES; i += 1) {
    const x = (i / (DEMO_SAMPLES - 1)) * DEMO_TOTAL_KM;
    const y =
      base +
      amp * Math.sin(x * 0.08 + seed) +
      (amp * 0.5) * Math.cos(x * 0.21 + seed * 1.3) +
      (amp * 0.25) * Math.sin(x * 0.55 + seed * 0.7);
    out.push({ x, y: Math.max(0, y) });
  }
  return out;
}

function buildTemperature(seed: number, base: number, amp: number): ProfileSample[] {
  const out: ProfileSample[] = [];
  for (let i = 0; i < DEMO_SAMPLES; i += 1) {
    const x = (i / (DEMO_SAMPLES - 1)) * DEMO_TOTAL_KM;
    const y = base + amp * Math.sin(x * 0.04 + seed) + (amp * 0.3) * Math.cos(x * 0.18 + seed);
    out.push({ x, y });
  }
  return out;
}

function buildBins(): (number | null)[] {
  return Array.from({ length: DEMO_TEMP_BINS }, () => 17);
}

/**
 * Same itineraries as SAMPLE_ITINERARIES but populated with synthetic
 * elevation, temperature and per-bin temperature data so the chart card
 * looks alive in the dashboard before the routing engine is wired in.
 */
export const SAMPLE_ITINERARIES_WITH_CURVES: CentralPanelItinerary[] = [
  {
    ...SAMPLE_ITINERARIES[0],
    stats: {
      ...SAMPLE_ITINERARIES[0].stats,
      distanceKm: 127.23,
      elevationGainM: 839,
      elevationLossM: 420,
      durationSec: 2 * 3600 + 48 * 60 + 59,
    },
    primary: buildElevation(0, 1100, 600),
    secondary: buildTemperature(0, 16, 6),
    temperaturesC: buildBins(),
  },
  {
    ...SAMPLE_ITINERARIES[1],
    stats: {
      ...SAMPLE_ITINERARIES[1].stats,
      distanceKm: 127.23,
      elevationGainM: 1232,
      elevationLossM: 339,
      durationSec: 2 * 3600 + 31 * 60 + 19,
    },
    primary: buildElevation(1.7, 1500, 700),
    secondary: buildTemperature(2.1, 18, 5),
    temperaturesC: buildBins(),
  },
  {
    ...SAMPLE_ITINERARIES[2],
    stats: {
      ...SAMPLE_ITINERARIES[2].stats,
      distanceKm: 127.23,
      elevationGainM: 1232,
      elevationLossM: 339,
      durationSec: 2 * 3600 + 31 * 60 + 19,
    },
    primary: buildElevation(3.4, 1300, 500),
    secondary: buildTemperature(4.0, 17, 4),
    temperaturesC: buildBins(),
  },
];

/** Water-droplet markers placed along the demo curves. */
export const SAMPLE_MARKERS: ChartMarker[] = [
  { id: 'd1', itineraryId: 'sample-1', kind: 'waypoint', x: 16 },
  { id: 'd2', itineraryId: 'sample-1', kind: 'waypoint', x: 24 },
  { id: 'd3', itineraryId: 'sample-2', kind: 'waypoint', x: 40 },
];

/** Two day bands matching the orange overlays in the Figma reference. */
export const SAMPLE_DAYNIGHT: DayNightBand[] = [
  { itineraryId: 'sample-1', kind: 'day', fromX: 7, toX: 32 },
  { itineraryId: 'sample-1', kind: 'day', fromX: 67, toX: 87 },
];
