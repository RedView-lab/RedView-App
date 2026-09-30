import type { Itinerary, TimelineItem } from '../../types';
import type { PoiFeature } from '@/features/poi/types';
import { isAutoHotelOption } from '../../lib/schedule/poi-to-timeline';

/**
 * Pure helpers for reconciling POI favorite flags between the timeline rows
 * and the corridor feature list. Extracted from ItineraryPanelContainer so the
 * component stays focused on orchestration.
 */

/** Un favori basculé à la main n'est plus un favori du tri auto. */
export function setManualFavoriteOrigin(row: TimelineItem, favorite: boolean): void {
  delete row.autoReason;
  if (favorite) row.favoriteSource = 'manual';
  else delete row.favoriteSource;
}

export function setPoiFeatureFavoriteState(
  features: PoiFeature[] | undefined,
  poiId: number | string,
  favorite: boolean,
  pauseDurationMin?: number | null,
): PoiFeature[] | undefined {
  if (!features || features.length === 0) return features;

  let changed = false;
  const nextFeatures = features.map((feature) => {
    if (feature.id !== poiId && String(feature.id) !== String(poiId)) return feature;
    const nextPause = pauseDurationMin !== undefined ? pauseDurationMin : (feature.pauseDurationMin ?? null);
    const favoriteChanged = Boolean(feature.favorite) !== favorite;
    if (!favoriteChanged && (feature.pauseDurationMin ?? null) === nextPause) return feature;
    changed = true;
    const next: PoiFeature = { ...feature, favorite, pauseDurationMin: nextPause };
    // Seul le tri auto pose des favoris « auto » : tout basculement passant
    // par ici est un choix manuel.
    if (favoriteChanged) {
      delete next.autoReason;
      if (favorite) next.favoriteSource = 'manual';
      else delete next.favoriteSource;
    }
    return next;
  });

  return changed ? nextFeatures : features;
}

export function mergePoiFeatureFavorites(
  features: PoiFeature[],
  timeline: Itinerary['timeline'],
  currentFeatures: PoiFeature[],
  rhythm?: Itinerary['rhythm'],
): PoiFeature[] {
  if (features.length === 0) return features;

  const seenIds = new Set<string | number>();
  const uniqueFeatures: PoiFeature[] = [];
  for (const f of features) {
    if (seenIds.has(f.id)) continue;
    seenIds.add(f.id);
    uniqueFeatures.push(f);
  }

  const timelineFavorites = new Map<string | number, boolean>();
  const timelinePauseDurations = new Map<string | number, number | null>();
  const origins = new Map<string | number, FavoriteOrigin>();
  for (const feature of currentFeatures) {
    if (feature.favorite) origins.set(feature.id, originOf(feature));
  }
  for (const row of timeline) {
    if ((row.kind === 'poi' || row.kind === 'waypoint') && row.osmId != null) {
      if (row.favorite !== undefined) {
        timelineFavorites.set(row.osmId, Boolean(row.favorite));
      }
      if (row.favorite) origins.set(row.osmId, originOf(row));
      if (row.durationMin !== undefined) {
        timelinePauseDurations.set(
          row.osmId,
          row.durationMin != null && row.durationMin > 0 ? row.durationMin : null,
        );
      } else if (row.favorite && rhythm?.pauseAtFavoritePois && row.poiCategory && !isAutoHotelOption(row)) {
        const catDuration = rhythm.poiPauseDurations[row.poiCategory];
        if (catDuration != null && catDuration > 0) {
          timelinePauseDurations.set(row.osmId, catDuration);
        }
      }
    }
  }

  const currentFavorites = new Map<string | number, boolean>();
  const currentPauseDurations = new Map<string | number, number | null>();
  for (const feature of currentFeatures) {
    if (feature.favorite != null) {
      currentFavorites.set(feature.id, feature.favorite);
    }
    if (feature.pauseDurationMin !== undefined) {
      currentPauseDurations.set(feature.id, feature.pauseDurationMin);
    }
  }

  let changed = uniqueFeatures.length !== features.length;
  const merged = uniqueFeatures.map((feature) => {
    const nextFavorite = timelineFavorites.get(feature.id)
      ?? currentFavorites.get(feature.id)
      ?? Boolean(feature.favorite);
    const nextPause = timelinePauseDurations.has(feature.id)
      ? timelinePauseDurations.get(feature.id)!
      : (currentPauseDurations.has(feature.id)
          ? currentPauseDurations.get(feature.id)!
          : (feature.pauseDurationMin ?? null));
    const origin: FavoriteOrigin = nextFavorite
      ? (origins.get(feature.id) ?? originOf(feature))
      : {};
    if (
      Boolean(feature.favorite) === nextFavorite &&
      (feature.pauseDurationMin ?? null) === nextPause &&
      feature.favoriteSource === origin.favoriteSource &&
      feature.autoReason === origin.autoReason
    ) {
      return feature;
    }
    changed = true;
    const next: PoiFeature = { ...feature, favorite: nextFavorite, pauseDurationMin: nextPause };
    delete next.favoriteSource;
    delete next.autoReason;
    return { ...next, ...origin };
  });

  return changed ? merged : features;
}

type FavoriteOrigin = Pick<PoiFeature, 'favoriteSource' | 'autoReason'>;

/** Origine d'un favori (manuel / tri auto), sans clés `undefined`. */
function originOf(item: FavoriteOrigin): FavoriteOrigin {
  const origin: FavoriteOrigin = {};
  if (item.favoriteSource) origin.favoriteSource = item.favoriteSource;
  if (item.autoReason) origin.autoReason = item.autoReason;
  return origin;
}
