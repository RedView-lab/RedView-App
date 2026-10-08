// Graphe d'analyse (centerPanel) et qualité GPX : état persisté sur le projet.

export type GpxQualityPreset = 'default' | 'balanced' | 'max';
export type GpxQualityMode = GpxQualityPreset | 'expert';
/**
 * Finesse des traces dessinées sur la carte (vue, propre à chaque
 * utilisateur, jamais le document) : `auto` suit la vue — 2D ou relief 30 m :
 * rapide ; relief HD (1 m, 0,40 m) : maximum.
 */
export type RouteDisplayQuality = 'auto' | GpxQualityPreset;

/**
 * État persisté du graphique d'analyse du bas (centerPanel). Stocké sur le
 * projet pour que les choix d'axes, les puces de filtre et le mode de l'axe X
 * (distance / temps écoulé / heure) survivent d'une session à l'autre.
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
