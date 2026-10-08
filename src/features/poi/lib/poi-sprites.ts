// Rastériseur des sprites de POI — transforme les SVG des POI en bitmaps prêts
// pour le GPU.
//
// La carte 3D dessine les POI via une seule couche `symbol` Mapbox
// (`poi-gpu-layer.ts`). Chaque visuel distinct (catégorie × favori × durée de
// pause) est composé UNE fois sur un canvas — icône, badge étoile du favori,
// pastille de pause et ombre portée intégrés — à haute densité, puis enregistré
// avec `map.addImage`. La géométrie reproduit l'ancien CSS des marqueurs DOM
// (`floating-markers.css`) en coordonnées relatives à l'ancrage, pour un rendu
// équivalent au pixel près, tandis que le coût par image ne dépend plus du
// nombre de POI.

import type { PoiCategory, PoiFeature } from '../types';
import { RV_FONT_SANS } from '@/shared/lib/typography';

import { buildPoiHitMask, type PoiHitMask } from './poi-hit-mask';
import { getPoiIconUrl, hasDedicatedFavoritePoiIcon } from './poi-icons';

const FAVORITE_BADGE_ICON_URL = '/icons/ui/star-01.svg';
const PAUSE_FONT_FAMILY = RV_FONT_SANS;

// Géométrie de base (icon-size = 1), d'après floating-markers.css.
const ROUND_SIZE_PX = 38;
const PIN_WIDTH_PX = 52;
const PIN_BODY_HEIGHT_PX = 44;
const PIN_IMAGE_HEIGHT_PX = 58;

export interface PoiSpriteSpec {
  category: PoiCategory;
  favorite: boolean;
  pauseMin: number;
}

export interface PoiSprite {
  id: string;
  image: ImageData;
  pixelRatio: number;
  /** Ce qui est vraiment dessiné, pour le test de clic au pixel près (`poi-hit-mask.ts`). */
  hitMask: PoiHitMask;
}

export function getPoiSpriteSpec(feature: PoiFeature): PoiSpriteSpec {
  const pause = feature.pauseDurationMin ?? 0;
  return {
    category: feature.category,
    favorite: feature.favorite === true,
    pauseMin: pause > 0 ? Math.round(pause) : 0,
  };
}

export function getPoiSpriteId(spec: PoiSpriteSpec): string {
  return `rv-poi:${spec.category}:${spec.favorite ? 'f' : 'r'}:${spec.pauseMin}`;
}

// Pastille de pause sous une icône ronde : son bas est 8 px sous la boîte de 38 px.
const PAUSE_PILL_ROUND_OVERHANG_PX = 8;

/** Libellé de la pastille de pause : « 15 min », puis « 6 h » / « 1 h 30 » à partir d'une heure. */
export function formatPoiPauseLabel(pauseMin: number): string {
  const minutes = Math.max(1, Math.round(pauseMin));
  if (minutes < 60) return `${minutes} min`;
  const hours = Math.floor(minutes / 60);
  const rest = minutes % 60;
  return rest > 0 ? `${hours} h ${String(rest).padStart(2, '0')}` : `${hours} h`;
}

/** Densité de rastérisation des sprites : net jusqu'à l'icon-size maximale en HiDPI. */
export function getPoiSpritePixelRatio(): number {
  const dpr = typeof window !== 'undefined' ? window.devicePixelRatio || 1 : 1;
  return Math.min(4, Math.max(2, dpr * 1.25));
}

// ── Chargement des ressources ──────────────────────────────────────────

const imageCache = new Map<string, Promise<HTMLImageElement | null>>();

export function loadPoiImage(url: string): Promise<HTMLImageElement | null> {
  let pending = imageCache.get(url);
  if (!pending) {
    pending = new Promise<HTMLImageElement | null>((resolve) => {
      const image = new Image();
      image.decoding = 'async';
      image.onload = () => resolve(image);
      image.onerror = () => resolve(null);
      image.src = url;
    });
    imageCache.set(url, pending);
  }
  return pending;
}

let pauseFontReady: Promise<void> | null = null;
function ensurePauseFont(): Promise<void> {
  if (!pauseFontReady) {
    pauseFontReady = (async () => {
      try {
        await document.fonts?.load(`700 10px ${PAUSE_FONT_FAMILY}`);
      } catch {
        // La police de repli convient.
      }
    })();
  }
  return pauseFontReady;
}

// ── Composition ────────────────────────────────────────────────────────

interface Extent { minX: number; minY: number; maxX: number; maxY: number }

function grow(extent: Extent, minX: number, minY: number, maxX: number, maxY: number): void {
  extent.minX = Math.min(extent.minX, minX);
  extent.minY = Math.min(extent.minY, minY);
  extent.maxX = Math.max(extent.maxX, maxX);
  extent.maxY = Math.max(extent.maxY, maxY);
}

/** object-fit: contain d'une image dans une boîte. */
function containRect(
  image: HTMLImageElement,
  x: number,
  y: number,
  w: number,
  h: number,
): [number, number, number, number] {
  const iw = image.naturalWidth || w;
  const ih = image.naturalHeight || h;
  const scale = Math.min(w / iw, h / ih);
  const dw = iw * scale;
  const dh = ih * scale;
  return [x + (w - dw) / 2, y + (h - dh) / 2, dw, dh];
}

function roundedRectPath(ctx: CanvasRenderingContext2D, x: number, y: number, w: number, h: number, r: number): void {
  const radius = Math.min(r, h / 2, w / 2);
  ctx.beginPath();
  ctx.moveTo(x + radius, y);
  ctx.arcTo(x + w, y, x + w, y + h, radius);
  ctx.arcTo(x + w, y + h, x, y + h, radius);
  ctx.arcTo(x, y + h, x, y, radius);
  ctx.arcTo(x, y, x + w, y, radius);
  ctx.closePath();
}

/**
 * Compose un sprite de POI. Les coordonnées sont relatives à l'ancrage
 * géographique (icône ronde : son centre, épingle : sa pointe). Le canvas est
 * rendu symétrique autour de cet ancrage pour que la couche symbol puisse
 * utiliser `icon-anchor: center` sans décalage.
 */
export async function rasterizePoiSprite(spec: PoiSpriteSpec, pixelRatio: number): Promise<PoiSprite | null> {
  const iconUrl = getPoiIconUrl(spec.category, spec.favorite);
  const needsStarBadge = spec.favorite && !hasDedicatedFavoritePoiIcon(spec.category);
  const [icon, star] = await Promise.all([
    loadPoiImage(iconUrl),
    needsStarBadge ? loadPoiImage(FAVORITE_BADGE_ICON_URL) : Promise.resolve(null),
  ]);
  if (!icon) return null;
  if (spec.pauseMin > 0) await ensurePauseFont();

  const pr = pixelRatio;
  const extent: Extent = { minX: 0, minY: 0, maxX: 0, maxY: 0 };

  // Boîte de l'icône.
  const iconBox: [number, number, number, number] = spec.favorite
    ? [-PIN_WIDTH_PX / 2, -PIN_BODY_HEIGHT_PX, PIN_WIDTH_PX, PIN_IMAGE_HEIGHT_PX]
    : containRect(icon, -ROUND_SIZE_PX / 2, -ROUND_SIZE_PX / 2, ROUND_SIZE_PX, ROUND_SIZE_PX);
  // Les icônes rondes portent `drop-shadow(0 2px 6px rgba(0,0,0,.35))`.
  const iconShadowPad = spec.favorite ? 0 : 14;
  grow(
    extent,
    iconBox[0] - iconShadowPad,
    iconBox[1] - iconShadowPad,
    iconBox[0] + iconBox[2] + iconShadowPad,
    iconBox[1] + iconBox[3] + iconShadowPad,
  );

  // Badge étoile du favori (disque de 24 px, top: 11px, right: 12px de la boîte de l'épingle).
  const badgeCx = PIN_WIDTH_PX / 2 - 12 - 12;
  const badgeCy = -PIN_BODY_HEIGHT_PX + 11 + 12;
  if (needsStarBadge) {
    grow(extent, badgeCx - 12 - 30, badgeCy - 12 - 30, badgeCx + 12 + 30, badgeCy + 12 + 34);
  }

  // Pastille de pause.
  const measureCtx = document.createElement('canvas').getContext('2d');
  const pauseLabel = formatPoiPauseLabel(spec.pauseMin);
  let pill: { x: number; y: number; w: number; h: number; symbolW: number } | null = null;
  if (spec.pauseMin > 0 && measureCtx) {
    measureCtx.font = `700 8px ${PAUSE_FONT_FAMILY}`;
    const symbolW = measureCtx.measureText('❚❚').width - 1;
    measureCtx.font = `700 10px ${PAUSE_FONT_FAMILY}`;
    const labelW = measureCtx.measureText(pauseLabel).width;
    const w = 6 + symbolW + 3 + labelW + 6 + 2;
    const h = 18;
    // Ronde : bottom: -8px sous une boîte de 38 px. Épingle : bottom: 2px au-dessus de la pointe.
    const bottom = spec.favorite ? -2 : ROUND_SIZE_PX / 2 + PAUSE_PILL_ROUND_OVERHANG_PX;
    pill = { x: -w / 2, y: bottom - h, w, h, symbolW };
    grow(extent, pill.x - 18, pill.y - 18, pill.x + w + 18, pill.y + h + 18);
  }

  const halfW = Math.ceil(Math.max(-extent.minX, extent.maxX));
  const halfH = Math.ceil(Math.max(-extent.minY, extent.maxY));
  const canvas = document.createElement('canvas');
  canvas.width = Math.ceil(halfW * 2 * pr);
  canvas.height = Math.ceil(halfH * 2 * pr);
  const ctx = canvas.getContext('2d');
  if (!ctx) return null;
  ctx.setTransform(pr, 0, 0, pr, halfW * pr, halfH * pr);
  ctx.imageSmoothingEnabled = true;
  ctx.imageSmoothingQuality = 'high';

  // Les ombres du canvas ignorent la transformation → on les met à l'échelle à la main.
  const setShadow = (color: string, offsetY: number, blur: number) => {
    ctx.shadowColor = color;
    ctx.shadowOffsetX = 0;
    ctx.shadowOffsetY = offsetY * pr;
    ctx.shadowBlur = blur * pr;
  };
  const clearShadow = () => {
    ctx.shadowColor = 'transparent';
    ctx.shadowBlur = 0;
    ctx.shadowOffsetY = 0;
  };

  if (!spec.favorite) setShadow('rgba(0, 0, 0, 0.35)', 2, 6);
  ctx.drawImage(icon, iconBox[0], iconBox[1], iconBox[2], iconBox[3]);
  clearShadow();

  if (needsStarBadge) {
    ctx.beginPath();
    ctx.arc(badgeCx, badgeCy, 12, 0, Math.PI * 2);
    setShadow('rgba(0, 0, 0, 0.28)', 4, 14);
    ctx.fillStyle = 'rgba(199, 0, 54, 0.92)';
    ctx.fill();
    clearShadow();
    ctx.lineWidth = 1;
    ctx.strokeStyle = 'rgba(255, 255, 255, 0.94)';
    ctx.beginPath();
    ctx.arc(badgeCx, badgeCy, 11.5, 0, Math.PI * 2);
    ctx.stroke();
    if (star) ctx.drawImage(star, badgeCx - 6.5, badgeCy - 6.5, 13, 13);
  }

  if (pill) {
    roundedRectPath(ctx, pill.x, pill.y, pill.w, pill.h, 999);
    setShadow('rgba(0, 0, 0, 0.45)', 2, 8);
    ctx.fillStyle = 'rgba(14, 14, 18, 0.92)';
    ctx.fill();
    clearShadow();
    roundedRectPath(ctx, pill.x + 0.5, pill.y + 0.5, pill.w - 1, pill.h - 1, 999);
    ctx.lineWidth = 1;
    ctx.strokeStyle = 'rgba(255, 255, 255, 0.85)';
    ctx.stroke();

    const midY = pill.y + pill.h / 2;
    ctx.textBaseline = 'middle';
    ctx.textAlign = 'left';
    ctx.fillStyle = '#ff9f43';
    ctx.font = `700 8px ${PAUSE_FONT_FAMILY}`;
    ctx.fillText('❚❚', pill.x + 7, midY);
    ctx.fillStyle = '#ffffff';
    ctx.font = `700 10px ${PAUSE_FONT_FAMILY}`;
    ctx.fillText(pauseLabel, pill.x + 7 + pill.symbolW + 3, midY);
  }

  const image = ctx.getImageData(0, 0, canvas.width, canvas.height);
  return {
    id: getPoiSpriteId(spec),
    image,
    pixelRatio: pr,
    hitMask: buildPoiHitMask(image.data, canvas.width, canvas.height, pr, halfW, halfH),
  };
}
