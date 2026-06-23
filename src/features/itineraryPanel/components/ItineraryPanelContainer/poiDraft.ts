import { FEATURE_TO_PANEL_POI, poiFeaturesToTimelineItems } from '../../lib/schedule';
import { POI_LABELS, type PoiFeature } from '@/features/poi/types';
import type {
  Itinerary,
} from '../../types';
import type {
  MapContextMenuPoint,
  MapPoiDraft,
} from '@/features/map3d';

/**
 * Pure builders + timeline mutators used when a POI draft (or map context
 * menu action) is folded into an itinerary. These operate on a cloned
 * itinerary, so callers are free to mutate in place.
 *
 * Extracted from ItineraryPanelContainer for clarity.
 */

export function resolveMapContextPointTitle(point: MapContextMenuPoint): string {
  return point.title?.trim() || point.coordinatesLabel;
}

export function resolveDraftTitle(draft: MapPoiDraft): string {
  return draft.name?.trim() || draft.point.title?.trim() || 'POI';
}

export function resolveDraftFeatureId(draft: MapPoiDraft): number {
  const match = /(\d+)$/.exec(draft.id);
  const parsed = match ? Number.parseInt(match[1], 10) : Number.NaN;
  return Number.isFinite(parsed) ? -parsed : -Date.now();
}

export function buildDraftPoiFeature(draft: MapPoiDraft): PoiFeature | null {
  if (!draft.category) return null;

  return {
    id: resolveDraftFeatureId(draft),
    lat: draft.point.lat,
    lon: draft.point.lng,
    category: draft.category,
    name: resolveDraftTitle(draft),
    tags: { source: 'redview_custom_poi' },
    favorite: draft.favorite,
  };
}

export function buildTimelineRowFromPoiFeature(
  itinerary: Itinerary,
  feature: PoiFeature,
): Itinerary['timeline'][number] | null {
  const panelCategory = FEATURE_TO_PANEL_POI[feature.category];
  if (!panelCategory) return null;

  const routePoints = itinerary.gpxRoute?.points.map((point) => ({ lat: point.lat, lon: point.lon })) ?? [];
  const projectedRow = routePoints.length >= 2 ? poiFeaturesToTimelineItems([feature], routePoints)[0] : null;
  if (projectedRow) return projectedRow;

  return {
    id: `poi-${feature.id}`,
    kind: 'poi',
    label: feature.name?.trim() || POI_LABELS[feature.category] || 'POI',
    distanceKm: null,
    lat: feature.lat,
    lon: feature.lon,
    poiCategory: panelCategory,
    osmId: feature.id,
    favorite: feature.favorite,
    visible: true,
  };
}

export function upsertDraftPoiIntoItinerary(itinerary: Itinerary, draft: MapPoiDraft): number | null {
  const feature = buildDraftPoiFeature(draft);
  if (!feature) return null;

  const currentFeatures = itinerary.poiFeatures ?? [];
  const existingFeatureIndex = currentFeatures.findIndex((entry) => entry.id === feature.id);
  itinerary.poiFeatures = existingFeatureIndex >= 0
    ? currentFeatures.map((entry, index) => (index === existingFeatureIndex ? { ...entry, ...feature } : entry))
    : [...currentFeatures, feature];

  const nextRow = buildTimelineRowFromPoiFeature(itinerary, feature);
  if (!nextRow) return feature.id;

  const existingRowIndex = itinerary.timeline.findIndex((row) => row.kind === 'poi' && row.osmId === feature.id);
  if (existingRowIndex >= 0) {
    const previous = itinerary.timeline[existingRowIndex];
    itinerary.timeline[existingRowIndex] = {
      ...nextRow,
      visible: previous.visible ?? nextRow.visible,
      favorite: feature.favorite,
      distanceKm: nextRow.distanceKm ?? previous.distanceKm ?? null,
    };
    return feature.id;
  }

  let insertAt = itinerary.timeline.findIndex((row) => row.kind === 'end');
  if (insertAt < 0) insertAt = itinerary.timeline.length;

  if (nextRow.distanceKm != null) {
    const nextDistanceKm = nextRow.distanceKm;
    const distanceInsertIndex = itinerary.timeline.findIndex((row) => (
      row.kind !== 'start'
      && (row.kind === 'end' || (row.distanceKm != null && row.distanceKm > nextDistanceKm))
    ));
    if (distanceInsertIndex >= 0) {
      insertAt = distanceInsertIndex;
    }
  }

  itinerary.timeline.splice(insertAt, 0, nextRow);
  return feature.id;
}

export function removePoiAndLinkedWaypoints(itinerary: Itinerary, poiId: number): void {
  if (itinerary.poiFeatures) {
    itinerary.poiFeatures = itinerary.poiFeatures.filter((feature) => feature.id !== poiId);
  }

  itinerary.timeline = itinerary.timeline.filter((row) => !(
    (row.kind === 'poi' && row.osmId === poiId)
    || (row.kind === 'waypoint' && row.osmId === poiId)
    || row.id === `poi-waypoint-${poiId}`
  ));
}
