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
  mtb: {
    id: 'mtb',
    name: translateAppText('VTT'),
    priorities: {
      duration: 35,
      elevation: 30,
      distance: 40,
      tranquility: 90,
    },
    roadTypes: {
      road: 'avoid',
      gravel: 'prefer',
      singletrack: 'prefer',
      offroad: 'tolerate',
      bikeLanes: 'avoid',
      majorRoads: 'forbid',
      ferry: 'tolerate',
      turns: 'tolerate',
      maxSlopePercent: 25,
      cities: 'avoid',
    },
  },
  'gravel-default': {
    id: 'gravel-default',
    name: translateAppText('Gravel (défaut)'),
    isDefault: true,
    priorities: {
      duration: 50,
      elevation: 50,
      distance: 50,
      tranquility: 70,
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
  },
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
      road: 'prefer',
      gravel: 'forbid',
      singletrack: 'forbid',
      offroad: 'forbid',
      bikeLanes: 'prefer',
      majorRoads: 'avoid',
      ferry: 'tolerate',
      turns: 'tolerate',
      maxSlopePercent: 15,
      cities: 'tolerate',
    },
  },
};

export const DEFAULT_PROFILES: RouteProfile[] = [
  { id: 'mtb', name: translateAppText('VTT') },
  { id: 'gravel-default', name: translateAppText('Gravel (défaut)'), isDefault: true },
  { id: 'road', name: translateAppText('Route') },
  { id: 'custom', name: translateAppText('Personnalisé') },
];

export function getProfilePreset(profileId: string): RouteProfilePreset | undefined {
  return ROUTE_PROFILE_PRESETS[profileId];
}

const PRIORITY_KEYS: (keyof PrioritiesState)[] = ['duration', 'elevation', 'distance', 'tranquility'];
const ROAD_TYPE_KEYS: (keyof Omit<RoadTypesState, 'applyToAllItineraries'>)[] = [
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
];

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

  for (const k of ROAD_TYPE_KEYS) {
    if (roadTypes[k] !== preset.roadTypes[k]) return false;
  }

  return true;
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
