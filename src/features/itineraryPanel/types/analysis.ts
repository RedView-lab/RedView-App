// Graphe d'analyse (centerPanel) et qualité GPX : état persisté sur le projet.

export type GpxQualityPreset = 'default' | 'balanced' | 'max';
export type GpxQualityMode = GpxQualityPreset | 'expert';

/**
 * Persisted state of the bottom analysis chart (centerPanel). Stored on
 * the project so axis selections, filter chips and the X-axis mode
 * (distance / elapsed time / clock time) survive across sessions.
 */
export type AnalysisAxisMetricId =
  | 'Altitude'
  | 'Vitesse'
  | 'Vitesse moyenne'
  | 'Allure'
  | 'Allure moyenne'
  | 'Puissance'
  | 'Puissance moyenne'
  | 'Inclinaison (°)'
  | 'Inclinaison (%)'
  | 'Surface'
  | 'Température'
  | 'Température ressentie (°)'
  | 'Pluie (mm)'
  | 'Vent (km/h)'
  | 'Couverture nuageuse (%)'
  | 'Humidité (%)'
  | 'Ensoleillement (min)';

export type AnalysisAxisMode = 'distance' | 'temps' | 'heure';

export interface AnalysisFiltersState {
  waypoint: boolean;
  poi: boolean;
  pause: boolean;
  pente: boolean;
  jourNuit: boolean;
  /** Colonnes rouges sur le graphe : pente ≥ 12 % sur ≥ 500 m ou ≥ 18 % sur ≥ 200 m. */
  alertes: boolean;
  /** Colorisation du profil d'altitude par classe de pente (façon Komoot). */
  slopeColors: boolean;
}

/**
 * Filtre « Surface » : n'affiche sur la carte que les tronçons du revêtement
 * choisi. `other` = terre + sable.
 */
export type RouteSurfaceFilter = 'all' | 'asphalt' | 'paved' | 'gravel' | 'other';

export interface AnalysisPanelState {
  xMode: AnalysisAxisMode;
  axis1: AnalysisAxisMetricId;
  axis2: AnalysisAxisMetricId | null;
  axis1Color?: string;
  axis2Color?: string;
  filters: AnalysisFiltersState;
  surfaceFilter?: RouteSurfaceFilter;
  detailZoom: number;
  detailOffset: number;
  yZoom?: number;
  yOffset?: number;
}
