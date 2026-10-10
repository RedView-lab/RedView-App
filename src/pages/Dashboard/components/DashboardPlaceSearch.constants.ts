import type { PoiCategory } from '@/features/poi/types';

import type {
  DashboardFilterOption,
  DashboardPoiOption,
  DashboardPoiSourceOption,
} from './DashboardPlaceSearch.types';

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
/**
 * En dessous, la vue couvre plus que la base POI (France + frontaliers) : les
 * icônes n'apporteraient que du bruit. Au-dessus, le serveur échantillonne
 * par cellule, la densité reste donc lisible à tout zoom.
 */
export const VIEWPORT_POI_MIN_ZOOM = 5;
export const VIEWPORT_POI_FETCH_DEBOUNCE_MS = 160;
export const POI_MENU_CLOSE_MS = 150;

export const DROPDOWN_VIEWPORT_POI_ICON_URLS: Partial<Record<PoiCategory, string>> = {
  drinking_water: '/icons/poi/dropdown-maps/water.svg',
  cemetery: '/icons/poi/dropdown-maps/cemetery.svg',
  toilets: '/icons/poi/dropdown-maps/toilets.svg',
  supermarket: '/icons/poi/dropdown-maps/supermarket.svg',
  bakery: '/icons/poi/dropdown-maps/bakery.svg',
  fuel: '/icons/poi/dropdown-maps/fuel.svg',
  bar: '/icons/poi/dropdown-maps/bar.svg',
  cafe: '/icons/poi/dropdown-maps/cafe.svg',
  restaurant: '/icons/poi/dropdown-maps/restaurant.svg',
  convenience: '/icons/poi/dropdown-maps/bakery.svg',
  hotel: '/icons/poi/dropdown-maps/hotel.svg',
  alpine_hut: '/icons/poi/dropdown-maps/refuge.svg',
  bicycle: '/icons/poi/dropdown-maps/bicycle.svg',
};

export const DASHBOARD_POI_OPTIONS: readonly DashboardPoiOption[] = [
  { id: 'drinking_water', label: 'Eau', color: '#1447E6' },
  { id: 'cemetery', label: 'Cimetière', color: '#00786F' },
  { id: 'toilets', label: 'Toilette', color: '#312C85' },
  { id: 'supermarket', label: 'Supermarché', color: '#F1B100' },
  { id: 'bakery', label: 'Boulangerie', color: '#FF6900' },
  { id: 'fuel', label: 'Station Service', color: '#CA3500' },
  { id: 'bar', label: 'Bar', color: '#C70036' },
  { id: 'cafe', label: 'Café', color: '#FF2157' },
  { id: 'restaurant', label: 'Restaurant', color: '#8B0836' },
  { id: 'convenience', label: 'Épicerie', color: '#FF6900' },
  { id: 'hotel', label: 'Hôtel', color: '#008236' },
  { id: 'alpine_hut', label: 'Refuge', color: '#7DCF00' },
  { id: 'pass', label: 'Col', color: '#5A5A5A' },
  { id: 'bicycle', label: 'Magasin de vélo', color: '#63758E' },
] as const;

export const DASHBOARD_FILTER_OPTIONS: readonly DashboardFilterOption[] = [
  { id: 'favoris', label: 'Favoris', icon: 'search-filter-favoris.svg' },
  { id: 'pois', label: 'POI', icon: 'search-filter-pois-route.svg', hasDropdown: true },
  { id: 'waypoints', label: 'Points de passage', icon: 'search-filter-waypoints.svg' },
  { id: 'pauses', label: 'Pauses', icon: 'search-filter-pauses.svg' },
  { id: 'alertes', label: 'Alertes', icon: 'search-filter-alertes.svg' },
  { id: 'pente', label: 'Pente', slopeSwatch: true },
] as const;

/*
 * Largeurs (px logiques, bascule du panneau comprise) des paliers de densité
 * de la barre de recherche ; la ligne ne passe jamais à la ligne, les libellés
 * rétrécissent avec une ellipse entre deux (dashboard-place-search.css).
 * Calculées à partir des pastilles ci-dessus avec les largeurs minimales de ce
 * CSS, pour qu'une nouvelle pastille déplace les paliers avec elle : ils ont
 * été écrits un jour pour cinq pastilles, et la sixième (« Pente ») poussait
 * la ligne sous le panneau de droite sur les écrans de 1280 à 1600 px.
 *
 * TIGHT : pastilles normales avec des amorces de libellé de 22 px — bascule 40
 * + écart 12 + champ de recherche à son minimum de 96 px, puis les pastilles
 * (121 avec un chevron, 100 sinon), à 4 px d'écart. En dessous, les pastilles
 * se resserrent (--tight : 87 / 71, à 3 px d'écart, champ de recherche réduit
 * à sa loupe de 32 px).
 * ICONS : encore en dessous, les libellés disparaissent (infobulle seulement).
 */
function placeSearchRowWidth(searchMin: number, chipMin: number, menuChipMin: number, gap: number): number {
  const menus = DASHBOARD_FILTER_OPTIONS.filter((option) => option.hasDropdown).length;
  const chips = DASHBOARD_FILTER_OPTIONS.length;
  // Bascule + PANEL_PADDING, champ de recherche, puis les pastilles ; 10 px de marge.
  return 40 + 12 + searchMin + menus * menuChipMin + (chips - menus) * chipMin + chips * gap + 10;
}

export const PLACE_SEARCH_TIGHT_WIDTH = placeSearchRowWidth(96, 100, 121, 4);
export const PLACE_SEARCH_ICONS_WIDTH = placeSearchRowWidth(32, 71, 87, 3);

/** Cases du menu « POI », au-dessus des catégories. */
export const DASHBOARD_POI_SOURCE_OPTIONS: readonly DashboardPoiSourceOption[] = [
  { id: 'pois_route', label: 'POI sur itinéraire' },
  { id: 'pois_map', label: 'POI carte' },
] as const;