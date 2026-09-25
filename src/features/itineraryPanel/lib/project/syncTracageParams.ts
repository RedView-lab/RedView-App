import type { PrioritiesState, RoadTypesState } from '../../types';

export type ActivityType = 'road' | 'gravel-default' | 'mtb';
export type TracingModeType = 'vitesse' | 'aventure' | 'comfort';
export type SurfaceType = 'tarmac' | 'paved' | 'gravel' | 'other';

export interface TracageSyncResult {
  roadTypes: Partial<RoadTypesState>;
  priorities?: Partial<PrioritiesState>;
}

/**
 * Returns synchronized parameters when the user changes "Type d'activité".
 * Automatically updates:
 * - surface knob (Tarmac / Paved / Gravel / Other)
 * - all 8 "Paramètres additionnels" (Dénivelé, Pentes max., Axes majeurs, Voies cyclables,
 *   Bois, Intersections, Ferry, Villes)
 * - routing priorities (duration, distance, elevation, tranquility)
 */
export function syncTracageOnActivityChange(
  activity: ActivityType,
  mode: TracingModeType = 'vitesse',
  currentTolerance = 10,
): TracageSyncResult {
  switch (activity) {
    case 'mtb': {
      // Matches Figma node 5918:112682 and user's reference screenshot
      const isComfort = mode === 'comfort';
      const isAventure = mode === 'aventure';

      return {
        roadTypes: {
          activityType: 'mtb',
          tracingMode: mode,
          surfacePreference: 'other',
          surfaceMin: 'paved',
          surfaceMax: 'other',
          surfaceTolerance: currentTolerance,
          road: 'avoid',
          gravel: 'prefer',
          singletrack: 'prefer',
          offroad: 'tolerate',
          elevationPreference: isAventure ? 'prefer' : 'avoid',
          maxSlopePercent: 25,
          majorRoads: 'forbid',
          bikeLanes: 'avoid',
          woods: 'prefer',
          turns: isComfort ? 'tolerate' : mode === 'vitesse' ? 'avoid' : 'tolerate',
          ferry: 'tolerate',
          cities: 'avoid',
        },
        priorities: isComfort
          ? { duration: 35, distance: 40, elevation: 25, tranquility: 90 }
          : isAventure
            ? { duration: 25, distance: 35, elevation: 85, tranquility: 95 }
            : { duration: 60, distance: 55, elevation: 35, tranquility: 80 },
      };
    }

    case 'road': {
      const isComfort = mode === 'comfort';
      const isAventure = mode === 'aventure';

      return {
        roadTypes: {
          activityType: 'road',
          tracingMode: mode,
          surfacePreference: 'tarmac',
          surfaceMin: 'tarmac',
          surfaceMax: 'tarmac',
          surfaceTolerance: currentTolerance,
          road: 'prefer',
          gravel: 'forbid',
          singletrack: 'forbid',
          offroad: 'forbid',
          elevationPreference: isAventure ? 'tolerate' : 'avoid',
          maxSlopePercent: isAventure ? 15 : isComfort ? 10 : 12,
          majorRoads: mode === 'vitesse' ? 'tolerate' : 'avoid',
          bikeLanes: 'prefer',
          woods: mode === 'vitesse' ? 'tolerate' : 'prefer',
          turns: mode === 'vitesse' ? 'avoid' : 'tolerate',
          ferry: 'tolerate',
          cities: 'avoid',
        },
        priorities: isComfort
          ? { duration: 45, distance: 45, elevation: 20, tranquility: 80 }
          : isAventure
            ? { duration: 40, distance: 45, elevation: 65, tranquility: 85 }
            : { duration: 80, distance: 70, elevation: 30, tranquility: 35 },
      };
    }

    case 'gravel-default':
    default: {
      const isComfort = mode === 'comfort';
      const isAventure = mode === 'aventure';

      return {
        roadTypes: {
          activityType: 'gravel-default',
          tracingMode: mode,
          surfacePreference: 'gravel',
          surfaceMin: 'tarmac',
          surfaceMax: 'gravel',
          surfaceTolerance: currentTolerance,
          road: 'avoid',
          gravel: 'prefer',
          singletrack: 'tolerate',
          offroad: 'avoid',
          elevationPreference: isAventure ? 'prefer' : 'avoid',
          maxSlopePercent: isAventure ? 20 : isComfort ? 12 : 15,
          majorRoads: isAventure ? 'forbid' : 'avoid',
          bikeLanes: isComfort ? 'prefer' : 'tolerate',
          woods: 'prefer',
          turns: mode === 'vitesse' ? 'avoid' : 'tolerate',
          ferry: 'tolerate',
          cities: 'avoid',
        },
        priorities: isComfort
          ? { duration: 40, distance: 45, elevation: 25, tranquility: 85 }
          : isAventure
            ? { duration: 30, distance: 40, elevation: 75, tranquility: 95 }
            : { duration: 70, distance: 60, elevation: 35, tranquility: 60 },
      };
    }
  }
}

/**
 * Returns synchronized parameters when the user changes "Mode de traçage".
 * Dynamically updates:
 * - Dénivelé (elevationPreference)
 * - Pentes max. (maxSlopePercent)
 * - Intersections (turns)
 * - Bois (woods)
 * - Voies cyclables (bikeLanes)
 * - Axes majeurs (majorRoads)
 * - Villes (cities)
 * - routing priorities
 */
export function syncTracageOnTracingModeChange(
  newMode: TracingModeType,
  currentActivity: ActivityType = 'gravel-default',
): TracageSyncResult {
  const updates: Partial<RoadTypesState> = {
    tracingMode: newMode,
  };

  let priorities: Partial<PrioritiesState> | undefined;

  switch (newMode) {
    case 'vitesse': {
      updates.elevationPreference = 'avoid';
      updates.turns = 'avoid';
      updates.cities = 'avoid';
      updates.maxSlopePercent = currentActivity === 'road' ? 12 : currentActivity === 'mtb' ? 25 : 15;
      updates.majorRoads = currentActivity === 'road' ? 'tolerate' : currentActivity === 'mtb' ? 'forbid' : 'avoid';
      updates.woods = currentActivity === 'road' ? 'tolerate' : 'prefer';
      updates.bikeLanes = currentActivity === 'road' ? 'prefer' : currentActivity === 'mtb' ? 'avoid' : 'tolerate';

      if (currentActivity === 'road') {
        priorities = { duration: 80, distance: 70, elevation: 30, tranquility: 35 };
      } else if (currentActivity === 'mtb') {
        priorities = { duration: 60, distance: 55, elevation: 35, tranquility: 80 };
      } else {
        priorities = { duration: 70, distance: 60, elevation: 35, tranquility: 60 };
      }
      break;
    }

    case 'aventure': {
      updates.elevationPreference = currentActivity === 'road' ? 'tolerate' : 'prefer';
      updates.turns = 'tolerate';
      updates.woods = 'prefer';
      updates.majorRoads = currentActivity === 'road' ? 'avoid' : 'forbid';
      updates.cities = 'avoid';
      updates.maxSlopePercent = currentActivity === 'road' ? 15 : currentActivity === 'mtb' ? 25 : 20;
      updates.bikeLanes = currentActivity === 'road' ? 'prefer' : currentActivity === 'mtb' ? 'avoid' : 'tolerate';

      if (currentActivity === 'road') {
        priorities = { duration: 40, distance: 45, elevation: 65, tranquility: 85 };
      } else if (currentActivity === 'mtb') {
        priorities = { duration: 25, distance: 35, elevation: 85, tranquility: 95 };
      } else {
        priorities = { duration: 30, distance: 40, elevation: 75, tranquility: 95 };
      }
      break;
    }

    case 'comfort': {
      updates.elevationPreference = 'avoid';
      updates.turns = 'tolerate';
      updates.woods = 'prefer';
      updates.bikeLanes = currentActivity === 'road' ? 'prefer' : currentActivity === 'mtb' ? 'avoid' : 'prefer';
      updates.majorRoads = currentActivity === 'mtb' ? 'forbid' : 'avoid';
      updates.cities = 'avoid';
      updates.ferry = 'tolerate';
      updates.maxSlopePercent = currentActivity === 'mtb' ? 25 : currentActivity === 'road' ? 10 : 12;

      if (currentActivity === 'road') {
        priorities = { duration: 45, distance: 45, elevation: 20, tranquility: 80 };
      } else if (currentActivity === 'mtb') {
        priorities = { duration: 35, distance: 40, elevation: 25, tranquility: 90 };
      } else {
        priorities = { duration: 40, distance: 45, elevation: 25, tranquility: 85 };
      }
      break;
    }
  }

  return { roadTypes: updates, priorities };
}

const SURFACE_INDEX: Record<SurfaceType, number> = {
  tarmac: 0,
  paved: 1,
  gravel: 2,
  other: 3,
};

const ORDERED_SURFACES: SurfaceType[] = ['tarmac', 'paved', 'gravel', 'other'];

/**
 * Returns synchronized parameters when the user modifies the dual-knob surface range [surfaceMin, surfaceMax].
 * Supports:
 * - Excluding tarmac (surfaceMin > 'tarmac')
 * - Excluding other (surfaceMax < 'other')
 * - Superposition (surfaceMin === surfaceMax) to strictly prioritize a single surface type
 */
export function syncTracageOnSurfaceRangeChange(
  surfaceMin: SurfaceType,
  surfaceMax: SurfaceType,
  currentActivity: ActivityType = 'gravel-default',
): TracageSyncResult {
  let minIdx = SURFACE_INDEX[surfaceMin] ?? 0;
  let maxIdx = SURFACE_INDEX[surfaceMax] ?? minIdx;
  if (minIdx > maxIdx) {
    const tmp = minIdx;
    minIdx = maxIdx;
    maxIdx = tmp;
  }
  const effectiveMin = ORDERED_SURFACES[minIdx];
  const effectiveMax = ORDERED_SURFACES[maxIdx];

  const updates: Partial<RoadTypesState> = {
    surfaceMin: effectiveMin,
    surfaceMax: effectiveMax,
    surfacePreference: effectiveMax,
  };

  const isSingle = minIdx === maxIdx;

  if (isSingle) {
    switch (effectiveMin) {
      case 'tarmac': {
        updates.road = 'prefer';
        updates.gravel = 'forbid';
        updates.singletrack = 'forbid';
        updates.offroad = 'forbid';
        updates.bikeLanes = 'prefer';
        updates.majorRoads = currentActivity === 'road' ? 'tolerate' : 'avoid';
        break;
      }
      case 'paved': {
        updates.road = 'avoid';
        updates.gravel = 'forbid';
        updates.singletrack = 'forbid';
        updates.offroad = 'forbid';
        updates.bikeLanes = 'prefer';
        updates.majorRoads = 'forbid';
        break;
      }
      case 'gravel': {
        updates.road = 'forbid';
        updates.gravel = 'prefer';
        updates.singletrack = 'forbid';
        updates.offroad = 'forbid';
        updates.bikeLanes = 'tolerate';
        updates.majorRoads = 'forbid';
        updates.woods = 'prefer';
        break;
      }
      case 'other': {
        updates.road = 'forbid';
        updates.gravel = 'avoid';
        updates.singletrack = 'prefer';
        updates.offroad = 'prefer';
        updates.majorRoads = 'forbid';
        updates.bikeLanes = 'avoid';
        updates.woods = 'prefer';
        break;
      }
    }
    return { roadTypes: updates };
  }

  // Range of surfaces:
  // Tarmac / Road
  if (minIdx === 0) {
    updates.road = currentActivity === 'road' ? 'prefer' : 'tolerate';
    if (maxIdx <= 1) {
      updates.bikeLanes = 'prefer';
      updates.majorRoads = currentActivity === 'road' ? 'tolerate' : 'avoid';
    }
  } else if (minIdx === 1) {
    updates.road = 'avoid';
    updates.majorRoads = 'forbid';
  } else {
    // minIdx >= 2 (only gravel or other)
    updates.road = 'forbid';
    updates.majorRoads = 'forbid';
  }

  // Gravel
  if (maxIdx < 2) {
    updates.gravel = 'forbid';
  } else if (minIdx > 2) {
    updates.gravel = 'avoid';
  } else {
    updates.gravel = 'prefer';
    updates.woods = 'prefer';
  }

  // Singletrack / offroad ('other')
  if (maxIdx < 3) {
    updates.singletrack = 'forbid';
    updates.offroad = 'forbid';
  } else {
    updates.singletrack = currentActivity === 'mtb' ? 'prefer' : 'tolerate';
    updates.offroad = currentActivity === 'mtb' ? 'tolerate' : 'avoid';
    updates.woods = 'prefer';
  }

  return { roadTypes: updates };
}

/**
 * Backward compatibility wrapper for single-surface selection.
 */
export function syncTracageOnSurfaceChange(
  surface: SurfaceType,
  currentActivity: ActivityType = 'gravel-default',
): TracageSyncResult {
  return syncTracageOnSurfaceRangeChange('tarmac', surface, currentActivity);
}

