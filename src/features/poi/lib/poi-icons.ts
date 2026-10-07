// POI icon URL resolution.
//
// Markers are DOM overlays (`lib/poi-markers.ts`) that reference these SVGs
// directly via `<img src>`, so there is no Mapbox sprite/atlas registration
// pipeline here — just URL lookups shared by the markers, the POI popup and
// the Dashboard search dropdowns.
//
// La taxonomie (`poi-taxonomy.json`) déclare pour chaque catégorie un nom
// d'icône *logique* (`drinking_water`, `shop`, `refuge`, `medical`, …). C'est
// ce vocabulaire qui est résolu ici vers un asset réel. Le jeu d'assets POI
// existant ne couvre pas encore les 46 catégories : les catégories nouvelles
// réutilisent l'icône la plus proche, et un asset dédié pourra être ajouté
// plus tard sans toucher à la taxonomie ni à la base.

import { POI_ICON_NAMES, type PoiCategory } from '../types';
import { PROVIDED_POI_SVG } from './providedPoiSvg';

const FALLBACK_POI_ICON_URL = '/icons/ui/x.svg';

/** Résolution d'un nom d'icône logique → URL d'asset. */
const LOGICAL_ICON_URLS: Record<string, string> = {
  drinking_water: PROVIDED_POI_SVG.water,
  supermarket: PROVIDED_POI_SVG.supermarket,
  shop: PROVIDED_POI_SVG.bakery,
  bakery: PROVIDED_POI_SVG.bakery,
  restaurant: PROVIDED_POI_SVG.restaurant,
  fast_food: PROVIDED_POI_SVG.fastFood,
  cafe: PROVIDED_POI_SVG.cafe,
  bar: PROVIDED_POI_SVG.bar,
  hotel: PROVIDED_POI_SVG.hotelPin,
  refuge: PROVIDED_POI_SVG.refugePin,
  bicycle: PROVIDED_POI_SVG.bikeShop,
  toilets: PROVIDED_POI_SVG.toilet,
  fuel: PROVIDED_POI_SVG.fuel,
  waypoint: PROVIDED_POI_SVG.waypoint,
  medical: '/icons/ui/plus-circle.svg',
  police: '/icons/ui/flag-02.svg',
  transport: '/icons/ui/marker-pin-02.svg',
  cash: '/icons/ui/credit-card-02.svg',
  mail: '/icons/ui/mail-02.svg',
  scenic: PROVIDED_POI_SVG.refugePin,
};

/** Variantes « rond » (carte, itinéraire standard), par nom d'icône logique. */
const LOGICAL_ROUND_ICON_URLS: Record<string, string> = {
  drinking_water: '/icons/poi/dropdown-maps/water.svg',
  supermarket: '/icons/poi/dropdown-maps/supermarket.svg',
  shop: '/icons/poi/dropdown-maps/bakery.svg',
  bakery: '/icons/poi/dropdown-maps/bakery.svg',
  restaurant: '/icons/poi/dropdown-maps/restaurant.svg',
  fast_food: '/icons/poi/dropdown-maps/fast-food.svg',
  cafe: '/icons/poi/dropdown-maps/cafe.svg',
  bar: '/icons/poi/dropdown-maps/bar.svg',
  hotel: '/icons/poi/dropdown-maps/hotel.svg',
  refuge: '/icons/poi/dropdown-maps/refuge.svg',
  bicycle: '/icons/poi/dropdown-maps/bicycle.svg',
  toilets: '/icons/poi/dropdown-maps/toilets.svg',
  fuel: '/icons/poi/dropdown-maps/fuel.svg',
  waypoint: '/icons/ui/checkpoint-waypoint.svg',
  medical: '/icons/ui/plus-circle.svg',
  police: '/icons/ui/flag-02.svg',
  transport: '/icons/ui/marker-pin-02.svg',
  cash: '/icons/ui/credit-card-02.svg',
  mail: '/icons/ui/mail-02.svg',
  scenic: '/icons/poi/dropdown-maps/refuge.svg',
};

/** Variantes « pointe / favori » disponibles, par nom d'icône logique. */
const LOGICAL_FAVORITE_ICON_URLS: Record<string, string> = {
  drinking_water: PROVIDED_POI_SVG.favoriteWater,
  bakery: PROVIDED_POI_SVG.favoriteBakery,
  shop: PROVIDED_POI_SVG.favoriteBakery,
  supermarket: PROVIDED_POI_SVG.favoriteSupermarket,
  toilets: PROVIDED_POI_SVG.favoriteToilet,
  fuel: PROVIDED_POI_SVG.favoriteFuel,
  fast_food: PROVIDED_POI_SVG.favoriteFastFood,
  cafe: PROVIDED_POI_SVG.favoriteCafe,
  bar: PROVIDED_POI_SVG.favoriteBar,
  restaurant: PROVIDED_POI_SVG.favoriteRestaurant,
  hotel: PROVIDED_POI_SVG.favoriteHotelPin,
  refuge: PROVIDED_POI_SVG.favoriteRefugePin,
  scenic: PROVIDED_POI_SVG.favoriteRefugePin,
};

function logicalName(category: PoiCategory): string {
  return POI_ICON_NAMES[category] ?? 'fallback';
}

/** True when the category ships a dedicated "favorite" SVG variant. */
export function hasDedicatedFavoritePoiIcon(category: PoiCategory): boolean {
  return Boolean(LOGICAL_FAVORITE_ICON_URLS[logicalName(category)]);
}

/**
 * Resolve the SVG URL for a category:
 * - Round icon for standard POIs (!favorite)
 * - Pointed pin icon ("le truc avec la pointe") for favorite POIs
 */
export function getPoiIconUrl(category: PoiCategory, favorite: boolean = false): string {
  const name = logicalName(category);
  if (!favorite) {
    return LOGICAL_ROUND_ICON_URLS[name] ?? LOGICAL_ICON_URLS[name] ?? FALLBACK_POI_ICON_URL;
  }
  return LOGICAL_FAVORITE_ICON_URLS[name] ?? LOGICAL_ICON_URLS[name] ?? FALLBACK_POI_ICON_URL;
}
