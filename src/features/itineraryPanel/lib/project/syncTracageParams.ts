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
  mode: TracingModeType = 'comfort',
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
          surfacePreference: 'gravel',
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
          cities: mode === 'vitesse' ? 'avoid' : 'tolerate',
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
      updates.maxSlopePercent = currentActivity === 'road' ? 10 : currentActivity === 'mtb' ? 20 : 15;
      updates.majorRoads = currentActivity === 'road' ? 'tolerate' : 'avoid';
      updates.woods = currentActivity === 'road' ? 'tolerate' : 'prefer';

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
      updates.maxSlopePercent = currentActivity === 'road' ? 15 : 25;

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
      updates.bikeLanes = currentActivity === 'mtb' ? 'avoid' : 'prefer';
      updates.majorRoads = currentActivity === 'road' ? 'avoid' : 'forbid';
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

/**
 * Returns synchronized parameters when the user drags or clicks on "Surfaces".
 * Automatically updates road, gravel, singletrack, offroad, and related road parameters.
 */
export function syncTracageOnSurfaceChange(
  surface: SurfaceType,
  currentActivity: ActivityType = 'gravel-default',
): TracageSyncResult {
  const updates: Partial<RoadTypesState> = {
    surfacePreference: surface,
  };

  switch (surface) {
    case 'tarmac': {
      updates.road = 'prefer';
      updates.gravel = 'forbid';
      updates.singletrack = 'forbid';
      updates.offroad = 'forbid';
      updates.bikeLanes = 'prefer';
      if (currentActivity === 'road') {
        updates.majorRoads = 'tolerate';
      }
      break;
    }

    case 'paved': {
      updates.road = 'prefer';
      updates.gravel = 'avoid';
      updates.singletrack = 'forbid';
      updates.offroad = 'forbid';
      updates.bikeLanes = 'prefer';
      break;
    }

    case 'gravel': {
      updates.road = 'avoid';
      updates.gravel = 'prefer';
      updates.singletrack = currentActivity === 'mtb' ? 'prefer' : 'tolerate';
      updates.offroad = currentActivity === 'mtb' ? 'tolerate' : 'avoid';
      updates.woods = 'prefer';
      break;
    }

    case 'other': {
      updates.road = 'avoid';
      updates.gravel = 'prefer';
      updates.singletrack = 'prefer';
      updates.offroad = 'tolerate';
      updates.majorRoads = 'forbid';
      updates.bikeLanes = 'avoid';
      updates.woods = 'prefer';
      break;
    }
  }

  return { roadTypes: updates };
}

