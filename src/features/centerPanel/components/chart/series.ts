import type { PredictionPoint, PredictionResult } from '@/features/fitPredictor';

interface RouteChartPoint {
  lat: number;
  lon: number;
  distanceM?: number;
  elevationM?: number | null;
  gradientPct?: number | null;
}

interface NormalizedRoutePoint {
  distanceM: number;
  elevationM: number;
  gradientPct: number;
}

const EARTH_RADIUS_M = 6_371_008.8;

/**
 * Identifier of an axis option exposed by the analysis dropdowns. Keep in
 * sync with the labels rendered in {@link CenterPanelAnalysis}.
 */
export type AxisMetricId =
  | 'Vitesse'
  | 'Vitesse moyenne'
  | 'Puissance'
  | 'Puissance moyenne'
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

export type ChartMetricId = AxisMetricId | 'Altitude';

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
  metricId: ChartMetricId;
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
export function unitForMetric(metric: ChartMetricId): string {
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

export function isIntervalAverageMetric(metric: ChartMetricId): boolean {
  return metric === 'Vitesse moyenne' || metric === 'Puissance moyenne';
}

export function isInclinationMetric(metric: ChartMetricId): boolean {
  return metric === 'Inclinaison (°)' || metric === 'Inclinaison (%)';
}

/** Format a tick label according to the metric type. */
export function formatAxisValue(metric: ChartMetricId, value: number): string {
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
export function metricIsAvailable(metric: ChartMetricId): boolean {
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
function metricValueAtPoint(metric: ChartMetricId, point: PredictionPoint): number {
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

function isRouteBackedMetric(metric: ChartMetricId): boolean {
  return metric === 'Altitude' || isInclinationMetric(metric);
}

function haversineM(a: RouteChartPoint, b: RouteChartPoint): number {
  const toRad = (degrees: number) => (degrees * Math.PI) / 180;
  const dLat = toRad(b.lat - a.lat);
  const dLon = toRad(b.lon - a.lon);
  const lat1 = toRad(a.lat);
  const lat2 = toRad(b.lat);
  const h =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(lat1) * Math.cos(lat2) * Math.sin(dLon / 2) ** 2;
  return 2 * EARTH_RADIUS_M * Math.asin(Math.sqrt(h));
}

function smoothValues(values: number[], windowSize = 5): number[] {
  const out = new Array<number>(values.length);
  const half = Math.floor(windowSize / 2);
  for (let i = 0; i < values.length; i++) {
    const lo = Math.max(0, i - half);
    const hi = Math.min(values.length - 1, i + half);
    let sum = 0;
    for (let j = lo; j <= hi; j++) sum += values[j];
    out[i] = sum / (hi - lo + 1);
  }
  return out;
}

const GRADIENT_SEGMENT_M = 30;

function gradientWindowIndices(
  distances: number[],
  index: number,
  targetSpanM = GRADIENT_SEGMENT_M,
): { startIndex: number; endIndex: number } {
  const lastIndex = distances.length - 1;
  if (index <= 0) {
    let endIndex = 0;
    while (
      endIndex < lastIndex &&
      distances[endIndex] - distances[0] < targetSpanM
    ) {
      endIndex += 1;
    }
    return { startIndex: 0, endIndex };
  }
  if (index >= lastIndex) {
    let startIndex = lastIndex;
    while (
      startIndex > 0 &&
      distances[lastIndex] - distances[startIndex] < targetSpanM
    ) {
      startIndex -= 1;
    }
    return { startIndex, endIndex: lastIndex };
  }

  const minDistance = distances[0];
  const maxDistance = distances[lastIndex];
  const centerDistance = distances[index];
  const halfSpanM = targetSpanM / 2;
  let startTarget = centerDistance - halfSpanM;
  let endTarget = centerDistance + halfSpanM;

  if (startTarget < minDistance) {
    endTarget = Math.min(maxDistance, endTarget + (minDistance - startTarget));
    startTarget = minDistance;
  }
  if (endTarget > maxDistance) {
    startTarget = Math.max(minDistance, startTarget - (endTarget - maxDistance));
    endTarget = maxDistance;
  }

  let startIndex = index;
  while (startIndex > 0 && distances[startIndex] > startTarget) startIndex -= 1;

  let endIndex = index;
  while (endIndex < lastIndex && distances[endIndex] < endTarget) endIndex += 1;

  while (
    endIndex < lastIndex &&
    distances[endIndex] - distances[startIndex] < targetSpanM
  ) {
    endIndex += 1;
  }
  while (
    startIndex > 0 &&
    distances[endIndex] - distances[startIndex] < targetSpanM
  ) {
    startIndex -= 1;
  }

  return { startIndex, endIndex };
}

function computeGradientPercentAtIndex(
  distances: number[],
  elevations: number[],
  index: number,
  targetSpanM = GRADIENT_SEGMENT_M,
): number {
  const { startIndex, endIndex } = gradientWindowIndices(
    distances,
    index,
    targetSpanM,
  );
  const spanM = distances[endIndex] - distances[startIndex];
  if (spanM <= 0.5) return 0;
  return ((elevations[endIndex] - elevations[startIndex]) / spanM) * 100;
}

function normalizeRouteProfile(
  routePoints: RouteChartPoint[] | null | undefined,
): NormalizedRoutePoint[] | null {
  if (!routePoints || routePoints.length < 2) return null;

  const samples: Array<{ distanceM: number; elevationM: number; gradientPct?: number | null }> = [];
  let cumulativeDistanceM = 0;

  for (let i = 0; i < routePoints.length; i++) {
    const point = routePoints[i];
    if (i > 0) {
      const nextDistance = point.distanceM;
      if (Number.isFinite(nextDistance) && (nextDistance as number) >= cumulativeDistanceM) {
        cumulativeDistanceM = nextDistance as number;
      } else {
        cumulativeDistanceM += haversineM(routePoints[i - 1], point);
      }
    }

    if (!Number.isFinite(point.elevationM)) continue;
    samples.push({
      distanceM: cumulativeDistanceM,
      elevationM: point.elevationM as number,
      gradientPct: point.gradientPct,
    });
  }

  if (samples.length < 2) return null;

  const hasPersistedGradient = samples.some((sample) => Number.isFinite(sample.gradientPct));
  const smoothedElevations = hasPersistedGradient
    ? samples.map((sample) => sample.elevationM)
    : smoothValues(
        samples.map((sample) => sample.elevationM),
        3,
      );
  const distances = samples.map((sample) => sample.distanceM);

  return samples.map((sample, index) => {
    const gradientPct = computeGradientPercentAtIndex(
      distances,
      smoothedElevations,
      index,
    );
    return {
      distanceM: sample.distanceM,
      elevationM: smoothedElevations[index],
      gradientPct,
    };
  });
}

function interpolateElapsedHours(
  prediction: PredictionResult | null | undefined,
  distanceM: number,
): number | null {
  if (!prediction || prediction.points.length < 2) return null;

  const timeline = prediction.points.filter(
    (point) => Number.isFinite(point.distance_m) && Number.isFinite(point.elapsed_time_s),
  );
  if (timeline.length < 2) return null;

  if (distanceM <= timeline[0].distance_m) return timeline[0].elapsed_time_s / 3600;
  const last = timeline[timeline.length - 1];
  if (distanceM >= last.distance_m) return last.elapsed_time_s / 3600;

  let lo = 0;
  let hi = timeline.length - 1;
  while (lo + 1 < hi) {
    const mid = Math.floor((lo + hi) / 2);
    if (timeline[mid].distance_m <= distanceM) lo = mid;
    else hi = mid;
  }

  const start = timeline[lo];
  const end = timeline[hi];
  const span = end.distance_m - start.distance_m;
  if (span <= 0) return start.elapsed_time_s / 3600;
  const t = (distanceM - start.distance_m) / span;
  return (start.elapsed_time_s + (end.elapsed_time_s - start.elapsed_time_s) * t) / 3600;
}

function buildSeriesFromRouteProfile(
  routePoints: RouteChartPoint[] | null | undefined,
  prediction: PredictionResult | null | undefined,
  metric: ChartMetricId,
  xMode: AxisMode,
): ChartPoint[] | null {
  const profile = normalizeRouteProfile(routePoints);
  if (!profile) return null;

  const points: ChartPoint[] = [];
  for (const sample of profile) {
    const x =
      xMode === 'distance'
        ? sample.distanceM / 1000
        : interpolateElapsedHours(prediction, sample.distanceM);
    const y =
      metric === 'Altitude'
        ? sample.elevationM
        : metric === 'Inclinaison (%)'
          ? sample.gradientPct
          : gradientPercentToDegrees(sample.gradientPct);

    if (Number.isFinite(x) && Number.isFinite(y)) {
      points.push({ x: x as number, y });
    }
  }

  return points.length > 1 ? points : null;
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
  prediction: PredictionResult | null | undefined,
  metric: ChartMetricId,
  xMode: AxisMode,
  routePoints?: RouteChartPoint[] | null,
): ChartPoint[] | null {
  if (isRouteBackedMetric(metric)) {
    const routeSeries = buildSeriesFromRouteProfile(routePoints, prediction, metric, xMode);
    if (routeSeries) return routeSeries;
  }

  if (!prediction) return null;
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
