import type { Map as MapboxMap } from 'mapbox-gl';
import type { PoiCategory } from '../types';
import { POI_COLORS } from '../types';
import { PROVIDED_POI_SVG } from './providedPoiSvg';

// ── SVG path data per category (24×24 viewBox) ───────────────────────

const PROVIDED_ICON_URLS: Partial<Record<PoiCategory, string>> = {
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
};

const LEGACY_ICON_PATHS: Record<PoiCategory, string> = {
  drinking_water:
    'M12 2C12 2 5 10.5 5 15a7 7 0 0014 0C19 10.5 12 2 12 2z',
  bakery:
    'M12 3C8.7 3 4 6 4 10c0 3 2 5 4 6l1 4h6l1-4c2-1 4-3 4-6 0-4-4.7-7-8-7z',
  convenience:
    'M6 2v2H4a1 1 0 00-1 1v14a2 2 0 002 2h14a2 2 0 002-2V5a1 1 0 00-1-1h-2V2H6zm2 2h8v2H8V4zm-4 4h16v11H4V8z',
  supermarket:
    'M3 3h2l.4 2H21l-3 9H7L4 3zm4 13a2 2 0 100 4 2 2 0 000-4zm10 0a2 2 0 100 4 2 2 0 000-4z',
  bicycle:
    'M5 18a4 4 0 110-8 4 4 0 010 8zm14 0a4 4 0 110-8 4 4 0 010 8zM5 14l4-6h3l1 3h4l2-5',
  bicycle_repair:
    'M14.7 6.3a1 1 0 000 1.4l1.6 1.6-5.6 5.6-1.6-1.6a1 1 0 00-1.4 0l-4 4a1 1 0 000 1.4l2.6 2.6a1 1 0 001.4 0l4-4a1 1 0 000-1.4L10.1 14l5.6-5.6 1.6 1.6a1 1 0 001.4 0l2-2a1 1 0 000-1.4L18.1 4a1 1 0 00-1.4 0l-2 2.3z',
  toilets:
    'M9 2a2 2 0 100 4 2 2 0 000-4zM7 8h4a1 1 0 011 1v5h-1v7H8v-7H7v-5a1 1 0 011-1zm8-6a2 2 0 100 4 2 2 0 000-4zm-1 6h4l-1 6h-1v7h-2v-7h-1l-1-6z',
  shelter:
    'M12 3L2 12h3v8h14v-8h3L12 3zm0 3.8L18 12v6H6v-6l6-5.2z',
  camp_site:
    'M12 4L2 20h20L12 4zm0 4l6 12H6l6-12z',
  pharmacy:
    'M10 3v7H3v4h7v7h4v-7h7v-4h-7V3h-4z',
  hospital:
    'M4 2a2 2 0 00-2 2v16a2 2 0 002 2h16a2 2 0 002-2V4a2 2 0 00-2-2H4zm4 5h2v4h4V7h2v10h-2v-4h-4v4H8V7z',
  // Fuel pump
  fuel:
    'M3 3a1 1 0 011-1h9a1 1 0 011 1v18H3V3zm2 2v6h7V5H5zm12 4l3 3v8a2 2 0 11-4 0v-4h-1V9h2z',
  // Burger
  fast_food:
    'M2 9c0-3 4-5 10-5s10 2 10 5H2zm0 3h20v2H2v-2zm0 4h20v2a2 2 0 01-2 2H4a2 2 0 01-2-2v-2z',
  // Coffee cup
  cafe:
    'M4 4h13v8a5 5 0 01-5 5H9a5 5 0 01-5-5V4zm13 2h2a3 3 0 010 6h-2V6zM3 20h18v2H3v-2z',
  // Beer mug
  bar:
    'M5 4h11v15a2 2 0 01-2 2H7a2 2 0 01-2-2V4zm11 4h2a2 2 0 012 2v6a2 2 0 01-2 2h-2V8z',
  // Fork & knife
  restaurant:
    'M7 2v8a2 2 0 002 2v10h2V12a2 2 0 002-2V2h-1v6h-1V2h-1v6h-1V2H7zm10 0v9h2v11h2V2h-4z',
  // Bed
  hotel:
    'M2 7h2v6h7V9h6a4 4 0 014 4v6h-2v-3H4v3H2V7zm5 1a2 2 0 100 4 2 2 0 000-4z',
  // Mountain hut (triangle with door)
  alpine_hut:
    'M12 3L2 21h20L12 3zm0 5l6.5 11h-4v-5h-5v5H5.5L12 8z',
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

function svgPathToImageData(
  path: string,
  color: string,
  size: number,
): Promise<ImageData> {
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${size}" height="${size}" viewBox="0 0 24 24">
    <circle cx="12" cy="12" r="11" fill="${color}" fill-opacity="0.9" stroke="white" stroke-width="1.5"/>
    <path d="${path}" fill="white" transform="scale(0.55) translate(9.8, 9.8)"/>
  </svg>`;

  const blob = new Blob([svg], { type: 'image/svg+xml' });
  const url = URL.createObjectURL(blob);

  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => {
      URL.revokeObjectURL(url);
      const canvas = document.createElement('canvas');
      canvas.width = size;
      canvas.height = size;
      const ctx = canvas.getContext('2d')!;
      ctx.drawImage(img, 0, 0, size, size);
      resolve(ctx.getImageData(0, 0, size, size));
    };
    img.onerror = () => {
      URL.revokeObjectURL(url);
      reject(new Error(`Failed to render icon: ${color}`));
    };
    img.src = url;
  });
}

// ── Register all POI icons on the Mapbox map ──────────────────────────

let registered = false;

export async function registerPoiIcons(map: MapboxMap): Promise<void> {
  if (registered) return;

  const size = 48; // 48px for crisp retina rendering
  const entries = Object.entries(LEGACY_ICON_PATHS) as [PoiCategory, string][];

  const promises = entries.map(async ([category, path]) => {
    const imageId = `poi-${category}`;
    if (map.hasImage(imageId)) return;

    const providedUrl = PROVIDED_ICON_URLS[category];
    const imageData = providedUrl
      ? await imageUrlToImageData(providedUrl, size)
      : await svgPathToImageData(path, POI_COLORS[category], size);
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
