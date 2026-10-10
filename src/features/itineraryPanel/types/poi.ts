import type { PoiAutoSortReason } from '../../poi/types';

// Catégories POI recherchées le long du tracé et tri automatique.

/** Une ligne de type de POI : activée + rayon de recherche (mètres, ou null quand désactivée). */
export interface PoiEntry {
  enabled: boolean;
  /** Rayon de recherche en mètres. Null quand la ligne est entièrement désactivée. */
  distanceM: number | null;
}

export type PoiCategory =
  | 'fountains'
  | 'cemeteries'
  | 'toilets'
  | 'supermarkets'
  | 'gasStations'
  | 'bakeries'
  | 'fastFood'
  | 'cafes'
  | 'bars'
  | 'restaurants'
  | 'bikeShops'
  | 'hotels'
  | 'refuges'
  | 'passes'
  | 'health'
  | 'transport';

export interface PoiState {
  fountains: PoiEntry;
  /** Cimetières : en France, un robinet presque toujours (eau non garantie potable). */
  cemeteries: PoiEntry;
  toilets: PoiEntry;
  supermarkets: PoiEntry;
  gasStations: PoiEntry;
  bakeries: PoiEntry;
  fastFood: PoiEntry;
  cafes: PoiEntry;
  bars: PoiEntry;
  restaurants: PoiEntry;
  bikeShops: PoiEntry;
  hotels: PoiEntry;
  refuges: PoiEntry;
  passes: PoiEntry;
  /** Pharmacies, hôpitaux, médecins, défibrillateurs, police. */
  health: PoiEntry;
  /** Gares, arrêts, terminaux ferry, distributeurs, poste, laveries. */
  transport: PoiEntry;
}

/** Bilan du tri automatique des POI, affiché sous le bouton « Tri auto ». */
export interface PoiAutoSortSummary {
  total: number;
  byReason: Record<PoiAutoSortReason, number>;
  /** Trous que les POI disponibles ne permettent pas de combler. */
  warnings: Array<{ kind: 'waterGap' | 'resupplyGap'; fromKm: number; toKm: number; hours: number }>;
  /** false : heures de passage estimées à 18 km/h faute de prédiction. */
  usedPrediction: boolean;
}

/** POI retenu par le tri automatique (id OSM de la feature). */
export interface PoiAutoSortPickRef {
  id: number;
  reason: PoiAutoSortReason;
}

export interface PoiAutoSortState {
  /** Entrées du tri (recherche, départ, rythme) : voir `buildPoiAutoSortSignature`. */
  signature: string;
  summary: PoiAutoSortSummary;
  /**
   * POI retenus : avec les favoris, seuls POI laissés dans la feuille de route.
   * Absent sur les tris d'avant le filtrage (qui posaient des favoris) : re-tri.
   */
  picks?: PoiAutoSortPickRef[];
  /** ISO date du tri. */
  ranAt: string;
}
