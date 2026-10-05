// Réglages de tracé (routage BRouter) d'un itinéraire.

/** Value a routing/road preference slot can take. */
export type RoadPreference = 'avoid' | 'prefer' | 'tolerate' | 'forbid';

/** Visual profile applied to routing ("Gravel (défaut)" etc.). */
export interface RouteProfile {
  id: string;
  name: string;
  isDefault?: boolean;
}

/**
 * Profil de tracé enregistré par l'utilisateur (bibliothèque de son compte,
 * cf. `lib/project/customProfiles.ts`). Un itinéraire en garde les réglages
 * effectifs (`priorities`, `roadTypes`) ; le document du projet embarque en
 * plus une copie des profils qu'il référence (`ItineraryProject.routingProfiles`)
 * pour qu'un autre appareil ou un collaborateur retrouve leur nom et leur préset.
 */
export interface SavedCustomProfile {
  id: string;
  name: string;
  basePresetId?: string;
  roadTypes: Omit<RoadTypesState, 'applyToAllItineraries'>;
  priorities: PrioritiesState;
  createdAt: number;
  /** Dernière modification (ms) ; absent sur les profils antérieurs. */
  updatedAt?: number;
}

export interface PrioritiesState {
  /** Each value ∈ [0, 100]. */
  duration: number;
  elevation: number;
  distance: number;
  tranquility: number;
}

export interface RoadTypesState {
  road: RoadPreference;
  gravel: RoadPreference;
  singletrack: RoadPreference;
  offroad: RoadPreference;
  bikeLanes: RoadPreference;
  majorRoads: RoadPreference;
  ferry: RoadPreference;
  turns: RoadPreference;
  /** Max slope in percent (0–100). */
  maxSlopePercent: number;
  cities: RoadPreference;
  /**
   * When true, the current road-type settings are applied to every itinerary
   * of the project. Figma 1705:23497 (Appliquer à tout les itinéraires).
   */
  applyToAllItineraries: boolean;
  /** Figma 5918:103512 / 5918:112682 additions */
  elevationPreference?: RoadPreference;
  woods?: RoadPreference;
  surfacePreference?: 'tarmac' | 'paved' | 'gravel' | 'other';
  surfaceMin?: 'tarmac' | 'paved' | 'gravel' | 'other';
  surfaceMax?: 'tarmac' | 'paved' | 'gravel' | 'other';
  surfaceTolerance?: number;
  activityType?: string;
  tracingMode?: 'vitesse' | 'aventure' | 'comfort';
}
