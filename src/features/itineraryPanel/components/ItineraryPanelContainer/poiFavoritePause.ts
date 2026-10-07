import { DEFAULT_POI_PAUSE_MIN, type PoiFeature } from '@/features/poi/types';
import { trackAnalyticsEvent } from '@/shared/lib/analytics';
import { normalizeItineraryRhythmState } from '../../lib/project';
import { upsertPoiTimelineRow } from '../../lib/schedule';
import type { Itinerary, PoiCategory, TimelineItem } from '../../types';
import { setManualFavoriteOrigin, setPoiFeatureFavoriteState } from './poiFeatureUtils';

/**
 * Favoris et pauses des POI : une seule règle, d'où que vienne le geste
 * (popup de la carte, étoile de l'agenda ou de la feuille de route).
 *
 * - Mettre un POI en favori coche et active sa pause : la durée de sa
 *   catégorie dans la grille Rythme, sinon 5 min. Elle est posée sur la ligne
 *   (`durationMin`), donc visible dans le popup, sur la vignette de la carte
 *   et dans l'agenda.
 * - Retirer le favori retire la pause : une pause de POI appartient à un
 *   favori (activer une pause met le POI en favori).
 * - Décocher la pause d'un favori pose `durationMin = 0` : l'option « pauses
 *   à chaque POI favori » ne la fait pas revenir.
 *
 * Fonctions pures sur un brouillon d'itinéraire : elles mutent `it`.
 */

/** Durée par défaut d'une pause pour une catégorie du panneau. */
export function resolvePoiPauseDefaultMin(
  itinerary: Pick<Itinerary, 'rhythm'>,
  category: PoiCategory | undefined,
): number {
  if (!category) return DEFAULT_POI_PAUSE_MIN;
  const duration = normalizeItineraryRhythmState(itinerary.rhythm).poiPauseDurations[category];
  return typeof duration === 'number' && Number.isFinite(duration) && duration > 0
    ? Math.round(duration)
    : DEFAULT_POI_PAUSE_MIN;
}

/** Pause portée par une ligne de POI, en minutes (null : aucune). */
export function poiRowPauseMin(row: Pick<TimelineItem, 'durationMin'>): number | null {
  return typeof row.durationMin === 'number' && row.durationMin > 0 ? row.durationMin : null;
}

function findPoiRow(itinerary: Itinerary, poiId: number): TimelineItem | undefined {
  return itinerary.timeline.find((row) => row.kind === 'poi' && row.osmId === poiId);
}

function toPauseMin(durationMin: number): number {
  return Math.max(1, Math.round(durationMin));
}

function applyRowFavorite(
  itinerary: Itinerary,
  row: TimelineItem,
  favorite: boolean,
  pauseMin?: number,
): void {
  if (Boolean(row.favorite) !== favorite) {
    trackAnalyticsEvent({ name: 'poi_favorited', data: { enabled: favorite, category: row.poiCategory ?? 'other' } });
  }
  row.favorite = favorite;
  setManualFavoriteOrigin(row, favorite);
  if (!favorite) {
    delete row.durationMin;
    return;
  }
  if (poiRowPauseMin(row) === null) {
    row.durationMin = toPauseMin(pauseMin ?? resolvePoiPauseDefaultMin(itinerary, row.poiCategory));
  }
}

function syncFeaturePause(itinerary: Itinerary, row: TimelineItem): void {
  if (row.osmId == null) return;
  itinerary.poiFeatures = setPoiFeatureFavoriteState(
    itinerary.poiFeatures,
    row.osmId,
    Boolean(row.favorite),
    poiRowPauseMin(row),
  );
}

export interface PoiFavoriteOptions {
  /** Distance du POI sur la trace, pour une ligne créée. */
  distanceKm: () => number | null;
  /** Durée de la pause posée avec le favori (celle qu'affichait le popup). */
  pauseMin?: number;
}

/** Favori d'un POI de la carte (popups de la carte). */
export function setPoiFeatureFavorite(
  itinerary: Itinerary,
  feature: PoiFeature,
  favorite: boolean,
  options: PoiFavoriteOptions,
): void {
  const existing = findPoiRow(itinerary, feature.id);
  if (!existing && !favorite) {
    itinerary.poiFeatures = setPoiFeatureFavoriteState(itinerary.poiFeatures, feature.id, false, null);
    return;
  }
  const row = existing ?? upsertPoiTimelineRow(itinerary, feature, options.distanceKm);
  applyRowFavorite(itinerary, row, favorite, options.pauseMin);
  syncFeaturePause(itinerary, row);
  if (favorite && !itinerary.poiFeatures?.some((entry) => entry.id === feature.id)) {
    (itinerary.poiFeatures ??= []).push({
      ...feature,
      favorite: true,
      favoriteSource: 'manual',
      pauseDurationMin: poiRowPauseMin(row),
    });
  }
}

/** Favori d'une ligne de POI (étoiles de l'agenda et de la feuille de route). */
export function setPoiRowFavorite(itinerary: Itinerary, row: TimelineItem, favorite: boolean): void {
  applyRowFavorite(itinerary, row, favorite);
  syncFeaturePause(itinerary, row);
}

/**
 * Pause d'un POI de la carte. L'activer met le POI en favori ; la désactiver
 * pose une pause nulle explicite. Une catégorie encore sans durée dans la
 * grille Rythme retient celle-ci.
 */
export function setPoiFeaturePause(
  itinerary: Itinerary,
  feature: PoiFeature,
  enabled: boolean,
  durationMin: number,
  options: Pick<PoiFavoriteOptions, 'distanceKm'>,
): void {
  if (enabled) {
    const pauseMin = toPauseMin(durationMin);
    if (!findPoiRow(itinerary, feature.id)?.favorite) {
      setPoiFeatureFavorite(itinerary, feature, true, { ...options, pauseMin });
    }
    const row = findPoiRow(itinerary, feature.id);
    if (!row) return;
    row.durationMin = pauseMin;
    syncFeaturePause(itinerary, row);
    rememberCategoryPause(itinerary, row.poiCategory, pauseMin);
    return;
  }
  const row = findPoiRow(itinerary, feature.id);
  if (row) {
    row.durationMin = 0;
    syncFeaturePause(itinerary, row);
  } else {
    itinerary.poiFeatures = setPoiFeatureFavoriteState(
      itinerary.poiFeatures,
      feature.id,
      Boolean(feature.favorite),
      null,
    );
  }
}

/** Durée de la pause d'une ligne de POI (agenda) ; 0 = pas de pause. */
export function setPoiRowPauseDuration(itinerary: Itinerary, row: TimelineItem, durationMin: number): void {
  row.durationMin = Math.max(0, Math.round(durationMin));
  syncFeaturePause(itinerary, row);
}

function rememberCategoryPause(itinerary: Itinerary, category: PoiCategory | undefined, pauseMin: number): void {
  if (!category) return;
  const rhythm = normalizeItineraryRhythmState(itinerary.rhythm);
  const current = rhythm.poiPauseDurations[category];
  if (current != null && current > 0) return;
  rhythm.poiPauseDurations[category] = pauseMin;
  itinerary.rhythm = rhythm;
}
