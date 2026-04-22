import type { PredictionPoint, PredictionResult } from '@/features/fitPredictor';

/**
 * Identifier of an axis option exposed by the analysis dropdowns. Keep in
 * sync with the labels rendered in {@link CenterPanelAnalysis}.
 */
export type AxisMetricId =
  | 'Vitesse'
  | 'Vitesse moyenne'
  | 'Puissance'
  | 'Puissance moyenne'
  | 'Altitude'
  | 'Inclinaison (°)'
  | 'Inclinaison (%)'
  | 'Surface'
  | 'Température'
  | 'Température ressentie (°)'
  | 'Pluie (mm)'
  | 'Vent (km/h)'
  | 'Couverture nuageuse (%)'
  | 'Humidité (%)'
  | 'Ensoleillement (min)';

export type AxisMode = 'distance' | 'temps';

/** Single point of a chart series, expressed in axis units (km / s / metric). */
export interface ChartPoint {
  x: number;
  y: number;
}

/** Plot-ready descriptor: one curve for one itinerary on one axis. */
export interface ChartSeries {
  id: string;
  itineraryId: string;
  itineraryName: string;
  metricId: AxisMetricId;
  /** Stroke color (defaults to itinerary color). */
  color: string;
  axis: 1 | 2;
  unit: string;
  points: ChartPoint[];
}

/**
 * Soft background profile drawn behind the active metrics. Used for example
 * to show the route elevation profile when the user analyses slope.
 */
export interface ChartBackdropProfile {
  id: string;
  itineraryId: string;
  itineraryName: string;
  points: ChartPoint[];
}

/** Numeric domain (min/max) used for scaling the chart axes. */
export interface AxisDomain {
  min: number;
  max: number;
}

/** Returns the unit string displayed alongside a metric label. */
export function unitForMetric(metric: AxisMetricId): string {
  switch (metric) {
    case 'Vitesse':
    case 'Vitesse moyenne':
    case 'Vent (km/h)':
      return 'km/h';
    case 'Puissance':
    case 'Puissance moyenne':
      return 'W';
    case 'Altitude':
      return 'm';
    case 'Inclinaison (°)':
      return '°';
    case 'Inclinaison (%)':
      return '%';
    case 'Surface':
      return '';
    case 'Température':
    case 'Température ressentie (°)':
      return '°C';
    case 'Pluie (mm)':
      return 'mm';
    case 'Couverture nuageuse (%)':
    case 'Humidité (%)':
      return '%';
    case 'Ensoleillement (min)':
      return 'min';
    default:
      return '';
  }
}

export function isIntervalAverageMetric(metric: AxisMetricId): boolean {
  return metric === 'Vitesse moyenne' || metric === 'Puissance moyenne';
}

export function isInclinationMetric(metric: AxisMetricId): boolean {
  return metric === 'Inclinaison (°)' || metric === 'Inclinaison (%)';
}

/** Format a tick label according to the metric type. */
export function formatAxisValue(metric: AxisMetricId, value: number): string {
  if (!Number.isFinite(value)) return '--';
  const unit = unitForMetric(metric);
  let txt: string;
  if (Math.abs(value) >= 100 || Number.isInteger(value)) {
    txt = String(Math.round(value));
  } else if (Math.abs(value) >= 10) {
    txt = value.toFixed(1);
  } else {
    txt = value.toFixed(2).replace(/\.?0+$/u, '');
  }
  return unit ? `${txt} ${unit}` : txt;
}

/**
 * Whether a metric's running value can be computed from the prediction
 * timeline. Weather/surface metrics are not yet wired and return false so
 * the chart can show an empty plot rather than a flat zero line.
 */
export function metricIsAvailable(metric: AxisMetricId): boolean {
  switch (metric) {
    case 'Vitesse':
    case 'Vitesse moyenne':
    case 'Puissance':
    case 'Puissance moyenne':
    case 'Altitude':
    case 'Inclinaison (°)':
    case 'Inclinaison (%)':
      return true;
    default:
      return false;
  }
}

/** Read the raw value for a metric off a single prediction point. */
function metricValueAtPoint(metric: AxisMetricId, point: PredictionPoint): number {
  switch (metric) {
    case 'Vitesse':
    case 'Vitesse moyenne':
      return point.predicted_speed_kmh;
    case 'Puissance':
    case 'Puissance moyenne':
      return point.predicted_power_w;
    case 'Altitude':
      return point.elevation_m;
    case 'Inclinaison (%)':
      return point.gradient_pct;
    case 'Inclinaison (°)':
      return gradientPercentToDegrees(point.gradient_pct);
    default:
      return Number.NaN;
  }
}

/**
 * Build a chart series from a prediction result. Returns `null` when the
 * prediction is unavailable or the metric is not supported.
 *
 * - `Vitesse`/`Puissance`/`Altitude`/`Inclinaison`: raw timeline value.
 * - `Vitesse moyenne`/`Puissance moyenne`: raw timeline value too; the chart
 *   aggregates these later by X-axis interval so the average follows the
 *   current graduations.
 * - X axis is the configurable distance (km) or elapsed time (h).
 */
export function buildSeriesFromPrediction(
  prediction: PredictionResult,
  metric: AxisMetricId,
  xMode: AxisMode,
): ChartPoint[] | null {
  if (!prediction.points.length) return null;
  if (!metricIsAvailable(metric)) return null;

  const points: ChartPoint[] = [];

  for (let i = 0; i < prediction.points.length; i++) {
    const p = prediction.points[i];
    const x = xMode === 'distance' ? p.distance_m / 1000 : p.elapsed_time_s / 3600;
    const y = metricValueAtPoint(metric, p);

    if (Number.isFinite(x) && Number.isFinite(y)) {
      points.push({ x, y });
    }
  }

  points.sort((a, b) => a.x - b.x);

  return points.length > 1 ? points : null;
}

function gradientPercentToDegrees(gradientPercent: number): number {
  return (Math.atan(gradientPercent / 100) * 180) / Math.PI;
}

/** Compute a [min,max] domain over a list of series, padded by 5%. */
export function computeDomain(series: ChartPoint[][]): AxisDomain | null {
  let min = Infinity;
  let max = -Infinity;
  for (const arr of series) {
    for (const p of arr) {
      if (p.y < min) min = p.y;
      if (p.y > max) max = p.y;
    }
  }
  if (!Number.isFinite(min) || !Number.isFinite(max)) return null;
  if (min === max) {
    const pad = Math.abs(min) > 0 ? Math.abs(min) * 0.1 : 1;
    return { min: min - pad, max: max + pad };
  }
  const pad = (max - min) * 0.05;
  let lo = min - pad;
  let hi = max + pad;
  // Anchor to zero when values stay non-negative — feels more natural for
  // speed/power/elevation curves.
  if (min >= 0 && lo < 0) lo = 0;
  return { min: lo, max: hi };
}

/** Compute the X axis domain from the union of all series. */
export function computeXDomain(series: ChartPoint[][]): AxisDomain | null {
  let min = Infinity;
  let max = -Infinity;
  for (const arr of series) {
    for (const p of arr) {
      if (p.x < min) min = p.x;
      if (p.x > max) max = p.x;
    }
  }
  if (!Number.isFinite(min) || !Number.isFinite(max) || min === max) return null;
  return { min: min >= 0 ? 0 : min, max };
}
