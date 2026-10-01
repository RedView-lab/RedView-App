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
import { normalizeDiscipline } from '@/shared/lib/discipline';
import { createDefaultControlPanelPersistedState } from '../../../controlPanel/lib/persistedState';
import { DEFAULT_VIEW } from '../../../map3d/lib/mapbox.config';
import { createDefaultExpertState } from '../../expert/defaults';
import { cleanAndInterpolateElevations, hasCorruptedElevations } from '../route-metrics';
import { buildImportedRouteMetrics } from '../routes';
import { HIDDEN_PANEL_POI_CATEGORIES } from './poiRows';

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

/** Distance max. d'un POI à la trace (m) par défaut ; l'utilisateur peut élargir par catégorie. */
export const DEFAULT_POI_DISTANCE_M = 20;
/**
 * Ancien défaut. Un état POI dont toutes les distances valent encore
 * exactement 40 m n'a jamais été réglé : il passe au nouveau défaut.
 */
const LEGACY_DEFAULT_POI_DISTANCE_M = 40;

export function createDefaultPoiState(): PoiState {
  const distanceM = DEFAULT_POI_DISTANCE_M;
  return {
    fountains: { enabled: true, distanceM },
    toilets: { enabled: true, distanceM },
    supermarkets: { enabled: true, distanceM },
    gasStations: { enabled: true, distanceM },
    bakeries: { enabled: true, distanceM },
    fastFood: { enabled: true, distanceM },
    cafes: { enabled: true, distanceM },
    bars: { enabled: true, distanceM },
    restaurants: { enabled: true, distanceM },
    bikeShops: { enabled: true, distanceM },
    hotels: { enabled: true, distanceM },
    refuges: { enabled: true, distanceM },
    passes: { enabled: false, distanceM },
    health: { enabled: false, distanceM },
    transport: { enabled: false, distanceM },
  };
}

/**
 * État POI d'un itinéraire importé depuis un GPX : toutes les lignes exposées
 * dans l'UI sont cochées, les catégories masquées restent désactivées.
 */
export function createImportedPoiState(): PoiState {
  const state = createDefaultPoiState();
  for (const key of ALL_POI_CATEGORIES) {
    state[key] = { ...state[key], enabled: !HIDDEN_PANEL_POI_CATEGORIES.has(key) };
  }
  return state;
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
  if (ALL_POI_CATEGORIES.every((key) => normalized[key].distanceM === LEGACY_DEFAULT_POI_DISTANCE_M)) {
    for (const key of ALL_POI_CATEGORIES) {
      normalized[key] = { ...normalized[key], distanceM: DEFAULT_POI_DISTANCE_M };
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

/**
 * Durées de pause par défaut aux POI favoris (minutes). `null` = catégorie
 * décochée dans la grille « pauses par POI ». Sert aussi de valeur de repli
 * quand l'utilisateur recoche une catégorie.
 */
export const DEFAULT_POI_PAUSE_DURATIONS: Readonly<Record<PoiCategory, number | null>> = {
  fountains: 10,
  toilets: null,
  supermarkets: null,
  gasStations: null,
  bakeries: 15,
  fastFood: null,
  cafes: null,
  bars: null,
  restaurants: 30,
  bikeShops: null,
  hotels: 360,
  refuges: null,
  passes: null,
  health: null,
  transport: null,
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
    poiPauseDurations: { ...DEFAULT_POI_PAUSE_DURATIONS },
    pauseEveryIntervalEnabled: false,
    pauseEveryIntervalMin: null,
    pauseIntervals: [],
    pausePositionOverridesKm: {},
    runReferenceMode: 'vma',
    vmaKmh: null,
    refRaceDistanceM: 10000,
    refRaceTimeS: null,
    runWeightKg: null,
    terrainTechnicality: 0.5,
  };
}

function positiveOrNull(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : null;
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
    runReferenceMode: rhythm?.runReferenceMode === 'chrono' ? 'chrono' : 'vma',
    vmaKmh: positiveOrNull(rhythm?.vmaKmh),
    refRaceDistanceM: positiveOrNull(rhythm?.refRaceDistanceM) ?? base.refRaceDistanceM,
    refRaceTimeS: positiveOrNull(rhythm?.refRaceTimeS),
    runWeightKg: positiveOrNull(rhythm?.runWeightKg),
    terrainTechnicality:
      typeof rhythm?.terrainTechnicality === 'number' && Number.isFinite(rhythm.terrainTechnicality)
        ? Math.min(1, Math.max(0, rhythm.terrainTechnicality))
        : base.terrainTechnicality,
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

    const profileId =
      itinerary.profileId ||
      (itinerary.roadTypes?.activityType && ROUTE_PROFILE_PRESETS[itinerary.roadTypes.activityType]
        ? itinerary.roadTypes.activityType
        : 'road');
    const roadTypes = itinerary.roadTypes
      ? {
          ...itinerary.roadTypes,
          activityType: itinerary.roadTypes.activityType || profileId,
          tracingMode: itinerary.roadTypes.tracingMode || 'vitesse',
        }
      : {
          ...ROUTE_PROFILE_PRESETS['road'].roadTypes,
          applyToAllItineraries: false,
        };

    return {
      ...itinerary,
      profileId,
      discipline: normalizeDiscipline(itinerary.discipline),
      roadTypes,
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
  const defaultPreset = ROUTE_PROFILE_PRESETS['road'];
  return {
    id: `it-${Date.now()}-${index}`,
    name: translateAppText('Itinéraire {{index}}', { index }),
    color,
    profileId: defaultPreset.id,
    discipline: 'bike',
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
      pente: true,
      jourNuit: false,
      alertes: true,
      slopeColors: false,
    },
    surfaceFilter: 'all',
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
