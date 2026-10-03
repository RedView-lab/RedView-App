import type { PrioritiesState, RoadTypesState, RouteProfile } from '../../types';
import { translateAppText } from '@/shared/i18n';
import type { FootDiscipline } from '@/shared/lib/discipline';
import {
  syncTracageOnActivityChange,
  type ActivityType,
  type TracingModeType,
} from './syncTracageParams';

export interface RouteProfilePreset {
  id: string;
  name: string;
  isDefault?: boolean;
  priorities: PrioritiesState;
  roadTypes: Omit<RoadTypesState, 'applyToAllItineraries'>;
}

/** Built-in activity presets, in dropdown order (bike first, then foot). */
export const ACTIVITY_PRESET_IDS: readonly ActivityType[] = ['road', 'gravel-default', 'mtb', 'running', 'trail'];

export function isActivityPresetId(id: string | null | undefined): id is ActivityType {
  return id != null && (ACTIVITY_PRESET_IDS as readonly string[]).includes(id);
}

/** Running / Trail presets route on the pedestrian network. */
export function isFootActivity(id: string | null | undefined): id is FootDiscipline {
  return id === 'running' || id === 'trail';
}

const defaultRoad = syncTracageOnActivityChange('road', 'vitesse', 10);
const defaultGravel = syncTracageOnActivityChange('gravel-default', 'vitesse', 10);
const defaultMtb = syncTracageOnActivityChange('mtb', 'vitesse', 10);
const defaultRunning = syncTracageOnActivityChange('running', 'vitesse', 10);
const defaultTrail = syncTracageOnActivityChange('trail', 'vitesse', 10);

export const ROUTE_PROFILE_PRESETS: Record<string, RouteProfilePreset> = {
  road: {
    id: 'road',
    name: translateAppText('Cyclisme sur route'),
    isDefault: true,
    priorities: defaultRoad.priorities as PrioritiesState,
    roadTypes: defaultRoad.roadTypes as Omit<RoadTypesState, 'applyToAllItineraries'>,
  },
  'gravel-default': {
    id: 'gravel-default',
    name: translateAppText('Gravel'),
    priorities: defaultGravel.priorities as PrioritiesState,
    roadTypes: defaultGravel.roadTypes as Omit<RoadTypesState, 'applyToAllItineraries'>,
  },
  mtb: {
    id: 'mtb',
    name: translateAppText('VTT'),
    priorities: defaultMtb.priorities as PrioritiesState,
    roadTypes: defaultMtb.roadTypes as Omit<RoadTypesState, 'applyToAllItineraries'>,
  },
  running: {
    id: 'running',
    name: translateAppText('Running'),
    priorities: defaultRunning.priorities as PrioritiesState,
    roadTypes: defaultRunning.roadTypes as Omit<RoadTypesState, 'applyToAllItineraries'>,
  },
  trail: {
    id: 'trail',
    name: translateAppText('Trail'),
    priorities: defaultTrail.priorities as PrioritiesState,
    roadTypes: defaultTrail.roadTypes as Omit<RoadTypesState, 'applyToAllItineraries'>,
  },
};

export const DEFAULT_PROFILES: RouteProfile[] = [
  { id: 'road', name: translateAppText('Cyclisme sur route'), isDefault: true },
  { id: 'gravel-default', name: translateAppText('Gravel') },
  { id: 'mtb', name: translateAppText('VTT') },
  { id: 'running', name: translateAppText('Running') },
  { id: 'trail', name: translateAppText('Trail') },
];

export function getProfilePreset(profileId: string): RouteProfilePreset | undefined {
  return ROUTE_PROFILE_PRESETS[profileId];
}

/**
 * Keys representing manual user adjustments:
 * - Surface sliders & tolerance
 * - Additional fields (champs additionnels)
 *
 * Notice:
 * - `activityType` is excluded (switching Route / Gravel / VTT / Running / Trail is not a custom profile)
 * - `tracingMode` is excluded (switching Vitesse / Aventure / Comfort is not a custom profile)
 * - `applyToAllItineraries` is excluded (batch checkbox must never affect profile state)
 */
export const CUSTOMIZABLE_ROAD_TYPE_KEYS: (keyof RoadTypesState)[] = [
  // Surface sliders & tolerance
  'surfaceMin',
  'surfaceMax',
  'surfacePreference',
  'surfaceTolerance',
  // Additional fields (champs additionnels)
  'elevationPreference',
  'maxSlopePercent',
  'majorRoads',
  'bikeLanes',
  'woods',
  'turns',
  'ferry',
  'cities',
  'road',
  'gravel',
  'singletrack',
  'offroad',
];

/**
 * Checks whether current road types differ from a baseline reference
 * on any of the manual customizable parameters (surfaces & additional fields).
 */
export function isRoadTypesCustomized(
  current: Partial<RoadTypesState>,
  baseline: Partial<RoadTypesState>,
): boolean {
  for (const k of CUSTOMIZABLE_ROAD_TYPE_KEYS) {
    if (current[k] !== undefined && baseline[k] !== undefined && current[k] !== baseline[k]) {
      return true;
    }
  }
  return false;
}

/**
 * Compares current road types with a target set of road types.
 * Returns true if all customizable keys match.
 */
export function isRoadTypesMatching(
  current: Partial<RoadTypesState>,
  target: Partial<RoadTypesState>,
): boolean {
  return !isRoadTypesCustomized(current, target);
}

export function matchesProfilePreset(
  profileId: string,
  _priorities: PrioritiesState,
  roadTypes: RoadTypesState,
): boolean {
  if (isActivityPresetId(profileId)) {
    const currentMode = (roadTypes.tracingMode ?? 'vitesse') as TracingModeType;
    const baseline = syncTracageOnActivityChange(profileId, currentMode, 10);
    return !isRoadTypesCustomized(roadTypes, baseline.roadTypes);
  }

  const preset = ROUTE_PROFILE_PRESETS[profileId];
  if (!preset) return false;

  return !isRoadTypesCustomized(roadTypes, preset.roadTypes);
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

  const activityType = roadTypes.activityType;
  if (isActivityPresetId(activityType)) {
    if (matchesProfilePreset(activityType, priorities, roadTypes)) {
      return activityType;
    }
  }

  for (const [id] of Object.entries(ROUTE_PROFILE_PRESETS)) {
    if (matchesProfilePreset(id, priorities, roadTypes)) {
      return id;
    }
  }

  return currentProfileId && currentProfileId !== 'custom' ? currentProfileId : 'custom';
}
