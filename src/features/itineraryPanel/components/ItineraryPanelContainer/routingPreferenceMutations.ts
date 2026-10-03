import { cloneItineraryForMutation } from '../../context/ProjectStore/historyClone';
import { getProfilePreset, isActivityPresetId } from '../../lib/project';
import { syncTracageOnActivityChange } from '../../lib/project/syncTracageParams';
import type { SavedCustomProfile } from '../../lib/project/customProfiles';
import type {
  ItineraryProject,
  PrioritiesState,
  RoadTypesState,
} from '../../types';

/**
 * Transformations pures du projet pour les réglages de tracé (profil,
 * types de route, priorités) : utilisées par les callbacks du panneau.
 */

/** Sélection d'un profil (perso ou préset) sur l'itinéraire actif. */
export function applyProfileChange(
  prev: ItineraryProject,
  id: string,
  savedCustomProfiles: SavedCustomProfile[],
): ItineraryProject {
  const custom = savedCustomProfiles.find((p) => p.id === id);
  if (custom) {
    return {
      ...prev,
      itineraries: prev.itineraries.map((itinerary) => {
        if (itinerary.id !== prev.activeItineraryId) return itinerary;
        const copy = cloneItineraryForMutation(itinerary);
        copy.profileId = id;
        copy.priorities = { ...custom.priorities };
        copy.roadTypes = {
          ...custom.roadTypes,
          applyToAllItineraries: copy.roadTypes.applyToAllItineraries,
        };
        return copy;
      }),
    };
  }
  const preset = getProfilePreset(id);
  return {
    ...prev,
    itineraries: prev.itineraries.map((itinerary) => {
      if (itinerary.id !== prev.activeItineraryId) return itinerary;
      const copy = cloneItineraryForMutation(itinerary);
      copy.profileId = id;
      if (preset) {
        const currentMode = copy.roadTypes.tracingMode ?? 'vitesse';
        const currentTolerance = copy.roadTypes.surfaceTolerance ?? 10;
        if (isActivityPresetId(id)) {
          const sync = syncTracageOnActivityChange(id, currentMode, currentTolerance);
          if (sync.priorities) {
            copy.priorities = { ...copy.priorities, ...sync.priorities };
          }
          copy.roadTypes = {
            ...copy.roadTypes,
            ...sync.roadTypes,
            applyToAllItineraries: copy.roadTypes.applyToAllItineraries,
          };
        } else {
          copy.priorities = { ...preset.priorities };
          copy.roadTypes = {
            ...preset.roadTypes,
            tracingMode: currentMode,
            applyToAllItineraries: copy.roadTypes.applyToAllItineraries,
          };
        }
      }
      return copy;
    }),
  };
}

/** Changement d'un type de route (propagé à tous si « appliquer à tous »). */
export function applyRoadTypeChange<K extends keyof RoadTypesState>(
  prev: ItineraryProject,
  key: K,
  value: RoadTypesState[K],
): ItineraryProject {
  // Toggling 'applyToAllItineraries' must only affect the active itinerary and never modify profiles!
  if (key === 'applyToAllItineraries') {
    return {
      ...prev,
      itineraries: prev.itineraries.map((itinerary) => {
        if (itinerary.id !== prev.activeItineraryId) return itinerary;
        return {
          ...itinerary,
          roadTypes: {
            ...itinerary.roadTypes,
            applyToAllItineraries: Boolean(value),
          },
        };
      }),
    };
  }

  const active = prev.itineraries.find((it) => it.id === prev.activeItineraryId);
  const applyToAll = active?.roadTypes.applyToAllItineraries;
  return {
    ...prev,
    itineraries: prev.itineraries.map((itinerary) => {
      if (itinerary.id !== prev.activeItineraryId && !applyToAll) return itinerary;
      const copy = cloneItineraryForMutation(itinerary);
      (copy.roadTypes[key] as RoadTypesState[typeof key]) = value;
      if (key === 'activityType' && itinerary.id === prev.activeItineraryId) {
        copy.profileId = value as string;
      }
      return copy;
    }),
  };
}

/** Changement groupé de types de route / priorités. */
export function applyBatchRoadTypeChange(
  prev: ItineraryProject,
  roadUpdates: Partial<RoadTypesState>,
  priorityUpdates?: Partial<PrioritiesState>,
): ItineraryProject {
  const active = prev.itineraries.find((it) => it.id === prev.activeItineraryId);
  const applyToAll = active?.roadTypes.applyToAllItineraries;
  return {
    ...prev,
    itineraries: prev.itineraries.map((itinerary) => {
      const isActive = itinerary.id === prev.activeItineraryId;
      if (!isActive && !applyToAll) return itinerary;
      const copy = cloneItineraryForMutation(itinerary);

      if (isActive) {
        Object.assign(copy.roadTypes, roadUpdates);
        if (priorityUpdates) {
          Object.assign(copy.priorities, priorityUpdates);
        }
        if (roadUpdates.activityType) {
          copy.profileId = roadUpdates.activityType;
        }
      } else {
        // For other itineraries when applyToAll is true:
        // Only propagate specific road preferences, never change their activityType or profileId or applyToAllItineraries
        const safeRoadUpdates = { ...roadUpdates };
        delete safeRoadUpdates.activityType;
        delete safeRoadUpdates.applyToAllItineraries;
        Object.assign(copy.roadTypes, safeRoadUpdates);
      }
      return copy;
    }),
  };
}
