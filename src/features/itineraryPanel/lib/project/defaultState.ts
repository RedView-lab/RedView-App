import type {
  AnalysisPanelState,
  Itinerary,
  ItineraryProject,
  PoiCategory,
  PoiState,
  RhythmState,
  TimelineItem,
} from '../../types';
import { translateAppText } from '@/shared/i18n';
import { createDefaultControlPanelPersistedState } from '../../../controlPanel/lib/persistedState';
import { DEFAULT_VIEW } from '../../../map3d/lib/mapbox.config';
import { createDefaultExpertState } from '../../expert/defaults';
import { cleanAndInterpolateElevations, hasCorruptedElevations } from '../route-metrics';
import { buildImportedRouteMetrics } from '../routes';

export const ALL_POI_CATEGORIES: PoiCategory[] = [
  'fountains',
  'toilets',
  'supermarkets',
  'gasStations',
  'bakeries',
  'fastFood',
  'cafes',
  'bars',
  'restaurants',
  'bikeShops',
  'hotels',
  'refuges',
  'passes',
  'health',
  'transport',
];

export function createDefaultPoiState(): PoiState {
  return {
    fountains: { enabled: true, distanceM: 40 },
    toilets: { enabled: true, distanceM: 40 },
    supermarkets: { enabled: true, distanceM: 40 },
    gasStations: { enabled: true, distanceM: 40 },
    bakeries: { enabled: true, distanceM: 40 },
    fastFood: { enabled: true, distanceM: 40 },
    cafes: { enabled: true, distanceM: 40 },
    bars: { enabled: true, distanceM: 40 },
    restaurants: { enabled: true, distanceM: 40 },
    bikeShops: { enabled: true, distanceM: 40 },
    hotels: { enabled: true, distanceM: 40 },
    refuges: { enabled: true, distanceM: 40 },
    passes: { enabled: false, distanceM: 40 },
    health: { enabled: false, distanceM: 40 },
    transport: { enabled: false, distanceM: 40 },
  };
}

export function normalizeItineraryPoiState(poi?: Partial<PoiState> | null): PoiState {
  const base = createDefaultPoiState();
  if (!poi || typeof poi !== 'object') return base;
  const normalized: PoiState = { ...base };
  for (const key of ALL_POI_CATEGORIES) {
    const raw = poi[key];
    if (raw && typeof raw === 'object') {
      const enabled = typeof raw.enabled === 'boolean' ? raw.enabled : base[key].enabled;
      const distanceM =
        typeof raw.distanceM === 'number' && Number.isFinite(raw.distanceM) && raw.distanceM >= 0
          ? raw.distanceM
          : base[key].distanceM;
      normalized[key] = { enabled, distanceM };
    }
  }
  return normalized;
}

/**
 * Defaults for a brand-new session ("début d'utilisation").
 *
 * Rules applied (inferred from the Figma dev notes):
 * - No project has been saved yet → `savedAt` & `sizeBytes` are null.
 * - Title placeholder is "Nouveau projet".
 * - A single default itinerary exists ("Itinéraire 1") with empty data.
 * - Priorities are centered (50 / 100).
 * - Road-type selects match the Figma defaults (Éviter / Prioriser / …).
 * - Rhythm is empty: no date / no time, checkboxes off, inputs empty.
 * - Timeline only contains a Départ and Fin placeholder row.
 */

export const ITINERARY_COLORS = [
  '#c50000',
  '#ff8a3d',
  '#ffd13a',
  '#5ab95a',
  '#3d8bff',
  '#9b59ff',
] as const;

export { DEFAULT_PROFILES, ROUTE_PROFILE_PRESETS } from './profilePresets';
import { ROUTE_PROFILE_PRESETS } from './profilePresets';

const DEFAULT_TIMELINE_START: TimelineItem = {
  id: 'start',
  kind: 'start',
  label: translateAppText('Rechercher un lieu'),
  distanceKm: 0,
};
const DEFAULT_TIMELINE_END: TimelineItem = {
  id: 'end',
  kind: 'end',
  label: translateAppText('Rechercher un lieu'),
  distanceKm: null,
};

export function createDefaultRhythmState(): RhythmState {
  return {
    startDate: null,
    startTime: '09:30',
    gender: 'default',
    practiceLevel: 'debutant',
    applyToAllItineraries: false,
    usePastActivities: false,
    ftp: null,
    systemWeightKg: null,
    tiresMm: 35,
    useWeather: false,
    weatherWeight: 100,
    useSurfaces: false,
    surfacesWeight: 100,
    pauseAtFavoritePois: false,
    poiPauseDurations: {
      fountains: 15,
      toilets: null,
      supermarkets: 15,
      gasStations: null,
      bakeries: 15,
      fastFood: null,
      cafes: null,
      bars: null,
      restaurants: 15,
      bikeShops: null,
      hotels: 15,
      refuges: 15,
      passes: null,
      health: null,
      transport: null,
    },
    pauseEveryIntervalEnabled: false,
    pauseEveryIntervalMin: null,
    pauseIntervals: [],
    pausePositionOverridesKm: {},
  };
}

export function normalizeItineraryRhythmState(rhythm?: Partial<RhythmState> | null): RhythmState {
  const base = createDefaultRhythmState();
  return {
    ...base,
    ...rhythm,
    startTime: rhythm?.startTime ?? base.startTime ?? '09:30',
    poiPauseDurations: {
      ...base.poiPauseDurations,
      ...(rhythm?.poiPauseDurations ?? {}),
    },
    pauseIntervals: Array.isArray(rhythm?.pauseIntervals) ? rhythm.pauseIntervals : base.pauseIntervals,
    pausePositionOverridesKm: rhythm?.pausePositionOverridesKm ?? {},
  };
}

export function normalizeItineraryProject(project: ItineraryProject): ItineraryProject {
  const itineraries = project.itineraries.map((itinerary) => {
    let gpxRoute = itinerary.gpxRoute;
    let metrics = itinerary.metrics;

    if (gpxRoute && gpxRoute.points.length > 0) {
      const needsCleaning =
        hasCorruptedElevations(gpxRoute.points) ||
        (gpxRoute.originalPoints != null && hasCorruptedElevations(gpxRoute.originalPoints));

      if (needsCleaning) {
        const cleanedPoints = cleanAndInterpolateElevations(gpxRoute.points);
        const cleanedOriginalPoints = gpxRoute.originalPoints
          ? cleanAndInterpolateElevations(gpxRoute.originalPoints)
          : undefined;

        gpxRoute = {
          ...gpxRoute,
          points: cleanedPoints,
          ...(cleanedOriginalPoints ? { originalPoints: cleanedOriginalPoints } : {}),
        };
        metrics = buildImportedRouteMetrics(cleanedPoints);
      }
    }

    return {
      ...itinerary,
      gpxRoute,
      metrics,
      poi: normalizeItineraryPoiState(itinerary.poi),
      rhythm: normalizeItineraryRhythmState(itinerary.rhythm),
    };
  });

  const activeExists = itineraries.some((it) => it.id === project.activeItineraryId);
  const activeItineraryId = activeExists
    ? project.activeItineraryId
    : (itineraries[0]?.id ?? '');

  return {
    ...project,
    itineraries,
    activeItineraryId,
  };
}

export function createDefaultItinerary(
  index = 1,
  color: string = ITINERARY_COLORS[0],
): Itinerary {
  const defaultPreset = ROUTE_PROFILE_PRESETS['gravel-default'];
  return {
    id: `it-${Date.now()}-${index}`,
    name: translateAppText('Itinéraire {{index}}', { index }),
    color,
    profileId: defaultPreset.id,
    priorities: { ...defaultPreset.priorities },
    roadTypes: {
      ...defaultPreset.roadTypes,
      applyToAllItineraries: false,
    },
    rhythm: createDefaultRhythmState(),
    poi: createDefaultPoiState(),
    timeline: [DEFAULT_TIMELINE_START, DEFAULT_TIMELINE_END],
    expertProfile: createDefaultExpertState(),
    visible: true,
    analysisVisible: true,
  };
}

export function createDefaultAnalysisPanelState(): AnalysisPanelState {
  return {
    xMode: 'distance',
    // Default to a plain elevation profile with Axis 2 disabled.
    // Users can enable Axis 2 (speed, power, temp, etc.) from the chart toolbar.
    axis1: 'Altitude',
    axis2: null,
    filters: {
      waypoint: true,
      poi: true,
      pause: true,
      alertes: true,
      pente: true,
      jourNuit: true,
    },
    detailZoom: 0,
    detailOffset: 0,
    yZoom: 0,
    yOffset: 0,
  };
}

/**
 * Default project for a freshly created project.
 *
 * Product rules for a brand-new project:
 * - The itinerary list starts EMPTY: the user creates their own
 *   itineraries / variants / imports from the itinerary menu.
 * - Consequently the itinerary menu below it (tracage / rythme / POI) has
 *   nothing to edit, so it is disabled, collapsed and unselected (see
 *   `activeMode` below and the `disabled` handling in the panel).
 * - The central panel stays hidden until the first trace lands.
 * - The map camera is seeded with DEFAULT_VIEW (wide France overview).
 *   `useDashboardChrome.resolveProjectViewport` re-applies the same
 *   wide-France fallback for any project without a saved viewport, so a new
 *   project can never inherit the camera of the previously opened one.
 */
export function createDefaultProject(): ItineraryProject {
  return {
    name: translateAppText('Nouveau projet'),
    savedAt: null,
    sizeBytes: null,
    privacy: 'private',
    itineraries: [],
    activeItineraryId: '',
    activeMode: 'tracage',
    timelineView: 'sheet',
    controlPanel: createDefaultControlPanelPersistedState(),
    analysis: createDefaultAnalysisPanelState(),
    dashboard: {
      mapViewport: {
        center: [...DEFAULT_VIEW.center],
        zoom: DEFAULT_VIEW.zoom,
        pitch: DEFAULT_VIEW.pitch,
        bearing: DEFAULT_VIEW.bearing,
      },
    },
  };
}

/**
 * True if a project already contains traced content — i.e. the user has started
 * drawing (the active itinerary's start point is placed) or has loaded a route
 * (gpxRoute with points). Used to decide whether the analysis table / docked
 * panels should start expanded or collapsed.
 */
export function hasProjectTracedContent(project: ItineraryProject | null | undefined): boolean {
  if (!project) return false;
  for (const itinerary of project.itineraries) {
    if (itinerary.gpxRoute && itinerary.gpxRoute.points.length > 0) return true;
    const start = itinerary.timeline.find((row) => row.kind === 'start');
    if (start && start.lat != null && start.lon != null) return true;
  }
  return false;
}
