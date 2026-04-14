import type { Map as MapboxMap } from 'mapbox-gl';
import type { PoiCategory } from '../types';
import { POI_COLORS } from '../types';

// ── SVG path data per category (24×24 viewBox) ───────────────────────

const ICON_PATHS: Record<PoiCategory, string> = {
  // Water droplet
  drinking_water:
    'M12 2C12 2 5 10.5 5 15a7 7 0 0014 0C19 10.5 12 2 12 2z',
  // Bread/croissant
  bakery:
    'M12 3C8.7 3 4 6 4 10c0 3 2 5 4 6l1 4h6l1-4c2-1 4-3 4-6 0-4-4.7-7-8-7z',
  // Shopping bag
  convenience:
    'M6 2v2H4a1 1 0 00-1 1v14a2 2 0 002 2h14a2 2 0 002-2V5a1 1 0 00-1-1h-2V2H6zm2 2h8v2H8V4zm-4 4h16v11H4V8z',
  // Cart
  supermarket:
    'M3 3h2l.4 2H21l-3 9H7L4 3zm4 13a2 2 0 100 4 2 2 0 000-4zm10 0a2 2 0 100 4 2 2 0 000-4z',
  // Bicycle
  bicycle:
    'M5 18a4 4 0 110-8 4 4 0 010 8zm14 0a4 4 0 110-8 4 4 0 010 8zM5 14l4-6h3l1 3h4l2-5',
  // Wrench
  bicycle_repair:
    'M14.7 6.3a1 1 0 000 1.4l1.6 1.6-5.6 5.6-1.6-1.6a1 1 0 00-1.4 0l-4 4a1 1 0 000 1.4l2.6 2.6a1 1 0 001.4 0l4-4a1 1 0 000-1.4L10.1 14l5.6-5.6 1.6 1.6a1 1 0 001.4 0l2-2a1 1 0 000-1.4L18.1 4a1 1 0 00-1.4 0l-2 2.3z',
  // WC symbol
  toilets:
    'M9 2a2 2 0 100 4 2 2 0 000-4zM7 8h4a1 1 0 011 1v5h-1v7H8v-7H7v-5a1 1 0 011-1zm8-6a2 2 0 100 4 2 2 0 000-4zm-1 6h4l-1 6h-1v7h-2v-7h-1l-1-6z',
  // Roof / shelter
  shelter:
    'M12 3L2 12h3v8h14v-8h3L12 3zm0 3.8L18 12v6H6v-6l6-5.2z',
  // Tent
  camp_site:
    'M12 4L2 20h20L12 4zm0 4l6 12H6l6-12z',
  // Cross
  pharmacy:
    'M10 3v7H3v4h7v7h4v-7h7v-4h-7V3h-4z',
  // H in box
  hospital:
    'M4 2a2 2 0 00-2 2v16a2 2 0 002 2h16a2 2 0 002-2V4a2 2 0 00-2-2H4zm4 5h2v4h4V7h2v10h-2v-4h-4v4H8V7z',
};

// ── Render SVG to ImageData via canvas ────────────────────────────────

function svgToImageData(
  path: string,
  color: string,
  size: number,
): Promise<ImageData> {
  return new Promise((resolve, reject) => {
    const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${size}" height="${size}" viewBox="0 0 24 24">
      <circle cx="12" cy="12" r="11" fill="${color}" fill-opacity="0.9" stroke="white" stroke-width="1.5"/>
      <path d="${path}" fill="white" transform="scale(0.55) translate(9.8, 9.8)"/>
    </svg>`;

    const img = new Image();
    img.onload = () => {
      const canvas = document.createElement('canvas');
      canvas.width = size;
      canvas.height = size;
      const ctx = canvas.getContext('2d')!;
      ctx.drawImage(img, 0, 0, size, size);
      resolve(ctx.getImageData(0, 0, size, size));
    };
    img.onerror = reject;
    img.src = `data:image/svg+xml;charset=utf-8,${encodeURIComponent(svg)}`;
  });
}

// ── Register all POI icons on the Mapbox map ──────────────────────────

let registered = false;

export async function registerPoiIcons(map: MapboxMap): Promise<void> {
  if (registered) return;

  const size = 48; // 48px for crisp retina rendering
  const entries = Object.entries(ICON_PATHS) as [PoiCategory, string][];

  const promises = entries.map(async ([category, path]) => {
    const imageId = `poi-${category}`;
    if (map.hasImage(imageId)) return;

    const color = POI_COLORS[category];
    const imageData = await svgToImageData(path, color, size);
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
