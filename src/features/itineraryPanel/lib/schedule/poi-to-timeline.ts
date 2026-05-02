/**
 * Convert POI corridor results into Timeline rows.
 *
 * - Maps OSM/Overpass categories back onto the panel's POI taxonomy
 *   (Figma rows: Eau, Boulangerie, Supermarché, …).
 * - Projects each POI onto the active GPX route to derive a
 *   `distanceKm` from the start, so the rows can be inserted in
 *   physical order between the Départ and Fin checkpoints.
 */
import type { PoiFeature, PoiCategory as FeaturePoiCategory } from '@/features/poi/types';
import { POI_LABELS } from '@/features/poi/types';

import {
  cumulativeRouteLengthsM,
  projectDistanceAlongRouteM,
  roundDistanceKm,
} from '../routes';
import type { PoiCategory as PanelPoiCategory, TimelineItem } from '../../types';

/** OSM/Overpass → panel category. Anything not listed here is dropped. */
export const FEATURE_TO_PANEL_POI: Partial<Record<FeaturePoiCategory, PanelPoiCategory>> = {
  drinking_water: 'fountains',
  toilets: 'toilets',
  supermarket: 'supermarkets',
  convenience: 'supermarkets',
  fuel: 'gasStations',
  bakery: 'bakeries',
  fast_food: 'fastFood',
  cafe: 'cafes',
  bar: 'bars',
  restaurant: 'restaurants',
  bicycle: 'bikeShops',
  bicycle_repair: 'bikeShops',
  hotel: 'hotels',
  alpine_hut: 'refuges',
  shelter: 'refuges',
  camp_site: 'refuges',
};

/**
 * Convert POI features into ordered TimelineItems with `kind: 'poi'`.
 *
 * Items are sorted by their projected distance along the route so they
 * fall in physical order when inserted between Départ and Fin.
 */
export function poiFeaturesToTimelineItems(
  features: PoiFeature[],
  routePoints: { lat: number; lon: number }[],
): TimelineItem[] {
  if (features.length === 0 || routePoints.length < 2) return [];

  const cumulativeLengths = cumulativeRouteLengthsM(routePoints);

  const rows: TimelineItem[] = [];
  for (const f of features) {
    const panelKey = FEATURE_TO_PANEL_POI[f.category];
    if (!panelKey) continue;
    const distM = projectDistanceAlongRouteM(
      { lat: f.lat, lon: f.lon },
      routePoints,
      cumulativeLengths,
    );
    if (distM == null) continue;
    rows.push({
      id: `poi-${f.id}`,
      kind: 'poi',
      label: f.name?.trim() || POI_LABELS[f.category] || 'POI',
      distanceKm: roundDistanceKm(distM),
      lat: f.lat,
      lon: f.lon,
      poiCategory: panelKey,
      osmId: f.id,
      visible: true,
    });
  }

  rows.sort((a, b) => (a.distanceKm ?? 0) - (b.distanceKm ?? 0));
  return rows;
}
