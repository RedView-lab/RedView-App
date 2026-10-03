import type { PrioritiesState, RoadTypesState } from '../../types';
import type { SavedCustomProfile } from '../../lib/project/customProfiles';

/** Réglages de tracé copiés dans un profil enregistré (`activityType` = nom du profil). */
function snapshotRoadTypes(roadTypes: RoadTypesState, profileName: string): SavedCustomProfile['roadTypes'] {
  return {
    road: roadTypes.road,
    gravel: roadTypes.gravel,
    singletrack: roadTypes.singletrack,
    offroad: roadTypes.offroad,
    bikeLanes: roadTypes.bikeLanes,
    majorRoads: roadTypes.majorRoads,
    ferry: roadTypes.ferry,
    turns: roadTypes.turns,
    maxSlopePercent: roadTypes.maxSlopePercent,
    cities: roadTypes.cities,
    elevationPreference: roadTypes.elevationPreference,
    woods: roadTypes.woods,
    surfacePreference: roadTypes.surfacePreference,
    surfaceMin: roadTypes.surfaceMin,
    surfaceMax: roadTypes.surfaceMax,
    surfaceTolerance: roadTypes.surfaceTolerance,
    activityType: profileName,
    tracingMode: roadTypes.tracingMode,
  };
}

/**
 * Profil à enregistrer depuis les réglages courants : mise à jour du profil
 * perso actif, sinon nouveau profil basé sur le préset actif.
 */
export function buildCustomProfileToSave({
  activeSaved,
  roadTypes,
  priorities,
  newProfileName,
  basePresetId,
}: {
  activeSaved: SavedCustomProfile | undefined;
  roadTypes: RoadTypesState;
  priorities: PrioritiesState;
  newProfileName: string;
  basePresetId: string;
}): SavedCustomProfile {
  if (activeSaved) {
    return {
      ...activeSaved,
      roadTypes: snapshotRoadTypes(roadTypes, activeSaved.name),
      priorities: { ...priorities },
    };
  }
  return {
    id: `custom_${Date.now()}`,
    name: newProfileName,
    basePresetId,
    roadTypes: snapshotRoadTypes(roadTypes, newProfileName),
    priorities: { ...priorities },
    createdAt: Date.now(),
  };
}
