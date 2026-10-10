/**
 * Convertit les résultats de POI du couloir en lignes de timeline.
 *
 * - Fait correspondre les catégories OSM/Overpass à la taxonomie des POI du
 *   panneau (lignes Figma : Eau, Boulangerie, Supermarché, …).
 * - Projette chaque POI sur le tracé GPX actif pour en déduire une `distanceKm`
 *   depuis le départ, afin d'insérer les lignes dans l'ordre physique entre les
 *   points de contrôle Départ et Fin.
 */
import type { PoiFeature, PoiCategory as FeaturePoiCategory } from '@/features/poi/types';
import { POI_LABELS } from '@/features/poi/types';

import {
  projectDistanceAlongRouteM,
  roundDistanceKm,
  routeDistancesM,
} from '../routes';
import type { PoiCategory as PanelPoiCategory, TimelineItem } from '../../types';

/**
 * Catégorie OSM → ligne du panneau. Ce qui n'est pas listé ici est écarté de
 * la feuille de route (mais reste affiché sur la carte).
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
  cemetery: 'cemeteries',
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
  // Transport et services
  train_station: 'transport',
  bus_station: 'transport',
  ferry_terminal: 'transport',
  atm: 'transport',
  post_office: 'transport',
  laundry: 'transport',
};

/**
 * Hôtel retenu par le tri auto : une option pour la nuit parmi plusieurs
 * (jusqu'à 5 par nuit), pas un arrêt. Il ne pose donc pas de pause, même
 * quand les favoris en marquent une.
 */
export function isAutoHotelOption(item: Pick<TimelineItem, 'favoriteSource' | 'autoReason'>): boolean {
  return item.favoriteSource === 'auto' && item.autoReason === 'hotel';
}

/**
 * Convertit des éléments POI en TimelineItems ordonnés avec `kind: 'poi'`.
 *
 * Les éléments sont triés par leur distance projetée le long du tracé pour
 * tomber dans l'ordre physique une fois insérés entre Départ et Fin.
 */
export function poiFeaturesToTimelineItems(
  features: PoiFeature[],
  routePoints: { lat: number; lon: number; distanceM?: number }[],
): TimelineItem[] {
  if (features.length === 0 || routePoints.length < 2) return [];

  // Axe de la prédiction : les distances portées par le tracé (trace d'origine).
  const cumulativeLengths = routeDistancesM(routePoints);

  const rows: TimelineItem[] = [];
  const seenIds = new Set<string | number>();

  for (const f of features) {
    if (seenIds.has(f.id)) continue;
    seenIds.add(f.id);

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
      ...(f.favorite && f.favoriteSource ? { favoriteSource: f.favoriteSource } : {}),
      ...(f.favorite && f.autoReason ? { autoReason: f.autoReason } : {}),
      visible: true,
    });
  }

  rows.sort((a, b) => (a.distanceKm ?? 0) - (b.distanceKm ?? 0));
  return rows;
}
