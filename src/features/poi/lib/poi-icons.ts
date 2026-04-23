import type { Map as MapboxMap } from 'mapbox-gl';
import type { PoiCategory } from '../types';
import { PROVIDED_POI_SVG } from './providedPoiSvg';

const FALLBACK_POI_ICON_URL = '/svgv2/icone/x.svg';

const PROVIDED_ICON_URLS: Record<PoiCategory, string> = {
  drinking_water: PROVIDED_POI_SVG.water,
  bakery: PROVIDED_POI_SVG.bakery,
  convenience: PROVIDED_POI_SVG.shop,
  supermarket: PROVIDED_POI_SVG.shop,
  bicycle: PROVIDED_POI_SVG.bikeShop,
  bicycle_repair: PROVIDED_POI_SVG.bikeShop,
  toilets: PROVIDED_POI_SVG.toilet,
  fuel: PROVIDED_POI_SVG.fuel,
  fast_food: PROVIDED_POI_SVG.fastFood,
  cafe: PROVIDED_POI_SVG.cafe,
  bar: PROVIDED_POI_SVG.bar,
  restaurant: PROVIDED_POI_SVG.restaurant,
  hotel: PROVIDED_POI_SVG.hotelGlyph,
  alpine_hut: PROVIDED_POI_SVG.refugeGlyph,
  camp_site: FALLBACK_POI_ICON_URL,
  shelter: FALLBACK_POI_ICON_URL,
  pharmacy: FALLBACK_POI_ICON_URL,
  hospital: FALLBACK_POI_ICON_URL,
};

// ── Render SVG to ImageData via canvas ────────────────────────────────

function imageUrlToImageData(
  url: string,
  size: number,
): Promise<ImageData> {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.decoding = 'async';
    img.onload = () => {
      const canvas = document.createElement('canvas');
      canvas.width = size;
      canvas.height = size;
      const ctx = canvas.getContext('2d');
      if (!ctx) {
        reject(new Error('Failed to create icon canvas context'));
        return;
      }
      ctx.drawImage(img, 0, 0, size, size);
      resolve(ctx.getImageData(0, 0, size, size));
    };
    img.onerror = () => {
      reject(new Error(`Failed to render icon asset: ${url}`));
    };
    img.src = url;
  });
}

// ── Register all POI icons on the Mapbox map ──────────────────────────

let registered = false;

export async function registerPoiIcons(map: MapboxMap): Promise<void> {
  if (registered) return;

  const size = 48; // 48px for crisp retina rendering
  const entries = Object.entries(PROVIDED_ICON_URLS) as [PoiCategory, string][];

  const promises = entries.map(async ([category, url]) => {
    const imageId = `poi-${category}`;
    if (map.hasImage(imageId)) return;

    const imageData = await imageUrlToImageData(url, size);
    if (!map.hasImage(imageId)) {
      map.addImage(imageId, imageData, { pixelRatio: 2 });
    }
  });

  await Promise.all(promises);
  registered = true;
}

/** Reset registration flag (for hot reload / cleanup) */
export function resetIconRegistration(): void {
  registered = false;
}
