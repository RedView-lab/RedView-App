import type { AxisDomain } from '../series';
import type { ChartSlopeSegment } from '../slope';
import { SLOPE_COLOR_CLASSES, SLOPE_NEUTRAL_CLASS_INDEX } from '../slope';
import { ratioFor } from './math';
import type { CanvasBackdropLayer, CanvasSeriesLayer } from './types';

export function drawAnalysisChartCanvas(
  canvas: HTMLCanvasElement | null,
  input: {
    width: number;
    height: number;
    xDomain: AxisDomain;
    backdropYDomain: AxisDomain | null;
    backdropSeries: CanvasBackdropLayer[];
    seriesLayers: CanvasSeriesLayer[];
  },
) {
  if (!canvas) return;

  const rect = canvas.getBoundingClientRect();
  const width = rect.width > 0 ? rect.width : input.width;
  const height = rect.height > 0 ? rect.height : input.height;

  const ctx = prepareCanvas2d(canvas, width, height);
  if (!ctx) return;

  if (input.backdropYDomain) {
    for (const layer of input.backdropSeries) {
      if (layer.slopeSegments) continue;
      drawCanvasArea(
        ctx,
        layer.points,
        input.xDomain,
        input.backdropYDomain,
        layer.fillColor,
        width,
        height,
      );
    }
    for (const layer of input.backdropSeries) {
      if (layer.slopeSegments) {
        drawSlopeColoredProfile(
          ctx,
          canvas,
          layer.points,
          layer.slopeSegments,
          input.xDomain,
          input.backdropYDomain,
          1.6,
          width,
          height,
        );
        continue;
      }
      drawCanvasLine(
        ctx,
        layer.points,
        input.xDomain,
        input.backdropYDomain,
        layer.lineColor,
        1.15,
        width,
        height,
      );
    }
  }

  for (const layer of input.seriesLayers) {
    if (layer.slopeSegments) {
      drawSlopeColoredProfile(
        ctx,
        canvas,
        layer.points,
        layer.slopeSegments,
        input.xDomain,
        layer.yDomain,
        Math.max(2.25, layer.lineWidth),
        width,
        height,
      );
      continue;
    }
    if (layer.fillColor) {
      drawCanvasArea(
        ctx,
        layer.points,
        input.xDomain,
        layer.yDomain,
        layer.fillColor,
        width,
        height,
      );
    }
    drawCanvasLine(
      ctx,
      layer.points,
      input.xDomain,
      layer.yDomain,
      layer.color,
      layer.lineWidth,
      width,
      height,
    );
  }
}

function prepareCanvas2d(
  canvas: HTMLCanvasElement | null,
  width: number,
  height: number,
) {
  if (!canvas || width <= 0 || height <= 0) return null;

  const dpr = window.devicePixelRatio || 1;
  const targetBufferWidth = Math.max(1, Math.round(width * dpr));
  const targetBufferHeight = Math.max(1, Math.round(height * dpr));

  if (canvas.width !== targetBufferWidth || canvas.height !== targetBufferHeight) {
    canvas.width = targetBufferWidth;
    canvas.height = targetBufferHeight;
  }

  const ctx = canvas.getContext('2d');
  if (!ctx) return null;

  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.clearRect(0, 0, width, height);
  ctx.beginPath();
  ctx.rect(0, 0, width, height);
  ctx.clip();
  return ctx;
}

function rawYRatio(value: number, domain: AxisDomain): number {
  const span = domain.max - domain.min;
  if (span <= 0) return 0.5;
  return (value - domain.min) / span;
}

/**
 * Trace la polyligne des points dans le chemin courant. Renvoie les X extrêmes
 * et le Y (pixels) le plus haut, ou null si rien à tracer.
 */
function tracePolyline(
  ctx: CanvasRenderingContext2D,
  points: { x: number; y: number }[],
  xDomain: AxisDomain,
  yDomain: AxisDomain,
  width: number,
  height: number,
): { firstX: number; lastX: number; topY: number } | null {
  if (points.length < 2) return null;
  let firstX = 0;
  let lastX = 0;
  let topY = height;
  points.forEach((point, index) => {
    const x = ratioFor(point.x, xDomain) * width;
    const y = (1 - rawYRatio(point.y, yDomain)) * height;
    if (index === 0) {
      ctx.moveTo(x, y);
      firstX = x;
    } else {
      ctx.lineTo(x, y);
    }
    lastX = x;
    if (y < topY) topY = y;
  });
  return { firstX, lastX, topY };
}

function drawCanvasLine(
  ctx: CanvasRenderingContext2D,
  points: { x: number; y: number }[],
  xDomain: AxisDomain,
  yDomain: AxisDomain,
  color: string,
  lineWidth: number,
  width: number,
  height: number,
) {
  if (points.length < 2 || width <= 0 || height <= 0) return;

  ctx.save();
  ctx.beginPath();
  tracePolyline(ctx, points, xDomain, yDomain, width, height);
  ctx.strokeStyle = color;
  ctx.lineWidth = lineWidth;
  ctx.lineJoin = 'round';
  ctx.lineCap = 'round';
  ctx.stroke();
  ctx.restore();
}

function drawCanvasArea(
  ctx: CanvasRenderingContext2D,
  points: { x: number; y: number }[],
  xDomain: AxisDomain,
  yDomain: AxisDomain,
  fill: string,
  width: number,
  height: number,
) {
  if (points.length < 2 || width <= 0 || height <= 0) return;

  ctx.save();
  ctx.beginPath();
  const bounds = tracePolyline(ctx, points, xDomain, yDomain, width, height);
  if (bounds) {
    ctx.lineTo(bounds.lastX, height);
    ctx.lineTo(bounds.firstX, height);
    ctx.closePath();
    ctx.fillStyle = fill;
    ctx.fill();
  }
  ctx.restore();
}

// ── Colorisation « Pente » ──────────────────────────────────────────────────

/** Première classe de montée : seules les montées priment sur la classe dominante. */
const FIRST_CLIMB_CLASS_INDEX = SLOPE_COLOR_CLASSES.findIndex((entry) => entry.climb);
/** Part minimale d'une colonne pour qu'une montée plus raide l'emporte sur la classe dominante. */
const STEEP_PRIORITY_SHARE = 1 / 3;
/** Opacité du remplissage : pleine sous la courbe, estompée vers le bas. */
const SLOPE_FILL_TOP_ALPHA = 0.8;
const SLOPE_FILL_BOTTOM_ALPHA = 0.22;

interface SlopeBand {
  startPx: number;
  endPx: number;
  classIndex: number;
}

/**
 * Classe affichée par colonne de pixels, puis colonnes contiguës fusionnées.
 * Dans une colonne, la montée la plus raide qui en couvre au moins un tiers
 * l'emporte (un mur reste rouge en vue d'ensemble), sinon la classe dominante.
 * Zoomé, une colonne ne couvre qu'un tronçon : le rendu est exact.
 */
export function buildSlopeBands(
  segments: ReadonlyArray<ChartSlopeSegment>,
  xDomain: AxisDomain,
  width: number,
): SlopeBand[] {
  const span = xDomain.max - xDomain.min;
  if (!(span > 0) || width <= 0 || segments.length === 0) return [];

  const classCount = SLOPE_COLOR_CLASSES.length;
  const columns = Math.max(1, Math.ceil(width));
  const coverage = new Float32Array(columns * classCount);

  // Premier tronçon susceptible d'être visible (segments triés par X).
  let lo = 0;
  let hi = segments.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (segments[mid]!.endX < xDomain.min) lo = mid + 1;
    else hi = mid;
  }

  for (let index = lo; index < segments.length; index += 1) {
    const segment = segments[index]!;
    if (segment.startX > xDomain.max) break;
    const startPx = Math.max(0, ((segment.startX - xDomain.min) / span) * width);
    const endPx = Math.min(width, ((segment.endX - xDomain.min) / span) * width);
    if (!(endPx > startPx)) continue;
    const lastColumn = Math.min(columns - 1, Math.ceil(endPx) - 1);
    for (let column = Math.floor(startPx); column <= lastColumn; column += 1) {
      const overlap = Math.min(endPx, column + 1) - Math.max(startPx, column);
      if (overlap > 0) coverage[column * classCount + segment.classIndex]! += overlap;
    }
  }

  const bands: SlopeBand[] = [];
  for (let column = 0; column < columns; column += 1) {
    const base = column * classCount;
    let total = 0;
    let dominant = -1;
    let dominantCoverage = 0;
    for (let classIndex = 0; classIndex < classCount; classIndex += 1) {
      const value = coverage[base + classIndex]!;
      total += value;
      if (value > dominantCoverage) {
        dominantCoverage = value;
        dominant = classIndex;
      }
    }
    // Colonne sans tracé roulé (pause en mode temps) : neutre.
    let chosen = dominant >= 0 ? dominant : SLOPE_NEUTRAL_CLASS_INDEX;
    if (total > 0 && FIRST_CLIMB_CLASS_INDEX >= 0) {
      for (let classIndex = classCount - 1; classIndex >= FIRST_CLIMB_CLASS_INDEX; classIndex -= 1) {
        if (coverage[base + classIndex]! >= total * STEEP_PRIORITY_SHARE) {
          chosen = Math.max(chosen, classIndex);
          break;
        }
      }
    }
    const last = bands[bands.length - 1];
    if (last && last.classIndex === chosen) last.endPx = Math.min(width, column + 1);
    else bands.push({ startPx: column, endPx: Math.min(width, column + 1), classIndex: chosen });
  }
  return bands;
}

/** Dégradé horizontal à arrêts francs : une couleur pleine par bande. */
function createBandGradient(
  ctx: CanvasRenderingContext2D,
  bands: ReadonlyArray<SlopeBand>,
  width: number,
): CanvasGradient {
  const gradient = ctx.createLinearGradient(0, 0, width, 0);
  for (const band of bands) {
    const color = SLOPE_COLOR_CLASSES[band.classIndex]?.color ?? SLOPE_COLOR_CLASSES[SLOPE_NEUTRAL_CLASS_INDEX]!.color;
    gradient.addColorStop(Math.max(0, Math.min(1, band.startPx / width)), color);
    gradient.addColorStop(Math.max(0, Math.min(1, band.endPx / width)), color);
  }
  return gradient;
}

let slopeScratchCanvas: HTMLCanvasElement | null = null;

/** Canvas tampon réutilisé (même taille que le canvas du graphe) pour le fondu vertical. */
function getSlopeScratchContext(target: HTMLCanvasElement): CanvasRenderingContext2D | null {
  if (typeof document === 'undefined') return null;
  if (!slopeScratchCanvas) slopeScratchCanvas = document.createElement('canvas');
  if (slopeScratchCanvas.width !== target.width || slopeScratchCanvas.height !== target.height) {
    slopeScratchCanvas.width = target.width;
    slopeScratchCanvas.height = target.height;
  }
  return slopeScratchCanvas.getContext('2d');
}

/**
 * Profil d'altitude coloré par classe de pente : aire remplie (couleur de la
 * classe, fondu vers le bas) et ligne colorée soulignée d'un liseré sombre.
 * Un seul fill et un seul stroke via un dégradé à arrêts francs, quel que soit
 * le nombre de tronçons.
 */
function drawSlopeColoredProfile(
  ctx: CanvasRenderingContext2D,
  canvas: HTMLCanvasElement,
  points: { x: number; y: number }[],
  segments: ReadonlyArray<ChartSlopeSegment>,
  xDomain: AxisDomain,
  yDomain: AxisDomain,
  lineWidth: number,
  width: number,
  height: number,
) {
  if (points.length < 2 || width <= 0 || height <= 0) return;
  const bands = buildSlopeBands(segments, xDomain, width);
  if (bands.length === 0) return;

  // Aire : dessinée à part pour que le fondu (destination-in) n'efface pas
  // les couches déjà peintes sur le canvas du graphe.
  const scratch = getSlopeScratchContext(canvas);
  if (scratch) {
    const dpr = canvas.width / width;
    scratch.setTransform(1, 0, 0, 1, 0, 0);
    scratch.clearRect(0, 0, canvas.width, canvas.height);
    scratch.setTransform(dpr, 0, 0, dpr, 0, 0);
    scratch.beginPath();
    const bounds = tracePolyline(scratch, points, xDomain, yDomain, width, height);
    if (bounds) {
      scratch.lineTo(bounds.lastX, height);
      scratch.lineTo(bounds.firstX, height);
      scratch.closePath();
      scratch.globalCompositeOperation = 'source-over';
      scratch.fillStyle = createBandGradient(scratch, bands, width);
      scratch.fill();

      const fade = scratch.createLinearGradient(0, Math.max(0, bounds.topY), 0, height);
      fade.addColorStop(0, `rgba(0, 0, 0, ${SLOPE_FILL_TOP_ALPHA})`);
      fade.addColorStop(1, `rgba(0, 0, 0, ${SLOPE_FILL_BOTTOM_ALPHA})`);
      scratch.globalCompositeOperation = 'destination-in';
      scratch.fillStyle = fade;
      scratch.fillRect(0, 0, width, height);
      scratch.globalCompositeOperation = 'source-over';

      ctx.save();
      ctx.setTransform(1, 0, 0, 1, 0, 0);
      ctx.drawImage(scratch.canvas, 0, 0);
      ctx.restore();
    }
  }

  // Ligne : liseré sombre pour le contraste, puis couleur de classe.
  ctx.save();
  ctx.beginPath();
  tracePolyline(ctx, points, xDomain, yDomain, width, height);
  ctx.lineJoin = 'round';
  ctx.lineCap = 'round';
  ctx.strokeStyle = 'rgba(0, 0, 0, 0.45)';
  ctx.lineWidth = lineWidth + 2;
  ctx.stroke();
  ctx.strokeStyle = createBandGradient(ctx, bands, width);
  ctx.lineWidth = lineWidth;
  ctx.stroke();
  ctx.restore();
}
