import type { AxisDomain } from '../series';
import type { ChartSlopeSegment } from '../slope';
import { SLOPE_COLOR_CLASSES, SLOPE_NEUTRAL_CLASS_INDEX } from '../slope';
import { ratioFor } from './math';
import { readDocumentAppLocale } from '@/shared/i18n';
import type { AppTheme } from '@/shared/lib/appTheme';
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
    theme: AppTheme;
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
          input.theme,
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
        input.theme,
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

/** Opacité du remplissage : pleine sous la courbe, estompée vers le bas. */
const SLOPE_FILL_TOP_ALPHA = 0.92;
const SLOPE_FILL_BOTTOM_ALPHA = 0.45;
/** Descente et plat restent en retrait : seules les montées « pèsent ». */
const SLOPE_CALM_FILL_ALPHA = 0.32;
/** Pastille de pente moyenne : tronçon minimal (px, m de D+), écart et géométrie (px). */
const GRADE_LABEL_MIN_BLOCK_PX = 16;
const GRADE_LABEL_MIN_GAIN_M = 25;
/** Pente moyenne minimale (%) d'une montée pour porter une pastille (pas de faux plats). */
const GRADE_LABEL_MIN_PCT = 3;
/** Liseré sous la ligne et contour des pastilles : plus léger sur le fond blanc du thème clair. */
const SLOPE_LINE_OUTLINE: Record<AppTheme, string> = { dark: 'rgba(0, 0, 0, 0.45)', light: 'rgba(0, 0, 0, 0.22)' };
const GRADE_LABEL_OUTLINE: Record<AppTheme, string> = { dark: 'rgba(0, 0, 0, 0.4)', light: 'rgba(0, 0, 0, 0.18)' };
const GRADE_LABEL_GAP_PX = 6;
const GRADE_LABEL_HEIGHT_PX = 17;
const GRADE_LABEL_BOTTOM_PX = 6;
const GRADE_LABEL_CLEARANCE_PX = 4;
/** Espace fine insécable avant « % ». */
const PERCENT_SEPARATOR = String.fromCharCode(0x202f);

interface SlopeBand {
  startPx: number;
  endPx: number;
  classIndex: number;
}

/**
 * Classe dominante par colonne de pixels, puis colonnes contiguës fusionnées.
 * Les tronçons arrivent déjà moyennés au niveau de détail du zoom (≥ ~6 px) :
 * la colonne ne sert qu'à absorber les rares tronçons sous le pixel.
 */
function buildSlopeBands(
  segments: ReadonlyArray<ChartSlopeSegment>,
  xDomain: AxisDomain,
  width: number,
): SlopeBand[] {
  const span = xDomain.max - xDomain.min;
  if (!(span > 0) || width <= 0 || segments.length === 0) return [];

  const classCount = SLOPE_COLOR_CLASSES.length;
  const columns = Math.max(1, Math.ceil(width));
  const coverage = new Float32Array(columns * classCount);

  for (let index = firstVisibleSegment(segments, xDomain); index < segments.length; index += 1) {
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
    // Colonne sans tracé roulé (pause en mode temps) : neutre.
    let chosen = SLOPE_NEUTRAL_CLASS_INDEX;
    let chosenCoverage = 0;
    for (let classIndex = 0; classIndex < classCount; classIndex += 1) {
      const value = coverage[base + classIndex]!;
      if (value > chosenCoverage) {
        chosenCoverage = value;
        chosen = classIndex;
      }
    }
    const last = bands[bands.length - 1];
    if (last && last.classIndex === chosen) last.endPx = Math.min(width, column + 1);
    else bands.push({ startPx: column, endPx: Math.min(width, column + 1), classIndex: chosen });
  }
  return bands;
}

/** Premier tronçon susceptible d'être visible (segments triés par X). */
function firstVisibleSegment(segments: ReadonlyArray<ChartSlopeSegment>, xDomain: AxisDomain): number {
  let lo = 0;
  let hi = segments.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (segments[mid]!.endX < xDomain.min) lo = mid + 1;
    else hi = mid;
  }
  return lo;
}

function slopeClassColor(classIndex: number): string {
  return SLOPE_COLOR_CLASSES[classIndex]?.color ?? SLOPE_COLOR_CLASSES[SLOPE_NEUTRAL_CLASS_INDEX]!.color;
}

function hexToRgb(hex: string): [number, number, number] {
  const value = Number.parseInt(hex.slice(1, 7), 16);
  return [(value >> 16) & 255, (value >> 8) & 255, value & 255];
}

function hexWithAlpha(hex: string, alpha: number): string {
  const [r, g, b] = hexToRgb(hex);
  return `rgba(${r}, ${g}, ${b}, ${alpha})`;
}

/** Texte sombre sur les teintes claires (beige, orange), blanc sinon. */
function labelTextColor(hex: string): string {
  const [r, g, b] = hexToRgb(hex).map((channel) => {
    const c = channel / 255;
    return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
  }) as [number, number, number];
  return 0.2126 * r + 0.7152 * g + 0.0722 * b > 0.3 ? '#15171C' : '#FFFFFF';
}

/**
 * Dégradé horizontal à arrêts francs : une couleur pleine par bande.
 * `calmAlpha` estompe descente et plat (remplissage).
 */
function createBandGradient(
  ctx: CanvasRenderingContext2D,
  bands: ReadonlyArray<SlopeBand>,
  width: number,
  calmAlpha = 1,
): CanvasGradient {
  const gradient = ctx.createLinearGradient(0, 0, width, 0);
  for (const band of bands) {
    const color = slopeClassColor(band.classIndex);
    const climb = SLOPE_COLOR_CLASSES[band.classIndex]?.climb ?? false;
    const stopColor = climb || calmAlpha >= 1 ? color : hexWithAlpha(color, calmAlpha);
    gradient.addColorStop(Math.max(0, Math.min(1, band.startPx / width)), stopColor);
    gradient.addColorStop(Math.max(0, Math.min(1, band.endPx / width)), stopColor);
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
 * Profil d'altitude coloré par pente moyenne de tronçon : aire remplie
 * (montées pleines, descente/plat estompés, fondu vers le bas), ligne colorée
 * soulignée d'un liseré sombre, puis pastille « x,x % » au pied des montées
 * assez larges. Un seul fill et un seul stroke via un dégradé à arrêts francs.
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
  theme: AppTheme,
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
      scratch.fillStyle = createBandGradient(scratch, bands, width, SLOPE_CALM_FILL_ALPHA);
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
  ctx.strokeStyle = SLOPE_LINE_OUTLINE[theme];
  ctx.lineWidth = lineWidth + 2;
  ctx.stroke();
  ctx.strokeStyle = createBandGradient(ctx, bands, width);
  ctx.lineWidth = lineWidth;
  ctx.stroke();
  ctx.restore();

  drawSlopeGradeLabels(ctx, canvas, points, segments, xDomain, yDomain, width, height, theme);
}

/** Point le plus bas de la courbe (Y pixel max) sur [startX, endX]. */
function lowestCurvePx(
  points: { x: number; y: number }[],
  startX: number,
  endX: number,
  yDomain: AxisDomain,
  height: number,
): number {
  let lo = 0;
  let hi = points.length - 1;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (points[mid]!.x < startX) lo = mid + 1;
    else hi = mid;
  }
  let minY = Infinity;
  // Le point précédent borne la courbe à l'entrée du tronçon.
  for (let index = Math.max(0, lo - 1); index < points.length; index += 1) {
    const point = points[index]!;
    if (point.y < minY) minY = point.y;
    if (point.x > endX) break;
  }
  return Number.isFinite(minY) ? (1 - rawYRatio(minY, yDomain)) * height : height;
}

/**
 * Pastilles de pente moyenne (« 7,4 % ») au pied des montées, comme les
 * paliers d'un profil de col. Les montées au plus fort dénivelé sont posées
 * d'abord, sans chevauchement ; une pastille n'est posée que si la courbe
 * laisse la place au-dessus d'elle.
 */
function drawSlopeGradeLabels(
  ctx: CanvasRenderingContext2D,
  canvas: HTMLCanvasElement,
  points: { x: number; y: number }[],
  segments: ReadonlyArray<ChartSlopeSegment>,
  xDomain: AxisDomain,
  yDomain: AxisDomain,
  width: number,
  height: number,
  theme: AppTheme,
) {
  const span = xDomain.max - xDomain.min;
  if (!(span > 0) || height < GRADE_LABEL_HEIGHT_PX * 3) return;

  const candidates: Array<{ segment: ChartSlopeSegment; startPx: number; endPx: number; gainM: number }> = [];
  for (let index = firstVisibleSegment(segments, xDomain); index < segments.length; index += 1) {
    const segment = segments[index]!;
    if (segment.startX > xDomain.max) break;
    if (!SLOPE_COLOR_CLASSES[segment.classIndex]?.climb || segment.avgPct < GRADE_LABEL_MIN_PCT) continue;
    const startPx = Math.max(0, ((segment.startX - xDomain.min) / span) * width);
    const endPx = Math.min(width, ((segment.endX - xDomain.min) / span) * width);
    const gainM = (segment.avgPct / 100) * segment.lengthM;
    if (endPx - startPx < GRADE_LABEL_MIN_BLOCK_PX || gainM < GRADE_LABEL_MIN_GAIN_M) continue;
    candidates.push({ segment, startPx, endPx, gainM });
  }
  if (candidates.length === 0) return;
  candidates.sort((a, b) => b.gainM - a.gainM);

  const locale = readDocumentAppLocale();
  const format = new Intl.NumberFormat(locale === 'fr' ? 'fr-FR' : 'en-US', {
    minimumFractionDigits: 1,
    maximumFractionDigits: 1,
  });
  const fontFamily = getComputedStyle(canvas).fontFamily || 'system-ui, sans-serif';
  const pillTop = height - GRADE_LABEL_BOTTOM_PX - GRADE_LABEL_HEIGHT_PX;
  const placed: Array<[number, number]> = [];

  ctx.save();
  ctx.font = `700 11px ${fontFamily}`;
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  for (const { segment, startPx, endPx } of candidates) {
    const text = `${format.format(segment.avgPct)}${PERCENT_SEPARATOR}%`;
    const pillWidth = Math.ceil(ctx.measureText(text).width) + 12;
    const left = Math.max(2, Math.min(width - 2 - pillWidth, (startPx + endPx) / 2 - pillWidth / 2));
    const right = left + pillWidth;
    if (placed.some(([a, b]) => left < b + GRADE_LABEL_GAP_PX && right > a - GRADE_LABEL_GAP_PX)) continue;
    const roomStartX = xDomain.min + (Math.min(left, startPx) / width) * span;
    const roomEndX = xDomain.min + (Math.max(right, endPx) / width) * span;
    if (lowestCurvePx(points, roomStartX, roomEndX, yDomain, height) > pillTop - GRADE_LABEL_CLEARANCE_PX) continue;
    placed.push([left, right]);

    const color = slopeClassColor(segment.classIndex);
    ctx.beginPath();
    ctx.roundRect(left, pillTop, pillWidth, GRADE_LABEL_HEIGHT_PX, GRADE_LABEL_HEIGHT_PX / 2);
    ctx.fillStyle = color;
    ctx.fill();
    ctx.lineWidth = 1;
    ctx.strokeStyle = GRADE_LABEL_OUTLINE[theme];
    ctx.stroke();
    ctx.fillStyle = labelTextColor(color);
    ctx.fillText(text, left + pillWidth / 2, pillTop + GRADE_LABEL_HEIGHT_PX / 2 + 0.5);
  }
  ctx.restore();
}
