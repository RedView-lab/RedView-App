import type { PoiCategory as PanelPoiCategory } from '../../types';
import type { DashboardPoiOptionId } from '@/pages/Dashboard/components/DashboardPlaceSearch.types';

/**
 * Correspondance entre les ids d'option de POI du Dashboard (menu de filtre de
 * la barre du haut) et les ids de PoiCategory du panneau (utilisés par
 * TimelineItem et la recherche dans le couloir).
 */
const DASHBOARD_TO_PANEL_CATEGORY_MAP: Record<DashboardPoiOptionId, PanelPoiCategory[]> = {
  drinking_water: ['fountains'],
  cemetery: ['cemeteries'],
  toilets: ['toilets'],
  supermarket: ['supermarkets'],
  convenience: ['supermarkets'],
  bakery: ['bakeries'],
  fuel: ['gasStations'],
  bar: ['bars'],
  cafe: ['cafes'],
  restaurant: ['restaurants', 'fastFood'],
  hotel: ['hotels'],
  alpine_hut: ['refuges'],
  pass: ['passes'],
  bicycle: ['bikeShops'],
};

const PANEL_TO_DASHBOARD_CATEGORY_MAP: Partial<Record<PanelPoiCategory, DashboardPoiOptionId>> = {
  fountains: 'drinking_water',
  cemeteries: 'cemetery',
  toilets: 'toilets',
  supermarkets: 'supermarket',
  gasStations: 'fuel',
  bakeries: 'bakery',
  fastFood: 'restaurant',
  cafes: 'cafe',
  bars: 'bar',
  restaurants: 'restaurant',
  bikeShops: 'bicycle',
  hotels: 'hotel',
  refuges: 'alpine_hut',
  passes: 'pass',
};

const FEATURE_TO_DASHBOARD_CATEGORY: Partial<Record<string, DashboardPoiOptionId>> = {
  drinking_water: 'drinking_water',
  water_point: 'drinking_water',
  water_tap: 'drinking_water',
  spring: 'drinking_water',
  fountain: 'drinking_water',
  cemetery: 'cemetery',
  toilets: 'toilets',
  shower: 'toilets',
  supermarket: 'supermarket',
  convenience: 'convenience',
  marketplace: 'supermarket',
  bakery: 'bakery',
  butcher: 'bakery',
  ice_cream: 'bakery',
  fuel: 'fuel',
  charging_station: 'fuel',
  bar: 'bar',
  pub: 'bar',
  cafe: 'cafe',
  restaurant: 'restaurant',
  fast_food: 'restaurant',
  vending_machine: 'restaurant',
  hotel: 'hotel',
  camp_site: 'hotel',
  caravan_site: 'hotel',
  alpine_hut: 'alpine_hut',
  wilderness_hut: 'alpine_hut',
  shelter: 'alpine_hut',
  pass: 'pass',
  viewpoint: 'alpine_hut',
  picnic_site: 'alpine_hut',
  bicycle: 'bicycle',
  bicycle_repair: 'bicycle',
  compressed_air: 'bicycle',
  outdoor_shop: 'bicycle',
};

/**
 * Vérifie si la catégorie de POI d'un élément correspond à l'ensemble des
 * catégories sélectionnées. Si selectedCategoryIds est vide ou undefined,
 * toutes les catégories correspondent.
 */
export function matchesPoiCategory(
  itemCategory: PanelPoiCategory | string | undefined,
  selectedCategoryIds?: Set<string>,
): boolean {
  if (selectedCategoryIds === undefined) {
    return true;
  }
  if (selectedCategoryIds.size === 0) {
    return false;
  }
  if (!itemCategory) {
    return false;
  }

  // Correspondance directe (si l'ensemble contient directement la catégorie)
  if (selectedCategoryIds.has(itemCategory)) {
    return true;
  }

  // Correspondance via la table des catégories d'éléments (catégories OSM)
  const featureDashboardId = FEATURE_TO_DASHBOARD_CATEGORY[itemCategory];
  if (featureDashboardId && selectedCategoryIds.has(featureDashboardId)) {
    return true;
  }

  // Correspondance via la table des ids d'option du tableau de bord
  const mappedDashboardId = PANEL_TO_DASHBOARD_CATEGORY_MAP[itemCategory as PanelPoiCategory];
  if (mappedDashboardId && selectedCategoryIds.has(mappedDashboardId)) {
    return true;
  }

  // Vérifier la correspondance inverse pour chaque entrée de selectedCategoryIds
  for (const selectedId of selectedCategoryIds) {
    const panelCategories = DASHBOARD_TO_PANEL_CATEGORY_MAP[selectedId as DashboardPoiOptionId];
    if (panelCategories && panelCategories.includes(itemCategory as PanelPoiCategory)) {
      return true;
    }
  }

  return false;
}
