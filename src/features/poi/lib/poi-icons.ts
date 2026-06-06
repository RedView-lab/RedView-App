import type { Map as MapboxMap } from 'mapbox-gl';
import { POI_CATEGORIES, type PoiCategory } from '../types';
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

export function hasDedicatedFavoritePoiIcon(category: PoiCategory): boolean {
  return Boolean(PROVIDED_FAVORITE_ICON_URLS[category]);
}

export function getPoiIconUrl(category: PoiCategory, favorite: boolean = false): string {
  if (favorite) {
    return PROVIDED_FAVORITE_ICON_URLS[category] ?? PROVIDED_ICON_URLS[category] ?? FALLBACK_POI_ICON_URL;
  }

  return PROVIDED_ICON_URLS[category] ?? FALLBACK_POI_ICON_URL;
}

export function getPoiLayerIconId(category: PoiCategory, favorite: boolean = false): string {
  return favorite && hasDedicatedFavoritePoiIcon(category)
    ? `poi-${category}-favorite`
    : `poi-${category}`;
}

function loadMapImage(
  map: MapboxMap,
  url: string,
): Promise<HTMLImageElement | ImageBitmap | ImageData> {
  return new Promise((resolve, reject) => {
    map.loadImage(url, (error, image) => {
      if (error) {
        reject(error);
        return;
      }
      if (!image) {
        reject(new Error(`Mapbox returned no image for ${url}`));
        return;
      }
      resolve(image);
    });
  });
}

export async function registerPoiIcons(map: MapboxMap): Promise<void> {
  for (const category of POI_CATEGORIES) {
    const baseId = getPoiLayerIconId(category, false);
    if (!map.hasImage(baseId)) {
      const image = await loadMapImage(map, getPoiIconUrl(category, false));
      map.addImage(baseId, image);
    }

    const favoriteId = getPoiLayerIconId(category, true);
    if (favoriteId !== baseId && !map.hasImage(favoriteId)) {
      const image = await loadMapImage(map, getPoiIconUrl(category, true));
      map.addImage(favoriteId, image);
    }
  }
}

export function resetIconRegistration(map: MapboxMap): void {
  for (const category of POI_CATEGORIES) {
    const baseId = getPoiLayerIconId(category, false);
    if (map.hasImage(baseId)) {
      map.removeImage(baseId);
    }
    const favoriteId = getPoiLayerIconId(category, true);
    if (favoriteId !== baseId && map.hasImage(favoriteId)) {
      map.removeImage(favoriteId);
    }
  }
}
