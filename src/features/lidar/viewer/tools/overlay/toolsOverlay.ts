// ============================================
// Outils du viewer LiDAR — surcouche 2D (lignes, sommets, étiquettes)
// ============================================
//
// Les mesures sont gardées en primitives 3D (repère de rendu) et projetées sur
// un canvas transparent au-dessus de la scène une fois par image rendue, comme
// les poignées de tracé. Les lignes restent dessinées à travers la végétation
// (comme dans Potree), mais les parties que cache le relief s'estompent : une
// ligne derrière une crête se lit comme derrière. Les étiquettes tiennent en
// une ligne ; la mesure sous le pointeur se déplie sur ses détails et passe
// devant. Les étiquettes ne se chevauchent jamais : chacune essaie quatre
// positions autour de son ancre, les petites sont abandonnées.

import { readRootAppScale } from '@/shared/lib/appScale';
import { RV_FONT_SANS } from '@/shared/lib/typography';
import type { ProjectedScreenPoint } from '../../route/terrainRaycaster';
import type { Vec3 } from '../types';

export interface OverlayPath {
  points: Vec3[];
  /** Une couleur, ou une par segment. */
  color: string | string[];
  width: number;
  dash?: number[];
  closed?: boolean;
}

export interface OverlayDot {
  at: Vec3;
  color: string;
  radius: number;
}

export type OverlayLabelTone = 'neutral' | 'ok' | 'warning' | 'danger';

export interface OverlayLabel {
  at: Vec3;
  headline: string;
  /** Affiché pendant que la mesure est survolée. */
  details?: string[];
  tone?: OverlayLabelTone;
  /** `small` : valeur sur un segment, centrée dessus, abandonnée quand c'est encombré. */
  size?: 'small' | 'card';
}

export interface OverlayLayer {
  /** Id de la mesure (survol, test d'impact) ; vide pour les couches transitoires. */
  id: string;
  paths: OverlayPath[];
  dots: OverlayDot[];
  labels: OverlayLabel[];
}

export type Projector = (v: Vec3) => ProjectedScreenPoint;
/** Le relief ne cache pas ce point du repère de rendu à la caméra. */
export type VisibilityTest = (v: Vec3) => boolean;

const TONE_COLORS: Record<OverlayLabelTone, string> = {
  neutral: '#ffffff',
  ok: '#3ecf8e',
  warning: '#f5a524',
  danger: '#ff5a4f',
};
const HIDDEN_ALPHA = 0.28;
const LABEL_GAP_PX = 10;
const HIT_SLOP_PX = 6;
/** Les étiquettes dont l'ancre est plus loin hors écran ne sont pas dessinées (pas d'empilement sur les bords), px CSS. */
const LABEL_OFFSCREEN_MARGIN_PX = 24;

interface Rect {
  x: number;
  y: number;
  w: number;
  h: number;
}

interface PlacedLabel {
  label: OverlayLabel;
  layerId: string;
  rect: Rect;
  expanded: boolean;
  hidden: boolean;
}

interface HitPath {
  id: string;
  points: ProjectedScreenPoint[];
  closed: boolean;
}

function overlaps(a: Rect, b: Rect): boolean {
  return a.x < b.x + b.w && b.x < a.x + a.w && a.y < b.y + b.h && b.y < a.y + a.h;
}

function segmentDistance(px: number, py: number, a: ProjectedScreenPoint, b: ProjectedScreenPoint): number {
  const vx = b.screenX - a.screenX;
  const vy = b.screenY - a.screenY;
  const len2 = vx * vx + vy * vy;
  const t = len2 > 0 ? Math.max(0, Math.min(1, ((px - a.screenX) * vx + (py - a.screenY) * vy) / len2)) : 0;
  return Math.hypot(px - (a.screenX + vx * t), py - (a.screenY + vy * t));
}

export class ToolsOverlay {
  private readonly canvas: HTMLCanvasElement;
  private readonly ctx: CanvasRenderingContext2D;
  private readonly sceneCanvas: HTMLCanvasElement;
  private hitRects: Array<{ id: string; rect: Rect }> = [];
  private hitPaths: HitPath[] = [];
  private cssWidth = 0;
  private cssHeight = 0;
  private empty = true;
  /** Mesure affichée dépliée et au premier plan. */
  hoveredId: string | null = null;

  constructor(container: HTMLElement, sceneCanvas: HTMLCanvasElement) {
    this.sceneCanvas = sceneCanvas;
    this.canvas = document.createElement('canvas');
    this.canvas.className = 'rv-lidar-tools-overlay';
    const ctx = this.canvas.getContext('2d');
    if (!ctx) throw new Error('Failed to create the tools overlay context');
    this.ctx = ctx;
    container.appendChild(this.canvas);
    this.resize();
  }

  resize(): void {
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    this.cssWidth = this.sceneCanvas.clientWidth || window.innerWidth;
    this.cssHeight = this.sceneCanvas.clientHeight || window.innerHeight;
    const w = Math.round(this.cssWidth * dpr);
    const h = Math.round(this.cssHeight * dpr);
    if (this.canvas.width !== w || this.canvas.height !== h) {
      this.canvas.width = w;
      this.canvas.height = h;
    }
    this.ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  }

  render(layers: readonly OverlayLayer[], project: Projector, isVisible: VisibilityTest): void {
    this.resize();
    const ctx = this.ctx;
    this.hitRects = [];
    this.hitPaths = [];
    if (layers.length === 0) {
      if (!this.empty) ctx.clearRect(0, 0, this.cssWidth, this.cssHeight);
      this.empty = true;
      return;
    }
    this.empty = false;
    ctx.clearRect(0, 0, this.cssWidth, this.cssHeight);
    const scale = readRootAppScale();
    // La mesure survolée est dessinée en dernier (au-dessus).
    const ordered = [...layers].sort((a, b) => Number(a.id !== '' && a.id === this.hoveredId) - Number(b.id !== '' && b.id === this.hoveredId));

    for (const layer of ordered) {
      const emphasis = layer.id !== '' && layer.id === this.hoveredId;
      for (const path of layer.paths) this.drawPath(layer.id, path, project, isVisible, emphasis);
    }
    for (const layer of ordered) {
      for (const dot of layer.dots) {
        const p = project(dot.at);
        if (!p.inFront) continue;
        ctx.globalAlpha = isVisible(dot.at) ? 1 : HIDDEN_ALPHA + 0.1;
        this.drawDot(p.screenX, p.screenY, dot);
        ctx.globalAlpha = 1;
        if (layer.id) {
          const r = dot.radius + HIT_SLOP_PX;
          this.hitRects.push({ id: layer.id, rect: { x: p.screenX - r, y: p.screenY - r, w: r * 2, h: r * 2 } });
        }
      }
    }
    for (const placed of this.placeLabels(ordered, project, isVisible, scale)) {
      ctx.globalAlpha = placed.hidden && !placed.expanded ? 0.7 : 1;
      this.drawLabel(placed, scale);
      ctx.globalAlpha = 1;
      if (placed.layerId) this.hitRects.push({ id: placed.layerId, rect: placed.rect });
    }
  }

  /** Mesure sous une position du canvas (étiquette, sommet ou ligne), s'il y en a une. */
  hitTest(x: number, y: number): string | null {
    for (let k = this.hitRects.length - 1; k >= 0; k--) {
      const { id, rect } = this.hitRects[k]!;
      if (x >= rect.x && x <= rect.x + rect.w && y >= rect.y && y <= rect.y + rect.h) return id;
    }
    for (const path of this.hitPaths) {
      const n = path.points.length;
      const segments = path.closed ? n : n - 1;
      for (let k = 0; k < segments; k++) {
        const a = path.points[k]!;
        const b = path.points[(k + 1) % n]!;
        if (a.inFront && b.inFront && segmentDistance(x, y, a, b) <= HIT_SLOP_PX) return path.id;
      }
    }
    return null;
  }

  destroy(): void {
    this.canvas.remove();
  }

  private isNearViewport(x: number, y: number): boolean {
    const m = LABEL_OFFSCREEN_MARGIN_PX;
    return x >= -m && y >= -m && x <= this.cssWidth + m && y <= this.cssHeight + m;
  }

  private drawPath(id: string, path: OverlayPath, project: Projector, isVisible: VisibilityTest, emphasis: boolean): void {
    const ctx = this.ctx;
    const pts = path.points.map(project);
    if (pts.length < 2) return;
    const seen = path.points.map((v, k) => (pts[k]!.inFront ? isVisible(v) : false));
    if (id) this.hitPaths.push({ id, points: pts, closed: path.closed === true });
    ctx.lineJoin = 'round';
    ctx.lineCap = 'round';
    const width = path.width + (emphasis ? 1.5 : 0);
    const segmentCount = path.closed ? pts.length : pts.length - 1;

    // Halo d'abord pour chaque segment, puis les couleurs par-dessus ; les
    // suites de segments de même couleur et même visibilité forment un seul trait.
    for (const pass of ['halo', 'color'] as const) {
      let runKey: string | null = null;
      for (let k = 0; k <= segmentCount; k++) {
        const end = k === segmentCount;
        const a = pts[k % pts.length]!;
        const b = pts[(k + 1) % pts.length]!;
        const drawable = !end && a.inFront && b.inFront;
        const visible = drawable && seen[k % pts.length]! && seen[(k + 1) % pts.length]!;
        const color = pass === 'halo'
          ? 'rgba(0, 0, 0, 0.5)'
          : Array.isArray(path.color) ? path.color[k] ?? path.color[path.color.length - 1]! : path.color;
        const key = drawable ? `${color}|${visible}` : null;
        if (key !== runKey) {
          if (runKey != null) ctx.stroke();
          runKey = key;
          if (key == null) continue;
          ctx.globalAlpha = visible ? 1 : HIDDEN_ALPHA;
          ctx.setLineDash(visible ? path.dash ?? [] : [4, 4]);
          ctx.lineWidth = pass === 'halo' ? width + 3 : width;
          ctx.strokeStyle = color;
          ctx.beginPath();
          ctx.moveTo(a.screenX, a.screenY);
        }
        if (key != null) ctx.lineTo(b.screenX, b.screenY);
      }
    }
    ctx.globalAlpha = 1;
    ctx.setLineDash([]);
  }

  private drawDot(x: number, y: number, dot: OverlayDot): void {
    const ctx = this.ctx;
    ctx.beginPath();
    ctx.arc(x, y, dot.radius, 0, Math.PI * 2);
    ctx.fillStyle = dot.color;
    ctx.fill();
    ctx.lineWidth = 1.5;
    ctx.strokeStyle = '#ffffff';
    ctx.stroke();
  }

  private labelFonts(label: OverlayLabel, scale: number) {
    const small = label.size === 'small';
    const headSize = (small ? 11 : 12) * scale;
    const bodySize = 11 * scale;
    return {
      small,
      headSize,
      bodySize,
      lineGap: 3 * scale,
      padX: (small ? 5 : 8) * scale,
      padY: (small ? 3 : 5) * scale,
      headFont: `600 ${headSize}px ${RV_FONT_SANS}`,
      bodyFont: `500 ${bodySize}px ${RV_FONT_SANS}`,
    };
  }

  private measureLabel(label: OverlayLabel, expanded: boolean, scale: number): { w: number; h: number } {
    const ctx = this.ctx;
    const f = this.labelFonts(label, scale);
    ctx.font = f.headFont;
    let width = ctx.measureText(label.headline).width;
    const details = expanded ? label.details ?? [] : [];
    ctx.font = f.bodyFont;
    for (const line of details) width = Math.max(width, ctx.measureText(line).width);
    const h = f.headSize + details.length * (f.bodySize + f.lineGap) + f.padY * 2;
    return { w: width + f.padX * 2, h };
  }

  /** Placement glouton : survolée d'abord, puis les cartes (plus récentes d'abord), puis les valeurs de segment. */
  private placeLabels(layers: readonly OverlayLayer[], project: Projector, isVisible: VisibilityTest, scale: number): PlacedLabel[] {
    const candidates: Array<{ label: OverlayLabel; layerId: string; x: number; y: number; rank: number; hidden: boolean }> = [];
    layers.forEach((layer, layerIndex) => {
      const hovered = layer.id !== '' && layer.id === this.hoveredId;
      for (const label of layer.labels) {
        const p = project(label.at);
        if (!p.inFront || !this.isNearViewport(p.screenX, p.screenY)) continue;
        const rank = hovered ? 0 : label.size === 'small' ? 2 : 1;
        candidates.push({ label, layerId: layer.id, x: p.screenX, y: p.screenY, rank: rank * 1e6 - layerIndex, hidden: !isVisible(label.at) });
      }
    });
    candidates.sort((a, b) => a.rank - b.rank);

    const placed: PlacedLabel[] = [];
    const taken: Rect[] = [];
    const gap = LABEL_GAP_PX * scale;
    for (const c of candidates) {
      const expanded = c.layerId !== '' && c.layerId === this.hoveredId && (c.label.details?.length ?? 0) > 0;
      const { w, h } = this.measureLabel(c.label, expanded, scale);
      const positions: Rect[] = c.label.size === 'small'
        ? [{ x: c.x - w / 2, y: c.y - h / 2, w, h }]
        : [
            { x: c.x - w / 2, y: c.y - h - gap, w, h },
            { x: c.x - w / 2, y: c.y + gap, w, h },
            { x: c.x + gap, y: c.y - h / 2, w, h },
            { x: c.x - w - gap, y: c.y - h / 2, w, h },
          ];
      const clamp = (r: Rect): Rect => ({
        ...r,
        x: Math.max(4, Math.min(this.cssWidth - r.w - 4, r.x)),
        y: Math.max(4, Math.min(this.cssHeight - r.h - 4, r.y)),
      });
      let rect: Rect | null = null;
      for (const pos of positions) {
        const r = clamp(pos);
        if (!taken.some((t) => overlaps(r, t))) {
          rect = r;
          break;
        }
      }
      // Une carte encombrée s'affiche quand même si c'est celle survolée.
      if (!rect && expanded) rect = clamp(positions[0]!);
      if (!rect) continue;
      taken.push(rect);
      placed.push({ label: c.label, layerId: c.layerId, rect, expanded, hidden: c.hidden });
    }
    // Dessiné à l'envers : la première placée (survolée) finit au-dessus.
    return placed.reverse();
  }

  private drawLabel(placed: PlacedLabel, scale: number): void {
    const ctx = this.ctx;
    const { label, rect, expanded } = placed;
    const f = this.labelFonts(label, scale);
    ctx.beginPath();
    ctx.roundRect(rect.x, rect.y, rect.w, rect.h, f.small ? 4 * scale : 6 * scale);
    ctx.fillStyle = expanded ? 'rgba(15, 15, 15, 0.9)' : 'rgba(15, 15, 15, 0.8)';
    ctx.fill();
    ctx.lineWidth = 1;
    ctx.strokeStyle = expanded ? 'rgba(255, 255, 255, 0.28)' : 'rgba(255, 255, 255, 0.14)';
    ctx.stroke();

    ctx.textBaseline = 'top';
    ctx.textAlign = 'left';
    let cursor = rect.y + f.padY;
    ctx.font = f.headFont;
    ctx.fillStyle = TONE_COLORS[label.tone ?? 'neutral'];
    ctx.fillText(label.headline, rect.x + f.padX, cursor);
    cursor += f.headSize + f.lineGap;
    if (!expanded) return;
    ctx.font = f.bodyFont;
    ctx.fillStyle = 'rgba(255, 255, 255, 0.72)';
    for (const line of label.details ?? []) {
      ctx.fillText(line, rect.x + f.padX, cursor);
      cursor += f.bodySize + f.lineGap;
    }
  }
}
