import type {
  AnalysisPanelState,
  Itinerary,
  ItineraryProject,
  RhythmState,
  TimelineItem,
} from '../../types';
import { translateAppText } from '@/shared/i18n';
import { createDefaultControlPanelPersistedState } from '../../../controlPanel/lib/persistedState';
import { createDefaultExpertState } from '../../expert/defaults';

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
    startTime: null,
    gender: 'default',
    usePastActivities: false,
    ftp: null,
    systemWeightKg: null,
    tiresMm: null,
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
    poiPauseDurations: {
      ...base.poiPauseDurations,
      ...(rhythm?.poiPauseDurations ?? {}),
    },
    pauseIntervals: Array.isArray(rhythm?.pauseIntervals) ? rhythm.pauseIntervals : base.pauseIntervals,
    pausePositionOverridesKm: rhythm?.pausePositionOverridesKm ?? {},
  };
}

export function normalizeItineraryProject(project: ItineraryProject): ItineraryProject {
  return {
    ...project,
    itineraries: project.itineraries.map((itinerary) => ({
      ...itinerary,
      rhythm: normalizeItineraryRhythmState(itinerary.rhythm),
    })),
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
    poi: {
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
      refineResults: true,
      refineLimitPerKm: 4,
    },
    timeline: [DEFAULT_TIMELINE_START, DEFAULT_TIMELINE_END],
    expertProfile: createDefaultExpertState(),
    visible: true,
    analysisVisible: true,
  };
}

export function createDefaultAnalysisPanelState(): AnalysisPanelState {
  return {
    xMode: 'distance',
    axis1: 'Vitesse',
    axis2: 'Puissance',
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
  };
}

export function createDefaultProject(): ItineraryProject {
  const it = createDefaultItinerary(1);
  return {
    name: translateAppText('Nouveau projet'),
    savedAt: null,
    sizeBytes: null,
    privacy: 'private',
    itineraries: [it],
    activeItineraryId: it.id,
    activeMode: 'tracage',
    timelineView: 'sheet',
    controlPanel: createDefaultControlPanelPersistedState(),
    analysis: createDefaultAnalysisPanelState(),
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
