// POI icon URL resolution.
//
// Markers are DOM overlays (`lib/poi-markers.ts`) that reference these SVGs
// directly via `<img src>`, so there is no Mapbox sprite/atlas registration
// pipeline here — just URL lookups shared by the markers, the POI popup and
// the Dashboard search dropdowns.

import type { PoiCategory } from '../types';
import { PROVIDED_POI_SVG } from './providedPoiSvg';

const FALLBACK_POI_ICON_URL = '/svgv2/icone/x.svg';

const PROVIDED_ICON_URLS: Record<PoiCategory, string> = {
  drinking_water: PROVIDED_POI_SVG.water,
  bakery: PROVIDED_POI_SVG.bakery,
  convenience: PROVIDED_POI_SVG.shop,
  supermarket: PROVIDED_POI_SVG.supermarket,
  bicycle: PROVIDED_POI_SVG.bikeShop,
  bicycle_repair: PROVIDED_POI_SVG.bikeShop,
  toilets: PROVIDED_POI_SVG.toilet,
  fuel: PROVIDED_POI_SVG.fuel,
  fast_food: PROVIDED_POI_SVG.fastFood,
  cafe: PROVIDED_POI_SVG.cafe,
  bar: PROVIDED_POI_SVG.bar,
  restaurant: PROVIDED_POI_SVG.restaurant,
  hotel: PROVIDED_POI_SVG.hotelPin,
  alpine_hut: PROVIDED_POI_SVG.refugePin,
  camp_site: PROVIDED_POI_SVG.refugePin,
  shelter: PROVIDED_POI_SVG.refugePin,
  pharmacy: FALLBACK_POI_ICON_URL,
  hospital: FALLBACK_POI_ICON_URL,
};

const PROVIDED_FAVORITE_ICON_URLS: Partial<Record<PoiCategory, string>> = {
  drinking_water: PROVIDED_POI_SVG.favoriteWater,
  bakery: PROVIDED_POI_SVG.favoriteBakery,
  convenience: PROVIDED_POI_SVG.favoriteShop,
  supermarket: PROVIDED_POI_SVG.favoriteSupermarket,
  toilets: PROVIDED_POI_SVG.favoriteToilet,
  fuel: PROVIDED_POI_SVG.favoriteFuel,
  fast_food: PROVIDED_POI_SVG.favoriteFastFood,
  cafe: PROVIDED_POI_SVG.favoriteCafe,
  bar: PROVIDED_POI_SVG.favoriteBar,
  restaurant: PROVIDED_POI_SVG.favoriteRestaurant,
  hotel: PROVIDED_POI_SVG.favoriteHotelPin,
  alpine_hut: PROVIDED_POI_SVG.favoriteRefugePin,
  camp_site: PROVIDED_POI_SVG.favoriteRefugePin,
  shelter: PROVIDED_POI_SVG.favoriteRefugePin,
};

/** True when the category ships a dedicated "favorite" SVG variant. */
export function hasDedicatedFavoritePoiIcon(category: PoiCategory): boolean {
  return Boolean(PROVIDED_FAVORITE_ICON_URLS[category]);
}

/** Resolve the SVG URL for a category, favoring the favorite variant. */
export function getPoiIconUrl(category: PoiCategory, favorite: boolean = false): string {
  if (favorite) {
    return PROVIDED_FAVORITE_ICON_URLS[category] ?? PROVIDED_ICON_URLS[category] ?? FALLBACK_POI_ICON_URL;
  }

  return PROVIDED_ICON_URLS[category] ?? FALLBACK_POI_ICON_URL;
}
