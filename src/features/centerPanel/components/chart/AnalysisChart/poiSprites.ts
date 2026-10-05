// Chart POI sprites — the former DOM markers (`PoiBadge`, pause / waypoint
// checkpoints, multi-POI cluster) rasterised once per variant on a canvas,
// with their stacked CSS drop-shadows baked in. The chart then blits them with
// `drawImage`, so hundreds of POIs cost one canvas pass instead of hundreds of
// filtered DOM nodes re-rendered on every pan / zoom frame.

import { PROVIDED_POI_SVG } from '@/features/poi/lib/providedPoiSvg';
import { loadPoiImage } from '@/features/poi/lib/poi-sprites';
import type { PoiCategory } from '@/features/itineraryPanel/types';
import { RV_FONT_SANS } from '@/shared/lib/typography';
import {
  MULTI_POI_MARKER_HEIGHT_PX,
  MULTI_POI_MARKER_WIDTH_PX,
  POI_FAVORITE_MARKER_SIZE_PX,
  POI_MARKER_SIZE_PX,
  WAYPOINT_FAVORITE_MARKER_SIZE_PX,
  WAYPOINT_MARKER_SIZE_PX,
  type VisiblePoiAnnotation,
} from './types';

/** Logical padding around the button box, room for the widest (hover) shadow. */
const SPRITE_PAD_PX = 24;
export const POI_HOVER_SCALE = 1.15;

const STAR_URL = '/svgv2/icone/star-01.svg';
const PAUSE_URL = '/svgv2/icone/checkpoint-pause.svg';
const WAYPOINT_URL = '/svgv2/icone/checkpoint-waypoint.svg';
const TEARDROP_URL = '/svgv2/icone/marker-pin-02.svg';
const CLUSTER_URL = '/multiPOI.svg';
const FALLBACK_BADGE_COLOR = '#5a5a5a';

// Same asset tables as `PoiBadge` (itineraryPanel/sections/timeline/KindBadge).
const ROUND_BADGE_URLS: Partial<Record<PoiCategory, string>> = {
  fountains: '/svgv2/poi/dropdown-maps/water.svg',
  toilets: '/svgv2/poi/dropdown-maps/toilets.svg',
  supermarkets: '/svgv2/poi/dropdown-maps/supermarket.svg',
  gasStations: '/svgv2/poi/dropdown-maps/fuel.svg',
  bakeries: '/svgv2/poi/dropdown-maps/bakery.svg',
  fastFood: '/svgv2/poi/dropdown-maps/fast-food.svg',
  cafes: '/svgv2/poi/dropdown-maps/cafe.svg',
  bars: '/svgv2/poi/dropdown-maps/bar.svg',
  restaurants: '/svgv2/poi/dropdown-maps/restaurant.svg',
  bikeShops: '/svgv2/poi/dropdown-maps/bicycle.svg',
  hotels: '/svgv2/poi/dropdown-maps/hotel.svg',
  refuges: '/svgv2/poi/dropdown-maps/refuge.svg',
  passes: '/svgv2/poi/dropdown-maps/refuge.svg',
};

const FAVORITE_BADGE_URLS: Partial<Record<PoiCategory, string>> = {
  fountains: PROVIDED_POI_SVG.favoriteWater,
  toilets: PROVIDED_POI_SVG.favoriteToilet,
  supermarkets: PROVIDED_POI_SVG.favoriteSupermarket,
  gasStations: PROVIDED_POI_SVG.favoriteFuel,
  bakeries: PROVIDED_POI_SVG.favoriteBakery,
  fastFood: PROVIDED_POI_SVG.favoriteFastFood,
  cafes: PROVIDED_POI_SVG.favoriteCafe,
  bars: PROVIDED_POI_SVG.favoriteBar,
  restaurants: PROVIDED_POI_SVG.favoriteRestaurant,
  hotels: PROVIDED_POI_SVG.favoriteHotelPin,
  refuges: PROVIDED_POI_SVG.favoriteRefugePin,
  passes: PROVIDED_POI_SVG.favoriteRefugePin,
};

export type ChartPoiSpriteKind =
  | { type: 'poi'; category: PoiCategory; favorite: boolean }
  | { type: 'checkpoint'; checkpoint: 'pause' | 'waypoint'; favorite: boolean }
  | { type: 'fallback'; favorite: boolean }
  | { type: 'cluster' };

export interface ChartPoiSprite {
  canvas: HTMLCanvasElement;
  /** Logical size of the drawn canvas (button box + padding). */
  width: number;
  height: number;
  /** Anchor (the chart point) inside the canvas, logical px. */
  anchorX: number;
  anchorY: number;
  /** Clickable box relative to the anchor, logical px (former button box). */
  box: { left: number; top: number; width: number; height: number };
}

export function getChartPoiSpriteKind(annotation: VisiblePoiAnnotation): ChartPoiSpriteKind {
  const favorite = Boolean(annotation.favorite);
  if (annotation.kind === 'pause' || annotation.kind === 'waypoint') {
    return { type: 'checkpoint', checkpoint: annotation.kind, favorite };
  }
  if (annotation.poiCategory) return { type: 'poi', category: annotation.poiCategory, favorite };
  return { type: 'fallback', favorite };
}

/**
 * POI drawn on the chart: a checkpoint, a favourite, or a category with its own
 * icon. The rest would only be an empty grey disc — not shown on the chart.
 */
export function hasChartPoiIcon(annotation: Pick<VisiblePoiAnnotation, 'kind' | 'favorite' | 'poiCategory'>): boolean {
  if (annotation.kind === 'pause' || annotation.kind === 'waypoint' || annotation.favorite) return true;
  return annotation.poiCategory != null && ROUND_BADGE_URLS[annotation.poiCategory] != null;
}

export function getChartPoiSpriteKey(kind: ChartPoiSpriteKind, hover: boolean): string {
  const suffix = hover ? ':h' : '';
  switch (kind.type) {
    case 'poi': return `poi:${kind.category}:${kind.favorite ? 1 : 0}${suffix}`;
    case 'checkpoint': return `cp:${kind.checkpoint}:${kind.favorite ? 1 : 0}${suffix}`;
    case 'fallback': return `fb:${kind.favorite ? 1 : 0}${suffix}`;
    case 'cluster': return `cluster${suffix}`;
  }
}

// ── Canvas helpers ─────────────────────────────────────────────────────

interface Shadow { offsetY: number; blur: number; color: string }

function createLayer(width: number, height: number, pr: number): { canvas: HTMLCanvasElement; ctx: CanvasRenderingContext2D } | null {
  const canvas = document.createElement('canvas');
  canvas.width = Math.max(1, Math.ceil(width * pr));
  canvas.height = Math.max(1, Math.ceil(height * pr));
  const ctx = canvas.getContext('2d');
  if (!ctx) return null;
  ctx.setTransform(pr, 0, 0, pr, 0, 0);
  ctx.imageSmoothingEnabled = true;
  ctx.imageSmoothingQuality = 'high';
  return { canvas, ctx };
}

function applyShadow(ctx: CanvasRenderingContext2D, shadow: Shadow | null, pr: number): void {
  if (!shadow) {
    ctx.shadowColor = 'transparent';
    ctx.shadowBlur = 0;
    ctx.shadowOffsetX = 0;
    ctx.shadowOffsetY = 0;
    return;
  }
  // Shadow parameters ignore the transform: scale them to device pixels.
  ctx.shadowColor = shadow.color;
  ctx.shadowBlur = shadow.blur * pr;
  ctx.shadowOffsetX = 0;
  ctx.shadowOffsetY = shadow.offsetY * pr;
}

/** CSS `filter: drop-shadow()` on a whole layer = draw it once with a shadow. */
function withDropShadow(source: HTMLCanvasElement, width: number, height: number, pr: number, shadow: Shadow): HTMLCanvasElement {
  const layer = createLayer(width, height, pr);
  if (!layer) return source;
  layer.ctx.setTransform(1, 0, 0, 1, 0, 0);
  applyShadow(layer.ctx, shadow, pr);
  layer.ctx.drawImage(source, 0, 0);
  return layer.canvas;
}

function containRect(image: HTMLImageElement, x: number, y: number, w: number, h: number): [number, number, number, number] {
  const iw = image.naturalWidth || w;
  const ih = image.naturalHeight || h;
  const scale = Math.min(w / iw, h / ih);
  return [x + (w - iw * scale) / 2, y + (h - ih * scale) / 2, iw * scale, ih * scale];
}

/** `SvgV2Icon` tints its SVG with `currentColor` (mask) — same here. */
function drawTinted(ctx: CanvasRenderingContext2D, image: HTMLImageElement, x: number, y: number, w: number, h: number, color: string, pr: number): void {
  const tint = createLayer(w, h, pr);
  if (!tint) return;
  tint.ctx.drawImage(image, 0, 0, w, h);
  tint.ctx.globalCompositeOperation = 'source-in';
  tint.ctx.fillStyle = color;
  tint.ctx.fillRect(0, 0, w, h);
  ctx.drawImage(tint.canvas, x, y, w, h);
}

function drawStar(ctx: CanvasRenderingContext2D, star: HTMLImageElement | null, boxWidth: number, starSize: number, pr: number): void {
  if (!star) return;
  // position:absolute; top:-2; right:-2; drop-shadow(0 1px 2px rgba(0,0,0,.6))
  applyShadow(ctx, { offsetY: 1, blur: 2, color: 'rgba(0, 0, 0, 0.6)' }, pr);
  ctx.drawImage(star, boxWidth + 2 - starSize, -2, starSize, starSize);
  applyShadow(ctx, null, pr);
}

// ── Rasterisation ──────────────────────────────────────────────────────

const spriteCache = new Map<string, ChartPoiSprite>();
const pendingSprites = new Map<string, Promise<ChartPoiSprite | null>>();

function currentPixelRatio(hover: boolean): number {
  const dpr = typeof window !== 'undefined' ? window.devicePixelRatio || 1 : 1;
  return Math.min(4, Math.max(1, dpr) * (hover ? POI_HOVER_SCALE : 1));
}

/** Synchronous cache read — null until `loadChartPoiSprite` resolved. */
export function getChartPoiSprite(key: string): ChartPoiSprite | null {
  return spriteCache.get(key) ?? null;
}

export function loadChartPoiSprite(kind: ChartPoiSpriteKind, hover: boolean): Promise<ChartPoiSprite | null> {
  const key = getChartPoiSpriteKey(kind, hover);
  const cached = spriteCache.get(key);
  if (cached) return Promise.resolve(cached);
  let pending = pendingSprites.get(key);
  if (!pending) {
    pending = rasterize(kind, hover)
      .then((sprite) => {
        if (sprite) spriteCache.set(key, sprite);
        return sprite;
      })
      .catch(() => null)
      .finally(() => pendingSprites.delete(key));
    pendingSprites.set(key, pending);
  }
  return pending;
}

async function rasterize(kind: ChartPoiSpriteKind, hover: boolean): Promise<ChartPoiSprite | null> {
  const pr = currentPixelRatio(hover);

  // 1. Button content box (logical px) and the inner layer drawing.
  let boxW: number;
  let boxH: number;
  let innerShadow: Shadow | null = null;
  let drawContent: (ctx: CanvasRenderingContext2D) => void;
  let anchorRatioY = 1; // translate(-50%, -100%)
  let outerShadow: Shadow;

  if (kind.type === 'cluster') {
    const image = await loadPoiImage(CLUSTER_URL);
    boxW = MULTI_POI_MARKER_WIDTH_PX;
    boxH = MULTI_POI_MARKER_HEIGHT_PX;
    anchorRatioY = 0.796; // translate(-50%, -79.6%)
    outerShadow = { offsetY: 2, blur: 4, color: 'rgba(0, 0, 0, 0.5)' };
    drawContent = (ctx) => {
      if (image) ctx.drawImage(image, 0, 0, boxW, boxH);
    };
  } else {
    const favorite = kind.favorite;
    const size = kind.type === 'checkpoint' && kind.checkpoint === 'waypoint'
      ? (favorite ? WAYPOINT_FAVORITE_MARKER_SIZE_PX : WAYPOINT_MARKER_SIZE_PX)
      : (favorite ? POI_FAVORITE_MARKER_SIZE_PX : POI_MARKER_SIZE_PX);
    outerShadow = favorite
      ? { offsetY: 3, blur: 6, color: 'rgba(0, 0, 0, 0.65)' }
      : { offsetY: 2, blur: 4, color: 'rgba(0, 0, 0, 0.5)' };

    if (kind.type === 'checkpoint') {
      const [image, star] = await Promise.all([
        loadPoiImage(kind.checkpoint === 'pause' ? PAUSE_URL : WAYPOINT_URL),
        favorite ? loadPoiImage(STAR_URL) : Promise.resolve(null),
      ]);
      boxW = size;
      boxH = size;
      drawContent = (ctx) => {
        if (image) {
          applyShadow(ctx, { offsetY: 2, blur: 4, color: 'rgba(0, 0, 0, 0.4)' }, pr);
          ctx.drawImage(image, ...containRect(image, 0, 0, size, size));
          applyShadow(ctx, null, pr);
        }
        if (favorite) drawStar(ctx, star, size, Math.round(size * 0.4), pr);
      };
    } else if (kind.type === 'poi') {
      const favoriteUrl = favorite ? FAVORITE_BADGE_URLS[kind.category] : undefined;
      const providedUrl = favoriteUrl ?? ROUND_BADGE_URLS[kind.category];
      const showStar = favorite && !favoriteUrl;
      // `.rvi-kind { filter: drop-shadow(0 1px 1.5px rgba(0,0,0,.35)) }`
      innerShadow = { offsetY: 1, blur: 1.5, color: 'rgba(0, 0, 0, 0.35)' };

      if (providedUrl) {
        const [image, star] = await Promise.all([
          loadPoiImage(providedUrl),
          showStar ? loadPoiImage(STAR_URL) : Promise.resolve(null),
        ]);
        const height = favorite ? Math.round(size * (48 / 44)) : size;
        boxW = size;
        boxH = height;
        drawContent = (ctx) => {
          if (image) ctx.drawImage(image, ...containRect(image, 0, 0, size, height));
          if (showStar) drawStar(ctx, star, size, Math.round(size * 0.45), pr);
        };
      } else if (favorite) {
        const [pin, star] = await Promise.all([loadPoiImage(TEARDROP_URL), loadPoiImage(STAR_URL)]);
        boxW = size;
        boxH = size;
        drawContent = (ctx) => {
          if (pin) drawTinted(ctx, pin, 0, 0, size, size, FALLBACK_BADGE_COLOR, pr);
          drawStar(ctx, star, size, Math.round(size * 0.45), pr);
        };
      } else {
        boxW = size;
        boxH = size;
        drawContent = (ctx) => {
          const r = size / 2;
          ctx.beginPath();
          ctx.arc(r, r, r, 0, Math.PI * 2);
          applyShadow(ctx, { offsetY: 2, blur: 4, color: 'rgba(0, 0, 0, 0.25)' }, pr);
          ctx.fillStyle = FALLBACK_BADGE_COLOR;
          ctx.fill();
          applyShadow(ctx, null, pr);
          ctx.beginPath();
          ctx.arc(r, r, r - 0.75, 0, Math.PI * 2);
          ctx.lineWidth = 1.5;
          ctx.strokeStyle = 'rgba(255, 255, 255, 0.9)';
          ctx.stroke();
        };
      }
    } else {
      boxW = 28;
      boxH = 18;
      drawContent = (ctx) => {
        ctx.beginPath();
        ctx.roundRect(0, 0, boxW, boxH, 9);
        ctx.fillStyle = 'rgba(25, 25, 25, 0.88)';
        ctx.fill();
        ctx.fillStyle = '#ffffff';
        ctx.font = `700 10px ${RV_FONT_SANS}`;
        ctx.textAlign = 'center';
        ctx.textBaseline = 'middle';
        ctx.fillText('POI', boxW / 2, boxH / 2);
      };
    }
  }

  if (hover) {
    // `.rvchart__poi-marker:hover { filter: drop-shadow(0 5px 12px rgba(0,0,0,.8)) }`
    outerShadow = { offsetY: 5, blur: 12, color: 'rgba(0, 0, 0, 0.8)' };
  }

  // 2. Compose: content → inner drop-shadow → button drop-shadow.
  const width = boxW + SPRITE_PAD_PX * 2;
  const height = boxH + SPRITE_PAD_PX * 2;
  const content = createLayer(width, height, pr);
  if (!content) return null;
  content.ctx.translate(SPRITE_PAD_PX, SPRITE_PAD_PX);
  drawContent(content.ctx);

  let composed = content.canvas;
  if (innerShadow) composed = withDropShadow(composed, width, height, pr, innerShadow);
  composed = withDropShadow(composed, width, height, pr, outerShadow);

  const anchorX = SPRITE_PAD_PX + boxW / 2;
  const anchorY = SPRITE_PAD_PX + boxH * anchorRatioY;
  return {
    canvas: composed,
    width,
    height,
    anchorX,
    anchorY,
    box: { left: -boxW / 2, top: -boxH * anchorRatioY, width: boxW, height: boxH },
  };
}
