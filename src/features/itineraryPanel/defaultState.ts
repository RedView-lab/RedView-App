import type {
  Itinerary,
  ItineraryProject,
  RouteProfile,
  TimelineItem,
} from './types';

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

export const DEFAULT_PROFILES: RouteProfile[] = [
  { id: 'gravel-default', name: 'Gravel (défaut)', isDefault: true },
  { id: 'road', name: 'Route' },
  { id: 'mtb', name: 'VTT' },
  { id: 'touring', name: 'Touring' },
  { id: 'custom', name: 'Personnalisé' },
];

const DEFAULT_TIMELINE_START: TimelineItem = {
  id: 'start',
  kind: 'start',
  label: 'Rechercher un lieu',
  distanceKm: 0,
};
const DEFAULT_TIMELINE_END: TimelineItem = {
  id: 'end',
  kind: 'end',
  label: 'Rechercher un lieu',
  distanceKm: null,
};

export function createDefaultItinerary(
  index = 1,
  color: string = ITINERARY_COLORS[0],
): Itinerary {
  return {
    id: `it-${Date.now()}-${index}`,
    name: `Itinéraire ${index}`,
    color,
    profileId: 'gravel-default',
    priorities: {
      duration: 50,
      elevation: 50,
      distance: 50,
      tranquility: 50,
    },
    roadTypes: {
      road: 'avoid',
      gravel: 'prefer',
      singletrack: 'tolerate',
      offroad: 'forbid',
      bikeLanes: 'tolerate',
      majorRoads: 'avoid',
      ferry: 'tolerate',
      turns: 'avoid',
      maxSlopePercent: 20,
      cities: 'tolerate',
    },
    rhythm: {
      startDate: null,
      startTime: null,
      usePastActivities: false,
      ftp: null,
      systemWeightKg: null,
      tiresMm: null,
      useWeather: false,
      weatherWeight: 100,
      useSurfaces: false,
      surfacesWeight: 100,
      pauseAtFavoritePois: false,
      pauseEveryIntervalMin: null,
    },
    timeline: [DEFAULT_TIMELINE_START, DEFAULT_TIMELINE_END],
  };
}

export function createDefaultProject(): ItineraryProject {
  const it = createDefaultItinerary(1);
  return {
    name: 'Nouveau projet',
    savedAt: null,
    sizeBytes: null,
    privacy: 'private',
    itineraries: [it],
    activeItineraryId: it.id,
    activeMode: 'tracage',
    timelineView: 'sheet',
  };
}
