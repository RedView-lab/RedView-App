import type { Map as MapboxMap } from 'mapbox-gl';
import { POI_CATEGORIES, type PoiCategory } from '../types';
import { PROVIDED_POI_SVG } from './providedPoiSvg';

const FALLBACK_POI_ICON_URL = '/svgv2/icone/x.svg';

/**
 * Map image id of a guaranteed-visible fallback dot. It is drawn locally
 * on a canvas (no network), so it is always available the instant the POI
 * symbol layer is created — even before the per-category SVG sprites have
 * finished loading or if one of them fails. The symbol layer coalesces to
 * this image so every POI is visible regardless of sprite-loading races.
 */
export const POI_FALLBACK_ICON_ID = 'poi-fallback';

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
  url: string,
  size: number,
): Promise<ImageData> {
  return new Promise((resolve, reject) => {
    const image = new Image();
    image.crossOrigin = 'anonymous';
    image.decoding = 'async';
    image.onload = () => {
      const canvas = document.createElement('canvas');
      canvas.width = size;
      canvas.height = size;
      const context = canvas.getContext('2d');
      if (!context) {
        reject(new Error(`2D canvas unavailable for ${url}`));
        return;
      }
      context.clearRect(0, 0, size, size);
      context.drawImage(image, 0, 0, size, size);
      resolve(context.getImageData(0, 0, size, size));
    };
    image.onerror = () => {
      reject(new Error(`Failed to load POI icon ${url}`));
    };
    image.src = url;
  });
}

async function addPoiImageIfMissing(
  map: MapboxMap,
  imageId: string,
  url: string,
  size: number,
): Promise<void> {
  if (map.hasImage(imageId)) {
    return;
  }

  let image: ImageData;
  try {
    image = await loadMapImage(url, size);
  } catch {
    // A single sprite failing to load (404, decode error, …) must never
    // abort the rest of the registration — the layer's fallback dot keeps
    // the POI visible.
    return;
  }

  if (map.hasImage(imageId)) {
    return;
  }

  try {
    map.addImage(imageId, image, { pixelRatio: 2 });
  } catch {
    // Concurrent registration already added this id ("already exists"), or
    // the map was torn down mid-flight. Either way, nothing to do.
  }
}

/**
 * Draw and register the always-available fallback marker. Synchronous and
 * idempotent: safe to call on every layer (re)creation and style reload.
 */
export function ensurePoiFallbackImage(map: MapboxMap): void {
  if (map.hasImage(POI_FALLBACK_ICON_ID)) {
    return;
  }

  const size = 96;
  const canvas = document.createElement('canvas');
  canvas.width = size;
  canvas.height = size;
  const context = canvas.getContext('2d');
  if (!context) {
    return;
  }

  const center = size / 2;
  context.clearRect(0, 0, size, size);
  context.beginPath();
  context.arc(center, center, size * 0.34, 0, Math.PI * 2);
  context.fillStyle = '#ffffff';
  context.fill();
  context.beginPath();
  context.arc(center, center, size * 0.26, 0, Math.PI * 2);
  context.fillStyle = '#ff5a1f';
  context.fill();

  try {
    map.addImage(POI_FALLBACK_ICON_ID, context.getImageData(0, 0, size, size), {
      pixelRatio: 2,
    });
  } catch {
    // Already registered by a concurrent call.
  }
}

export async function registerPoiIcons(map: MapboxMap): Promise<void> {
  ensurePoiFallbackImage(map);

  const size = 96;

  for (const category of POI_CATEGORIES) {
    const baseId = getPoiLayerIconId(category, false);
    await addPoiImageIfMissing(map, baseId, getPoiIconUrl(category, false), size);

    const favoriteId = getPoiLayerIconId(category, true);
    if (favoriteId !== baseId) {
      await addPoiImageIfMissing(map, favoriteId, getPoiIconUrl(category, true), size);
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
