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

export function getPoiIconUrl(category: PoiCategory): string {
  return PROVIDED_ICON_URLS[category] ?? FALLBACK_POI_ICON_URL;
}
