import type { PoiCategory } from '@/features/poi/types';

import type { DashboardPoiOption } from './DashboardPlaceSearch.types';

export const SEARCH_PRELOAD_LEAD_MS = 140;
export const SEARCH_SATELLITE_PRELOAD_LEAD_MS = 240;
export const SEARCH_NEAR_ZOOM = 14.4;
export const SEARCH_MEDIUM_ZOOM = 13.4;
export const SEARCH_FAR_ZOOM = 12.35;
export const SEARCH_NEAR_MAX_KM = 45;
export const SEARCH_MEDIUM_MAX_KM = 180;
export const SEARCH_COUNTRIES = 'fr,ch,be,lu,it,de,es,ad';
export const SEARCH_SATELLITE_STAGE_MIN_KM = 16;
export const SEARCH_SATELLITE_NEAR_ENTRY_PITCH = 46;
export const SEARCH_SATELLITE_MEDIUM_ENTRY_PITCH = 34;
export const SEARCH_SATELLITE_FAR_ENTRY_PITCH = 26;
export const SEARCH_SATELLITE_NEAR_ZOOM_DELTA = 0.35;
export const SEARCH_SATELLITE_MEDIUM_ZOOM_DELTA = 0.7;
export const SEARCH_SATELLITE_FAR_ZOOM_DELTA = 0.95;
export const SEARCH_SATELLITE_NEAR_SETTLE_MS = 700;
export const SEARCH_SATELLITE_MEDIUM_SETTLE_MS = 1100;
export const SEARCH_SATELLITE_FAR_SETTLE_MS = 1500;
export const SEARCH_SATELLITE_NEAR_RESTORE_MS = 550;
export const SEARCH_SATELLITE_MEDIUM_RESTORE_MS = 700;
export const SEARCH_SATELLITE_FAR_RESTORE_MS = 900;
export const VIEWPORT_POI_MIN_ZOOM = 5.2;
export const VIEWPORT_POI_FETCH_DEBOUNCE_MS = 120;
export const POI_MENU_CLOSE_MS = 150;

export const DROPDOWN_VIEWPORT_POI_ICON_URLS: Partial<Record<PoiCategory, string>> = {
  drinking_water: '/svgv2/poi/dropdown-maps/water.svg',
  toilets: '/svgv2/poi/dropdown-maps/toilets.svg',
  supermarket: '/svgv2/poi/dropdown-maps/supermarket.svg',
  bakery: '/svgv2/poi/dropdown-maps/bakery.svg',
  fuel: '/svgv2/poi/dropdown-maps/fuel.svg',
  bar: '/svgv2/poi/dropdown-maps/bar.svg',
  cafe: '/svgv2/poi/dropdown-maps/cafe.svg',
  restaurant: '/svgv2/poi/dropdown-maps/restaurant.svg',
  convenience: '/svgv2/poi/dropdown-maps/shop.svg',
  hotel: '/svgv2/poi/dropdown-maps/hotel.svg',
  alpine_hut: '/svgv2/poi/dropdown-maps/refuge.svg',
};

export const DASHBOARD_POI_OPTIONS: readonly DashboardPoiOption[] = [
  { id: 'drinking_water', label: 'Eau', color: '#1447E6' },
  { id: 'toilets', label: 'Toilette', color: '#312C85' },
  { id: 'supermarket', label: 'Supermarché', color: '#F1B100' },
  { id: 'bakery', label: 'Boulangerie', color: '#FF6900' },
  { id: 'fuel', label: 'Station Service', color: '#CA3500' },
  { id: 'bar', label: 'Bar', color: '#C70036' },
  { id: 'cafe', label: 'Café', color: '#FF2157' },
  { id: 'restaurant', label: 'Restaurant', color: '#8B0836' },
  { id: 'convenience', label: 'Supermarché', color: '#A900B7' },
  { id: 'hotel', label: 'Hôtel', color: '#008236' },
  { id: 'alpine_hut', label: 'Refuge', color: '#7DCF00' },
  { id: 'bicycle', label: 'Magasin de vélo', color: '#63758E' },
] as const;