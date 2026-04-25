import { unitForMetric, type AxisMode, type ChartMetricId } from '../series';

export function buildResponsiveXAxisLabels(
  positions: Array<{ value: number; ratio: number }>,
  xMode: AxisMode,
  plotWidth: number,
): Array<{ value: number; ratio: number; label: string }> {
  if (positions.length === 0) return [];

  const density = chooseXAxisLabelDensity(positions, plotWidth);
  const candidates = positions.map((position) => ({
    ...position,
    label: formatXTick(position.value, xMode, density),
  }));

  if (candidates.length <= 2 || plotWidth <= 0) return candidates;

  const estimatedLabelWidths = candidates.map((position) =>
    estimateXAxisLabelWidth(position.label, xMode),
  );

  const accepted: Array<{ value: number; ratio: number; label: string }> = [];
  let lastRight = -Infinity;

  for (let index = 0; index < candidates.length; index += 1) {
    const position = candidates[index];
    const isFirst = index === 0;
    const isLast = index === candidates.length - 1;
    const width = estimatedLabelWidths[index] ?? 0;
    const center = position.ratio * plotWidth;
    const left = isFirst ? center : center - width / 2;
    const right = isLast ? center : center + width / 2;
    const minGap = isFirst || isLast ? 6 : 10;

    if (!isFirst && left < lastRight + minGap && !isLast) continue;

    accepted.push(position);
    lastRight = right;
  }

  const first = candidates[0];
  const last = candidates[candidates.length - 1];
  if (accepted[0] !== first) accepted.unshift(first);
  if (accepted[accepted.length - 1] !== last) {
    const prev = accepted[accepted.length - 1];
    const lastWidth = estimatedLabelWidths[estimatedLabelWidths.length - 1] ?? 0;
    const lastLeft = last.ratio * plotWidth - lastWidth;
    const prevCenter = prev.ratio * plotWidth;
    if (lastLeft < prevCenter + 10 && accepted.length > 1) {
      accepted.splice(accepted.length - 1, 1, last);
    } else {
      accepted.push(last);
    }
  }

  return accepted;
}

function chooseXAxisLabelDensity(
  positions: Array<{ value: number; ratio: number }>,
  plotWidth: number,
): 'full' | 'compact' | 'tight' {
  if (positions.length <= 1 || plotWidth <= 0) return 'full';

  let minSpacingPx = Infinity;
  for (let index = 1; index < positions.length; index += 1) {
    const spacingPx = (positions[index].ratio - positions[index - 1].ratio) * plotWidth;
    if (spacingPx > 0) minSpacingPx = Math.min(minSpacingPx, spacingPx);
  }

  if (!Number.isFinite(minSpacingPx)) return 'full';
  if (minSpacingPx < 42) return 'tight';
  if (minSpacingPx < 68) return 'compact';
  return 'full';
}

function estimateXAxisLabelWidth(label: string, xMode: AxisMode): number {
  const charWidth = xMode === 'distance' ? 6.8 : 7.2;
  const basePadding = 14;
  return Math.max(26, Math.ceil(label.length * charWidth + basePadding));
}

export function formatAxisLabel(value: number, metric: ChartMetricId): string {
  if (!Number.isFinite(value)) return '--';
  let txt: string;
  if (Number.isInteger(value)) txt = String(value);
  else if (Math.abs(value) >= 100) txt = String(Math.round(value));
  else if (Math.abs(value) >= 10) txt = value.toFixed(1);
  else txt = Number(value.toFixed(2)).toString();
  const unit = unitForMetric(metric);
  return unit ? `${txt}${unit}` : txt;
}

export function formatXTick(
  value: number,
  xMode: AxisMode,
  density: 'full' | 'compact' | 'tight' = 'full',
): string {
  if (xMode === 'distance') return formatDistanceTick(value, density);
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

function formatDistanceTick(
  value: number,
  density: 'full' | 'compact' | 'tight',
): string {
  if (!Number.isFinite(value)) return '--';
  if (density === 'tight') return `${Math.round(value)}`;
  if (density === 'compact') return Number(value.toFixed(0)).toString();
  if (Number.isInteger(value)) return String(value);
  return value.toFixed(1);
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
  const unit = unitForMetric(metric);
  let txt: string;
  if (Math.abs(value) >= 100) txt = String(Math.round(value));
  else if (Math.abs(value) >= 10) txt = value.toFixed(1);
  else txt = value.toFixed(2).replace(/\.?0+$/u, '');
  return unit ? `${txt}${unit}` : txt;
}