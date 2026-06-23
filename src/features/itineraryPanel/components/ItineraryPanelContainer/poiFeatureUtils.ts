import type { Itinerary } from '../../types';
import type { PoiFeature } from '@/features/poi/types';

/**
 * Pure helpers for reconciling POI favorite flags between the timeline rows
 * and the corridor feature list. Extracted from ItineraryPanelContainer so the
 * component stays focused on orchestration.
 */

export function setPoiFeatureFavoriteState(
  features: PoiFeature[] | undefined,
  poiId: number,
  favorite: boolean,
): PoiFeature[] | undefined {
  if (!features || features.length === 0) return features;

  let changed = false;
  const nextFeatures = features.map((feature) => {
    if (feature.id !== poiId) return feature;
    if (Boolean(feature.favorite) === favorite) return feature;
    changed = true;
    return { ...feature, favorite };
  });

  return changed ? nextFeatures : features;
}

export function mergePoiFeatureFavorites(
  features: PoiFeature[],
  timeline: Itinerary['timeline'],
  currentFeatures: PoiFeature[],
): PoiFeature[] {
  if (features.length === 0) return features;

  const timelineFavorites = new Map<number, boolean>();
  for (const row of timeline) {
    if (row.kind === 'poi' && row.osmId != null) {
      timelineFavorites.set(row.osmId, Boolean(row.favorite));
    }
  }

  const currentFavorites = new Map<number, boolean>();
  for (const feature of currentFeatures) {
    if (feature.favorite != null) {
      currentFavorites.set(feature.id, feature.favorite);
    }
  }

  let changed = false;
  const merged = features.map((feature) => {
    const nextFavorite = timelineFavorites.get(feature.id)
      ?? currentFavorites.get(feature.id)
      ?? Boolean(feature.favorite);
    if (Boolean(feature.favorite) === nextFavorite) {
      return feature;
    }
    changed = true;
    return { ...feature, favorite: nextFavorite };
  });

  return changed ? merged : features;
}
