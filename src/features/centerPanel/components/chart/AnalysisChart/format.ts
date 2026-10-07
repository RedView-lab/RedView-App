import {
  formatPaceMinutes,
  isPaceMetric,
  unitForMetric,
  type AxisMode,
  type ChartMetricId,
} from '../series';

export type XAxisLabelDensity = 'full' | 'compact' | 'tight';

/** Pas « ronds » pour les axes en heures (minutes). */
const TIME_STEPS_MIN = [1, 2, 5, 10, 15, 20, 30, 60, 120, 180, 240, 360, 480, 720, 1440];
const X_LABEL_GAP_PX = 10;
const MAX_STEP_ATTEMPTS = 16;

/** Plus petit pas « rond » ≥ `rough` (km : 1-2-2,5-5 × 10ⁿ ; heures : minutes rondes). */
function niceXStep(rough: number, xMode: AxisMode): number {
  if (!(rough > 0) || !Number.isFinite(rough)) return 1;
  const floor = rough * (1 - 1e-9);
  if (xMode === 'distance') {
    const pow10 = 10 ** Math.floor(Math.log10(rough));
    for (const mult of [1, 2, 2.5, 5]) {
      if (mult * pow10 >= floor) return mult * pow10;
    }
    return 10 * pow10;
  }
  const roughMinutes = rough * 60;
  const minutes =
    TIME_STEPS_MIN.find((step) => step >= roughMinutes * (1 - 1e-9))
    ?? Math.ceil(roughMinutes / 1440) * 1440;
  return minutes / 60;
}

function ticksForStep(min: number, max: number, step: number): number[] {
  const first = Math.ceil((min - step * 1e-6) / step);
  const last = Math.floor((max + step * 1e-6) / step);
  const ticks: number[] = [];
  for (let index = first; index <= last && ticks.length < 200; index += 1) {
    ticks.push(Number((index * step).toFixed(8)));
  }
  return ticks;
}

function densityForSpacing(spacingPx: number): XAxisLabelDensity {
  if (spacingPx < 42) return 'tight';
  if (spacingPx < 68) return 'compact';
  return 'full';
}

/**
 * Graduations de l'axe X à pas constant. On part du pas « rond » visant
 * `targetSpacingPx` entre deux graduations, puis on l'agrandit (valeur ronde
 * suivante) tant que les libellés ne tiennent pas : toutes les graduations
 * restent libellées et régulièrement espacées, au lieu d'en masquer certaines
 * (ce qui donnait des graduations serrées aux extrémités et très espacées
 * ailleurs).
 */
export function buildXAxisTicks(
  min: number,
  max: number,
  plotWidth: number,
  xMode: AxisMode,
  targetSpacingPx: number,
): { ticks: number[]; density: XAxisLabelDensity } {
  if (!Number.isFinite(min) || !Number.isFinite(max) || max <= min) {
    return { ticks: [Number.isFinite(min) ? min : 0], density: 'full' };
  }
  const span = max - min;
  const width = plotWidth > 0 ? plotWidth : targetSpacingPx * 6;
  let step = niceXStep((span * targetSpacingPx) / width, xMode);
  let ticks = ticksForStep(min, max, step);
  let density = densityForSpacing((step / span) * width);

  for (let attempt = 0; attempt < MAX_STEP_ATTEMPTS; attempt += 1) {
    const spacingPx = (step / span) * width;
    density = densityForSpacing(spacingPx);
    const widest = ticks.reduce(
      (acc, value) => Math.max(acc, estimateXAxisLabelWidth(formatXTick(value, xMode, density), xMode)),
      0,
    );
    if (widest + X_LABEL_GAP_PX <= spacingPx || ticks.length <= 2) break;
    step = niceXStep(step * 1.000001, xMode);
    ticks = ticksForStep(min, max, step);
  }

  if (ticks.length === 0) ticks = [Number(min.toFixed(8))];
  return { ticks, density };
}

/**
 * Libellés de l'axe X : une graduation = un libellé (le pas garantit déjà
 * qu'ils tiennent). Seul un libellé collé à un bord, ancré sur ce bord (cf.
 * `xAnchorTransformFor`), peut chevaucher son voisin : il est alors omis, sa
 * ligne de graduation restant affichée.
 */
export function buildResponsiveXAxisLabels(
  positions: Array<{ value: number; ratio: number }>,
  xMode: AxisMode,
  plotWidth: number,
  density: XAxisLabelDensity,
): Array<{ value: number; ratio: number; label: string }> {
  const labels = positions.map((position) => ({
    ...position,
    label: formatXTick(position.value, xMode, density),
  }));
  if (labels.length < 2 || plotWidth <= 0) return labels;

  const extent = (entry: { ratio: number; label: string }) => {
    const width = estimateXAxisLabelWidth(entry.label, xMode);
    const center = entry.ratio * plotWidth;
    if (entry.ratio <= 0.02) return { left: center, right: center + width };
    if (entry.ratio >= 0.98) return { left: center - width, right: center };
    return { left: center - width / 2, right: center + width / 2 };
  };

  const result = labels.slice();
  if (extent(result[0]).right + X_LABEL_GAP_PX > extent(result[1]).left) {
    result.shift();
  }
  if (result.length >= 2) {
    const last = result[result.length - 1];
    const previous = result[result.length - 2];
    if (extent(previous).right + X_LABEL_GAP_PX > extent(last).left) {
      result.pop();
    }
  }
  return result;
}

function estimateXAxisLabelWidth(label: string, xMode: AxisMode): number {
  const charWidth = xMode === 'distance' ? 6.8 : 7.2;
  const basePadding = 14;
  return Math.max(26, Math.ceil(label.length * charWidth + basePadding));
}

export function formatAxisLabel(value: number, metric: ChartMetricId): string {
  if (!Number.isFinite(value)) return '--';
  if (isPaceMetric(metric)) return formatPaceMinutes(value, false);
  let txt: string;
  if (Number.isInteger(value)) txt = String(value);
  else if (Math.abs(value) >= 100) txt = String(Math.round(value));
  else if (Math.abs(value) >= 10) txt = value.toFixed(1);
  else txt = Number(value.toFixed(2)).toString();
  const unit = unitForMetric(metric);
  return unit ? `${txt}${unit}` : txt;
}

function formatXTick(
  value: number,
  xMode: AxisMode,
  density: 'full' | 'compact' | 'tight' = 'full',
): string {
  if (xMode === 'distance') return formatDistanceTick(value);
  if (xMode === 'heure') return formatClockHours(value, density);
  return formatHours(value, density);
}

export function formatXAxisValue(value: number, xMode: AxisMode): string {
  if (xMode === 'distance') return `${value.toFixed(1)} km`;
  if (xMode === 'heure') return formatClockHours(value);
  return formatHours(value);
}

export function xAnchorTransformFor(ratio: number): string {
  if (ratio <= 0.02) return 'translateX(0%)';
  if (ratio >= 0.98) return 'translateX(-100%)';
  return 'translateX(-50%)';
}

function formatDistanceTick(value: number): string {
  if (!Number.isFinite(value)) return '--';
  // Les graduations tombent sur des pas ronds (… 0,25 / 0,5 / 1 / 2,5 …) :
  // on affiche leur valeur exacte (≤ 2 décimales), jamais un arrondi qui
  // ferait se répéter ou mentir deux libellés voisins. La densité ne
  // raccourcit que les libellés horaires.
  return Number(value.toFixed(2)).toString();
}

function formatHours(
  hours: number,
  density: 'full' | 'compact' | 'tight' = 'full',
): string {
  if (!Number.isFinite(hours)) return '--';
  const totalMin = Math.round(hours * 60);
  const h = Math.floor(totalMin / 60);
  const m = Math.abs(totalMin % 60);
  if (density === 'tight') return `${h}h`;
  if (density === 'compact' && m === 0) return `${h}h`;
  return `${h}h${m.toString().padStart(2, '0')}`;
}

function formatClockHours(
  hours: number,
  density: 'full' | 'compact' | 'tight' = 'full',
): string {
  if (!Number.isFinite(hours)) return '--:--';
  const totalMinutes = Math.round(hours * 60);
  const dayOffset = Math.floor(totalMinutes / 1440);
  const minutesInDay = ((totalMinutes % 1440) + 1440) % 1440;
  const hh = String(Math.floor(minutesInDay / 60)).padStart(2, '0');
  const mm = String(minutesInDay % 60).padStart(2, '0');
  const prefix = dayOffset > 0 ? `J+${dayOffset} ` : '';
  if (density === 'tight') return `${prefix}${hh}`;
  if (density === 'compact') return `${prefix}${hh}h`;
  return `${prefix}${hh}:${mm}`;
}

export function formatCellValue(value: number, metric: ChartMetricId): string {
  if (!Number.isFinite(value)) return '--';
  if (isPaceMetric(metric)) return formatPaceMinutes(value);
  const unit = unitForMetric(metric);
  let txt: string;
  if (Math.abs(value) >= 100) txt = String(Math.round(value));
  else if (Math.abs(value) >= 10) txt = value.toFixed(1);
  else txt = value.toFixed(2).replace(/\.?0+$/u, '');
  return unit ? `${txt}${unit}` : txt;
}
