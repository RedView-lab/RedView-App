import type { PrioritiesState, RoadTypesState, RouteProfile } from '../../types';
import { translateAppText } from '@/shared/i18n';

export interface RouteProfilePreset {
  id: string;
  name: string;
  isDefault?: boolean;
  priorities: PrioritiesState;
  roadTypes: Omit<RoadTypesState, 'applyToAllItineraries'>;
}

export const ROUTE_PROFILE_PRESETS: Record<string, RouteProfilePreset> = {
  road: {
    id: 'road',
    name: translateAppText('Route'),
    priorities: {
      duration: 70,
      elevation: 40,
      distance: 65,
      tranquility: 40,
    },
    roadTypes: {
      activityType: 'road',
      tracingMode: 'vitesse',
      surfacePreference: 'tarmac',
      surfaceMin: 'tarmac',
      surfaceMax: 'tarmac',
      surfaceTolerance: 10,
      elevationPreference: 'avoid',
      road: 'prefer',
      gravel: 'forbid',
      singletrack: 'forbid',
      offroad: 'forbid',
      bikeLanes: 'prefer',
      majorRoads: 'avoid',
      woods: 'tolerate',
      ferry: 'tolerate',
      turns: 'tolerate',
      maxSlopePercent: 12,
      cities: 'tolerate',
    },
  },
  'gravel-default': {
    id: 'gravel-default',
    name: translateAppText('Gravel'),
    isDefault: true,
    priorities: {
      duration: 50,
      elevation: 50,
      distance: 50,
      tranquility: 70,
    },
    roadTypes: {
      activityType: 'gravel-default',
      tracingMode: 'vitesse',
      surfacePreference: 'gravel',
      surfaceMin: 'tarmac',
      surfaceMax: 'gravel',
      surfaceTolerance: 10,
      elevationPreference: 'avoid',
      road: 'avoid',
      gravel: 'prefer',
      singletrack: 'tolerate',
      offroad: 'forbid',
      bikeLanes: 'tolerate',
      majorRoads: 'avoid',
      woods: 'prefer',
      ferry: 'tolerate',
      turns: 'avoid',
      maxSlopePercent: 15,
      cities: 'avoid',
    },
  },
  mtb: {
    id: 'mtb',
    name: translateAppText('VTT'),
    priorities: {
      duration: 60,
      elevation: 35,
      distance: 55,
      tranquility: 80,
    },
    roadTypes: {
      activityType: 'mtb',
      tracingMode: 'vitesse',
      surfacePreference: 'other',
      surfaceMin: 'paved',
      surfaceMax: 'other',
      surfaceTolerance: 10,
      elevationPreference: 'avoid',
      road: 'avoid',
      gravel: 'prefer',
      singletrack: 'prefer',
      offroad: 'tolerate',
      bikeLanes: 'avoid',
      majorRoads: 'forbid',
      woods: 'prefer',
      ferry: 'tolerate',
      turns: 'avoid',
      maxSlopePercent: 25,
      cities: 'avoid',
    },
  },
};

export const DEFAULT_PROFILES: RouteProfile[] = [
  { id: 'road', name: translateAppText('Route') },
  { id: 'gravel-default', name: translateAppText('Gravel'), isDefault: true },
  { id: 'mtb', name: translateAppText('VTT') },
];

export function getProfilePreset(profileId: string): RouteProfilePreset | undefined {
  return ROUTE_PROFILE_PRESETS[profileId];
}

export const PRIORITY_KEYS: (keyof PrioritiesState)[] = ['duration', 'elevation', 'distance', 'tranquility'];
export const ROAD_TYPE_KEYS: (keyof Omit<RoadTypesState, 'applyToAllItineraries'>)[] = [
  'road',
  'gravel',
  'singletrack',
  'offroad',
  'bikeLanes',
  'majorRoads',
  'ferry',
  'turns',
  'maxSlopePercent',
  'cities',
  'elevationPreference',
  'woods',
  'surfacePreference',
  'surfaceMin',
  'surfaceMax',
  'surfaceTolerance',
  'tracingMode',
];

export function isRoadTypesMatching(
  current: Partial<RoadTypesState>,
  target: Partial<RoadTypesState>,
): boolean {
  for (const k of ROAD_TYPE_KEYS) {
    if (current[k] !== target[k]) {
      return false;
    }
  }
  return true;
}

export function matchesProfilePreset(
  profileId: string,
  priorities: PrioritiesState,
  roadTypes: RoadTypesState,
): boolean {
  const preset = ROUTE_PROFILE_PRESETS[profileId];
  if (!preset) return false;

  for (const k of PRIORITY_KEYS) {
    if (priorities[k] !== preset.priorities[k]) return false;
  }

  return isRoadTypesMatching(roadTypes, preset.roadTypes);
}

export function resolveProfilePresetId(
  priorities: PrioritiesState,
  roadTypes: RoadTypesState,
  currentProfileId?: string,
): string {
  if (
    currentProfileId &&
    currentProfileId !== 'custom' &&
    matchesProfilePreset(currentProfileId, priorities, roadTypes)
  ) {
    return currentProfileId;
  }

  for (const [id] of Object.entries(ROUTE_PROFILE_PRESETS)) {
    if (matchesProfilePreset(id, priorities, roadTypes)) {
      return id;
    }
  }

  return 'custom';
}

