import type { PoiAutoSortReason, PoiFeature } from '../../types';
import type { AutoSortRules } from './rules';

export type AutoSortKind = 'water' | 'shop' | 'meal' | 'night' | 'hotel';

export type AutoSortReason = PoiAutoSortReason;

export type OpenStatus = 'open' | 'closed' | 'unknown';

export type RouteSide = 'right' | 'left' | 'on';

interface AutoSortStopAnchor {
  rideElapsedSeconds: number;
  durationMin: number;
}

/**
 * Modèle horaire fourni par l'appelant : le moteur ne connaît ni la
 * prédiction ni l'itinéraire, seulement ces fonctions.
 */
export interface AutoSortTimeModel {
  /** Secondes de roulage (hors pauses) pour atteindre `progressM` sur la trace. */
  rideSecondsAt: (progressM: number) => number;
  /** Pauses déjà planifiées (intervalles, pauses manuelles, favoris manuels). */
  baseStopAnchors: readonly AutoSortStopAnchor[];
  /** Date/heure locale du départ. */
  start: Date;
  /** Sans date de départ réelle, le jour de semaine est inconnu. */
  hasRealDate: boolean;
  /** Minutes de pause ajoutées si ce POI devient favori (0 si les favoris ne marquent pas de pause). */
  pauseMinutesFor: (feature: PoiFeature) => number;
}

export interface AutoSortInput {
  /** POI candidats (déjà filtrés sur les catégories et distances X de l'utilisateur). */
  features: readonly PoiFeature[];
  routePoints: readonly { lat: number; lon: number; elevationM?: number | null }[];
  time: AutoSortTimeModel;
  /** Favoris posés à la main : conservés et comptés comme arrêts. */
  manualFavoriteIds?: ReadonlySet<string | number>;
  /** Distance X de la catégorie du POI (m) ; défaut 200 m. */
  maxLateralMFor?: (feature: PoiFeature) => number;
  rules?: AutoSortRules;
}

export interface AutoSortPick {
  feature: PoiFeature;
  reason: AutoSortReason;
  kind: AutoSortKind;
  progressM: number;
  lateralM: number;
  side: RouteSide;
  gradePct: number;
  rideSeconds: number;
  /** Secondes depuis le départ, pauses comprises. */
  scheduledSeconds: number;
  arrival: Date;
  openStatus: OpenStatus;
  /** Ouvert, ou horaires inconnus mais passage dans les horaires habituels. */
  likelyOpen: boolean;
  /** Retenu faute de mieux (descente, côté gauche…). */
  fallback: boolean;
}

export interface AutoSortWarning {
  kind: 'waterGap' | 'resupplyGap';
  fromKm: number;
  toKm: number;
  hours: number;
}

interface AutoSortStats {
  candidates: number;
  manual: number;
  byReason: Record<AutoSortReason, number>;
  maxWaterGapH: number;
  maxResupplyGapH: number;
  /** Points d'eau écartés parce qu'en descente. */
  descentsAvoided: number;
  hotelsPerNight: number[];
}

export interface AutoSortResult {
  picks: AutoSortPick[];
  stats: AutoSortStats;
  warnings: AutoSortWarning[];
}
