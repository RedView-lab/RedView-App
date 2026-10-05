import { RV_FONT_SANS } from '@/shared/lib/typography';
import { HEAD_DOT_SCALE } from './config';

/** Marqueur de tête de l'app (`routeDotMarker.ts`) : 14 px, bordure 3 px, anneau 1,5 px, ombre 0 2 8. */
const DOT_DIAMETER_PX = 14;
const DOT_BORDER_PX = 3;
const DOT_RING_PX = 1.5;
const MARGIN_PX = 14;
const ATTRIBUTION_FONT_PX = 12;
const ATTRIBUTION_MIN_FONT_PX = 10;
/** Logo Mapbox à sa taille du contrôle de carte (88 × 23). */
const LOGO_WIDTH_PX = 88;
const LOGO_HEIGHT_PX = 23;

type Canvas2D = OffscreenCanvasRenderingContext2D | CanvasRenderingContext2D;

/** Canevas 2D opaque ; `<canvas>` du document si OffscreenCanvas ne fournit pas de contexte 2D. */
function createCanvas2D(width: number, height: number): { canvas: OffscreenCanvas | HTMLCanvasElement; ctx: Canvas2D } {
  if (typeof OffscreenCanvas !== 'undefined') {
    const canvas = new OffscreenCanvas(width, height);
    const ctx = canvas.getContext('2d', { alpha: false });
    if (ctx) return { canvas, ctx };
  }
  const canvas = document.createElement('canvas');
  canvas.width = width;
  canvas.height = height;
  const ctx = canvas.getContext('2d', { alpha: false });
  if (!ctx) throw new Error('Canvas 2D indisponible.');
  return { canvas, ctx };
}

/**
 * Image finale de la vidéo : rendu de la carte (suréchantillonné) réduit à
 * la taille de la vidéo, tête de lecture dessinée comme le marqueur de l'app,
 * logo et attributions des sources (obligatoires sur une vidéo de carte
 * Mapbox, comme sur la carte).
 */
export class FrameCompositor {
  readonly canvas: OffscreenCanvas | HTMLCanvasElement;
  readonly width: number;
  readonly height: number;
  private readonly ctx: Canvas2D;
  private readonly color: string;
  private attribution: string;
  private logo: CanvasImageSource | null = null;

  constructor(width: number, height: number, options: { color: string; attribution: string }) {
    this.width = width;
    this.height = height;
    const { canvas, ctx } = createCanvas2D(width, height);
    this.canvas = canvas;
    this.ctx = ctx;
    this.color = options.color;
    this.attribution = options.attribution;
  }

  setAttribution(text: string): void {
    this.attribution = text;
  }

  /** Charge le logo (data: URI du contrôle Mapbox) ; sans lui, l'attribution seule. */
  async loadLogo(url: string | null): Promise<void> {
    if (!url) return;
    try {
      const image = new Image();
      image.decoding = 'async';
      image.src = url;
      await image.decode();
      this.logo = image;
    } catch {
      this.logo = null;
    }
  }

  /**
   * Compose une image. `source` est le canevas WebGL juste rendu (à lire
   * dans la même tâche) ; `head` la tête en px de la vidéo (`null` hors champ).
   */
  draw(source: HTMLCanvasElement, head: { x: number; y: number } | null): void {
    const ctx = this.ctx;
    ctx.imageSmoothingEnabled = true;
    ctx.imageSmoothingQuality = 'high';
    ctx.drawImage(source, 0, 0, this.width, this.height);
    if (head && head.x > -50 && head.y > -50 && head.x < this.width + 50 && head.y < this.height + 50) {
      this.drawHead(head.x, head.y);
    }
    this.drawCredits();
  }

  private drawHead(x: number, y: number): void {
    const ctx = this.ctx;
    const s = HEAD_DOT_SCALE;
    const radius = (DOT_DIAMETER_PX / 2) * s;
    ctx.save();
    ctx.shadowColor = 'rgba(0, 0, 0, 0.85)';
    ctx.shadowBlur = 8 * s;
    ctx.shadowOffsetY = 2 * s;
    ctx.beginPath();
    ctx.arc(x, y, radius + DOT_RING_PX * s, 0, Math.PI * 2);
    ctx.fillStyle = 'rgba(0, 0, 0, 0.75)';
    ctx.fill();
    ctx.restore();
    ctx.beginPath();
    ctx.arc(x, y, radius, 0, Math.PI * 2);
    ctx.fillStyle = this.color;
    ctx.fill();
    ctx.beginPath();
    ctx.arc(x, y, radius - DOT_BORDER_PX * s, 0, Math.PI * 2);
    ctx.fillStyle = '#ffffff';
    ctx.fill();
  }

  private drawCredits(): void {
    const ctx = this.ctx;
    const bottom = this.height - MARGIN_PX;
    let left = MARGIN_PX;
    if (this.logo) {
      ctx.save();
      ctx.globalAlpha = 0.9;
      ctx.drawImage(this.logo, MARGIN_PX, bottom - LOGO_HEIGHT_PX, LOGO_WIDTH_PX, LOGO_HEIGHT_PX);
      ctx.restore();
      left += LOGO_WIDTH_PX + MARGIN_PX;
    }
    const text = this.attribution;
    if (!text) return;
    const available = this.width - left - MARGIN_PX;
    let size = ATTRIBUTION_FONT_PX;
    ctx.font = `500 ${size}px ${RV_FONT_SANS}`;
    while (size > ATTRIBUTION_MIN_FONT_PX && ctx.measureText(text).width > available) {
      size -= 0.5;
      ctx.font = `500 ${size}px ${RV_FONT_SANS}`;
    }
    let label = text;
    if (ctx.measureText(label).width > available) {
      while (label.length > 1 && ctx.measureText(`${label}…`).width > available) label = label.slice(0, -1);
      label = `${label.trimEnd()}…`;
    }
    ctx.save();
    ctx.textAlign = 'right';
    ctx.textBaseline = 'alphabetic';
    ctx.shadowColor = 'rgba(0, 0, 0, 0.7)';
    ctx.shadowBlur = 3;
    ctx.fillStyle = 'rgba(255, 255, 255, 0.88)';
    ctx.fillText(label, this.width - MARGIN_PX, bottom - 4);
    ctx.restore();
  }
}
