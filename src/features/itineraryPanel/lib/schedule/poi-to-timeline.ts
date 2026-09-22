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

/**
 * OSM category → panel row. Anything not listed here is dropped from the
 * timeline (but still rendered on the map).
 *
 * Doit rester l'exact inverse de `PANEL_TO_FEATURE_POI`
 * (itineraryPanel/hooks/useItineraryPoiMap.ts) : une catégorie ajoutée à la
 * taxonomie sans entrée ici disparaîtrait silencieusement de la timeline.
 */
export const FEATURE_TO_PANEL_POI: Partial<Record<FeaturePoiCategory, PanelPoiCategory>> = {
  // Eau
  drinking_water: 'fountains',
  water_point: 'fountains',
  water_tap: 'fountains',
  spring: 'fountains',
  fountain: 'fountains',
  // Sanitaires
  toilets: 'toilets',
  shower: 'toilets',
  // Ravitaillement
  supermarket: 'supermarkets',
  convenience: 'supermarkets',
  marketplace: 'supermarkets',
  bakery: 'bakeries',
  butcher: 'bakeries',
  ice_cream: 'bakeries',
  fast_food: 'fastFood',
  vending_machine: 'fastFood',
  cafe: 'cafes',
  bar: 'bars',
  pub: 'bars',
  restaurant: 'restaurants',
  // Carburant / recharge
  fuel: 'gasStations',
  charging_station: 'gasStations',
  // Vélo
  bicycle: 'bikeShops',
  bicycle_repair: 'bikeShops',
  compressed_air: 'bikeShops',
  outdoor_shop: 'bikeShops',
  // Dormir
  hotel: 'hotels',
  camp_site: 'hotels',
  caravan_site: 'hotels',
  alpine_hut: 'refuges',
  wilderness_hut: 'refuges',
  shelter: 'refuges',
  // Paysage
  pass: 'passes',
  viewpoint: 'passes',
  picnic_site: 'passes',
  // Santé & sécurité
  pharmacy: 'health',
  hospital: 'health',
  clinic: 'health',
  doctors: 'health',
  defibrillator: 'health',
  police: 'health',
  // Transport & services
  train_station: 'transport',
  bus_station: 'transport',
  ferry_terminal: 'transport',
  atm: 'transport',
  post_office: 'transport',
  laundry: 'transport',
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
      favorite: f.favorite,
      visible: true,
    });
  }

  rows.sort((a, b) => (a.distanceKm ?? 0) - (b.distanceKm ?? 0));
  return rows;
}
