import type { PoiCategory as PanelPoiCategory } from '../../types';
import type { DashboardPoiOptionId } from '@/pages/Dashboard/components/DashboardPlaceSearch.types';

/**
 * Mapping between Dashboard POI Option IDs (from the top bar filter menu)
 * and panel PoiCategory IDs (used by TimelineItem and the corridor search).
 */
export const DASHBOARD_TO_PANEL_CATEGORY_MAP: Record<DashboardPoiOptionId, PanelPoiCategory[]> = {
  drinking_water: ['fountains'],
  toilets: ['toilets'],
  supermarket: ['supermarkets'],
  convenience: ['supermarkets'],
  bakery: ['bakeries'],
  fuel: ['gasStations'],
  bar: ['bars'],
  cafe: ['cafes'],
  restaurant: ['restaurants', 'fastFood'],
  hotel: ['hotels'],
  alpine_hut: ['refuges', 'passes'],
  bicycle: ['bikeShops'],
};

export const PANEL_TO_DASHBOARD_CATEGORY_MAP: Partial<Record<PanelPoiCategory, DashboardPoiOptionId>> = {
  fountains: 'drinking_water',
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
  passes: 'alpine_hut',
};

export const FEATURE_TO_DASHBOARD_CATEGORY: Partial<Record<string, DashboardPoiOptionId>> = {
  drinking_water: 'drinking_water',
  water_point: 'drinking_water',
  water_tap: 'drinking_water',
  spring: 'drinking_water',
  fountain: 'drinking_water',
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
  pass: 'alpine_hut',
  viewpoint: 'alpine_hut',
  picnic_site: 'alpine_hut',
  bicycle: 'bicycle',
  bicycle_repair: 'bicycle',
  compressed_air: 'bicycle',
  outdoor_shop: 'bicycle',
};

/**
 * Checks whether an item's POI category matches the active set of selected categories.
 * If selectedCategoryIds is empty or undefined, all categories match.
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

  // Direct match (if the set contains the category directly)
  if (selectedCategoryIds.has(itemCategory)) {
    return true;
  }

  // Match through feature category mapping (OSM feature categories)
  const featureDashboardId = FEATURE_TO_DASHBOARD_CATEGORY[itemCategory];
  if (featureDashboardId && selectedCategoryIds.has(featureDashboardId)) {
    return true;
  }

  // Match through dashboard option ID mapping
  const mappedDashboardId = PANEL_TO_DASHBOARD_CATEGORY_MAP[itemCategory as PanelPoiCategory];
  if (mappedDashboardId && selectedCategoryIds.has(mappedDashboardId)) {
    return true;
  }

  // Check reverse mapping for each entry in selectedCategoryIds
  for (const selectedId of selectedCategoryIds) {
    const panelCategories = DASHBOARD_TO_PANEL_CATEGORY_MAP[selectedId as DashboardPoiOptionId];
    if (panelCategories && panelCategories.includes(itemCategory as PanelPoiCategory)) {
      return true;
    }
  }

  return false;
}
