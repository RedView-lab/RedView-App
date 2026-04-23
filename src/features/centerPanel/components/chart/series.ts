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

interface TimelineSample {
  distanceM: number;
  elapsedHours: number;
}

const EARTH_RADIUS_M = 6_371_008.8;
const INTERVAL_AVERAGE_SPAN_M = 500;
const MAX_CHART_POINT_COUNT = 2_048;
const normalizedRouteProfileCache = new WeakMap<RouteChartPoint[], NormalizedRoutePoint[] | null>();
const predictionTimelineCache = new WeakMap<PredictionResult, TimelineSample[] | null>();

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

export type AxisMode = 'distance' | 'temps' | 'heure';

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

interface DistanceMetricSample {
  distanceM: number;
  elapsedHours: number;
  value: number;
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

  const cached = normalizedRouteProfileCache.get(routePoints);
  if (cached !== undefined) return cached;

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

  if (samples.length < 2) {
    normalizedRouteProfileCache.set(routePoints, null);
    return null;
  }

  const hasPersistedGradient = samples.some((sample) => Number.isFinite(sample.gradientPct));
  const smoothedElevations = hasPersistedGradient
    ? samples.map((sample) => sample.elevationM)
    : smoothValues(
        samples.map((sample) => sample.elevationM),
        3,
      );
  const distances = samples.map((sample) => sample.distanceM);

  const normalized = samples.map((sample, index) => {
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

  normalizedRouteProfileCache.set(routePoints, normalized);
  return normalized;
}

function getPredictionTimeline(
  prediction: PredictionResult | null | undefined,
): TimelineSample[] | null {
  if (!prediction || prediction.points.length < 2) return null;

  const cached = predictionTimelineCache.get(prediction);
  if (cached !== undefined) return cached;

  const timeline = prediction.points
    .map((point) => ({
      distanceM: point.distance_m,
      elapsedHours: point.elapsed_time_s / 3600,
    }))
    .filter(
      (point) => Number.isFinite(point.distanceM) && Number.isFinite(point.elapsedHours),
    );

  const result = timeline.length >= 2 ? timeline : null;
  predictionTimelineCache.set(prediction, result);
  return result;
}

function interpolateElapsedHoursFromTimeline(
  timeline: TimelineSample[] | null,
  distanceM: number,
): number | null {
  if (!timeline || timeline.length < 2) return null;

  if (distanceM <= timeline[0].distanceM) return timeline[0].elapsedHours;
  const last = timeline[timeline.length - 1];
  if (distanceM >= last.distanceM) return last.elapsedHours;

  let lo = 0;
  let hi = timeline.length - 1;
  while (lo + 1 < hi) {
    const mid = Math.floor((lo + hi) / 2);
    if (timeline[mid].distanceM <= distanceM) lo = mid;
    else hi = mid;
  }

  const start = timeline[lo];
  const end = timeline[hi];
  const span = end.distanceM - start.distanceM;
  if (span <= 0) return start.elapsedHours;
  const t = (distanceM - start.distanceM) / span;
  return start.elapsedHours + (end.elapsedHours - start.elapsedHours) * t;
}

function fitChartPointBudget(
  points: ChartPoint[],
  maxPoints = MAX_CHART_POINT_COUNT,
): ChartPoint[] {
  if (points.length <= maxPoints) return points;

  const first = points[0];
  const last = points[points.length - 1];
  const span = last.x - first.x;
  if (span <= 0) return [first, last];

  const bucketCount = Math.max(8, Math.floor(maxPoints / 2));
  const buckets: ChartPoint[][] = Array.from({ length: bucketCount }, () => []);
  for (const point of points) {
    const ratio = (point.x - first.x) / span;
    const bucketIndex = Math.max(0, Math.min(bucketCount - 1, Math.floor(ratio * bucketCount)));
    buckets[bucketIndex]?.push(point);
  }

  const reduced: ChartPoint[] = [];
  const pushPoint = (point: ChartPoint) => {
    const previous = reduced[reduced.length - 1];
    if (
      previous &&
      Math.abs(previous.x - point.x) < 1e-6 &&
      Math.abs(previous.y - point.y) < 1e-6
    ) {
      return;
    }
    reduced.push(point);
  };

  for (const bucket of buckets) {
    if (bucket.length === 0) continue;

    let minPoint = bucket[0];
    let maxPoint = bucket[0];
    for (const point of bucket) {
      if (point.y < minPoint.y) minPoint = point;
      if (point.y > maxPoint.y) maxPoint = point;
    }

    const ordered = [bucket[0], minPoint, maxPoint, bucket[bucket.length - 1]]
      .filter((point, index, arr) => arr.indexOf(point) === index)
      .sort((left, right) => left.x - right.x);

    for (const point of ordered) pushPoint(point);
  }

  return reduced.length >= 2 ? reduced : [first, last];
}

function buildSeriesFromRouteProfile(
  routePoints: RouteChartPoint[] | null | undefined,
  prediction: PredictionResult | null | undefined,
  metric: ChartMetricId,
  xMode: AxisMode,
  startTime?: string | null,
): ChartPoint[] | null {
  const profile = normalizeRouteProfile(routePoints);
  if (!profile) return null;
  const timeline = xMode === 'distance' ? null : getPredictionTimeline(prediction);

  const points: ChartPoint[] = [];
  for (const sample of profile) {
    const x =
      xMode === 'distance'
        ? sample.distanceM / 1000
        : projectElapsedHoursToX(
            interpolateElapsedHoursFromTimeline(timeline, sample.distanceM),
            xMode,
            startTime,
          );
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

  return points.length > 1 ? fitChartPointBudget(points) : null;
}

function buildDistanceMetricSamples(
  prediction: PredictionResult,
  metric: ChartMetricId,
): DistanceMetricSample[] {
  const samples = prediction.points
    .map((point) => ({
      distanceM: point.distance_m,
      elapsedHours: point.elapsed_time_s / 3600,
      value: metricValueAtPoint(metric, point),
    }))
    .filter(
      (sample) =>
        Number.isFinite(sample.distanceM) &&
        Number.isFinite(sample.elapsedHours) &&
        Number.isFinite(sample.value),
    )
    .sort((left, right) => left.distanceM - right.distanceM);

  const deduped: DistanceMetricSample[] = [];
  for (const sample of samples) {
    const prev = deduped[deduped.length - 1];
    if (prev && Math.abs(prev.distanceM - sample.distanceM) < 1e-6) {
      deduped[deduped.length - 1] = sample;
      continue;
    }
    deduped.push(sample);
  }

  return deduped;
}

function interpolateDistanceMetricValue(
  samples: DistanceMetricSample[],
  distanceM: number,
): number {
  if (samples.length === 0) return Number.NaN;
  if (distanceM <= samples[0].distanceM) return samples[0].value;
  if (distanceM >= samples[samples.length - 1].distanceM) {
    return samples[samples.length - 1].value;
  }

  let lo = 0;
  let hi = samples.length - 1;
  while (hi - lo > 1) {
    const mid = (lo + hi) >> 1;
    if (samples[mid].distanceM <= distanceM) lo = mid;
    else hi = mid;
  }

  const start = samples[lo];
  const end = samples[hi];
  const spanM = end.distanceM - start.distanceM;
  if (spanM <= 0) return start.value;
  const ratio = (distanceM - start.distanceM) / spanM;
  return start.value + (end.value - start.value) * ratio;
}

function interpolateElapsedHoursAtDistance(
  samples: DistanceMetricSample[],
  distanceM: number,
): number {
  if (samples.length === 0) return Number.NaN;
  if (distanceM <= samples[0].distanceM) return samples[0].elapsedHours;
  if (distanceM >= samples[samples.length - 1].distanceM) {
    return samples[samples.length - 1].elapsedHours;
  }

  let lo = 0;
  let hi = samples.length - 1;
  while (hi - lo > 1) {
    const mid = (lo + hi) >> 1;
    if (samples[mid].distanceM <= distanceM) lo = mid;
    else hi = mid;
  }

  const start = samples[lo];
  const end = samples[hi];
  const spanM = end.distanceM - start.distanceM;
  if (spanM <= 0) return start.elapsedHours;
  const ratio = (distanceM - start.distanceM) / spanM;
  return start.elapsedHours + (end.elapsedHours - start.elapsedHours) * ratio;
}

function averageDistanceMetricOverInterval(
  samples: DistanceMetricSample[],
  startDistanceM: number,
  endDistanceM: number,
): number {
  const spanM = endDistanceM - startDistanceM;
  if (spanM <= 0) return Number.NaN;

  const breakpoints = [startDistanceM];
  for (const sample of samples) {
    if (sample.distanceM > startDistanceM && sample.distanceM < endDistanceM) {
      breakpoints.push(sample.distanceM);
    }
  }
  breakpoints.push(endDistanceM);

  let integral = 0;
  let prevDistanceM = breakpoints[0] ?? startDistanceM;
  let prevValue = interpolateDistanceMetricValue(samples, prevDistanceM);
  for (let index = 1; index < breakpoints.length; index += 1) {
    const currentDistanceM = breakpoints[index] ?? prevDistanceM;
    const currentValue = interpolateDistanceMetricValue(samples, currentDistanceM);
    integral += ((prevValue + currentValue) / 2) * (currentDistanceM - prevDistanceM);
    prevDistanceM = currentDistanceM;
    prevValue = currentValue;
  }

  return integral / spanM;
}

function buildFixedDistanceAverageSeries(
  prediction: PredictionResult,
  metric: ChartMetricId,
  xMode: AxisMode,
  startTime?: string | null,
): ChartPoint[] | null {
  const samples = buildDistanceMetricSamples(prediction, metric);
  if (samples.length < 2) return null;

  const firstDistanceM = samples[0].distanceM;
  const lastDistanceM = samples[samples.length - 1].distanceM;
  if (lastDistanceM <= firstDistanceM) return null;

  const result: ChartPoint[] = [];
  let startDistanceM = Math.max(
    0,
    Math.floor(firstDistanceM / INTERVAL_AVERAGE_SPAN_M) * INTERVAL_AVERAGE_SPAN_M,
  );

  while (startDistanceM < lastDistanceM - 1e-6) {
    const endDistanceM = Math.min(lastDistanceM, startDistanceM + INTERVAL_AVERAGE_SPAN_M);
    const avg = averageDistanceMetricOverInterval(samples, startDistanceM, endDistanceM);
    const startX =
      xMode === 'distance'
        ? startDistanceM / 1000
        : projectElapsedHoursToX(
            interpolateElapsedHoursAtDistance(samples, startDistanceM),
            xMode,
            startTime,
          );
    const endX =
      xMode === 'distance'
        ? endDistanceM / 1000
        : projectElapsedHoursToX(
            interpolateElapsedHoursAtDistance(samples, endDistanceM),
            xMode,
            startTime,
          );

    if (Number.isFinite(avg) && Number.isFinite(startX) && Number.isFinite(endX) && endX > startX) {
      if (result.length === 0) {
        result.push({ x: startX, y: avg });
      } else {
        const prev = result[result.length - 1];
        if (Math.abs(prev.x - startX) > 1e-6) {
          result.push({ x: startX, y: prev.y });
        }
        if (Math.abs(prev.y - avg) > 1e-6) {
          result.push({ x: startX, y: avg });
        }
      }

      result.push({ x: endX, y: avg });
    }

    startDistanceM = endDistanceM;
  }

  return result.length > 1 ? fitChartPointBudget(result) : null;
}

/**
 * Build a chart series from a prediction result. Returns `null` when the
 * prediction is unavailable or the metric is not supported.
 *
 * - `Vitesse`/`Puissance`/`Altitude`/`Inclinaison`: raw timeline value.
 * - `Vitesse moyenne`/`Puissance moyenne`: fixed 500 m interval averages,
 *   independent from the chart zoom level or visible graduations.
 * - X axis is the configurable distance (km) or elapsed time (h).
 */
export function buildSeriesFromPrediction(
  prediction: PredictionResult | null | undefined,
  metric: ChartMetricId,
  xMode: AxisMode,
  routePoints?: RouteChartPoint[] | null,
  startTime?: string | null,
): ChartPoint[] | null {
  if (isRouteBackedMetric(metric)) {
    const routeSeries = buildSeriesFromRouteProfile(
      routePoints,
      prediction,
      metric,
      xMode,
      startTime,
    );
    if (routeSeries) return routeSeries;
  }

  if (!prediction) return null;
  if (!prediction.points.length) return null;
  if (!metricIsAvailable(metric)) return null;

  if (isIntervalAverageMetric(metric)) {
    const averageSeries = buildFixedDistanceAverageSeries(prediction, metric, xMode, startTime);
    if (averageSeries) return averageSeries;
  }

  const points: ChartPoint[] = [];

  for (let i = 0; i < prediction.points.length; i++) {
    const p = prediction.points[i];
    const x =
      xMode === 'distance'
        ? p.distance_m / 1000
        : projectElapsedHoursToX(p.elapsed_time_s / 3600, xMode, startTime);
    const y = metricValueAtPoint(metric, p);

    if (Number.isFinite(x) && Number.isFinite(y)) {
      points.push({ x, y });
    }
  }

  points.sort((a, b) => a.x - b.x);

  return points.length > 1 ? fitChartPointBudget(points) : null;
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
  const hi = max + pad;
  // Anchor to zero when values stay non-negative — feels more natural for
  // speed/power/elevation curves.
  if (min >= 0 && lo < 0) lo = 0;
  return { min: lo, max: hi };
}

/** Compute the X axis domain from the union of all series. */
export function computeXDomain(series: ChartPoint[][], xMode: AxisMode): AxisDomain | null {
  let min = Infinity;
  let max = -Infinity;
  for (const arr of series) {
    for (const p of arr) {
      if (p.x < min) min = p.x;
      if (p.x > max) max = p.x;
    }
  }
  if (!Number.isFinite(min) || !Number.isFinite(max) || min === max) return null;
  if (xMode === 'heure') return { min, max };
  return { min: min >= 0 ? 0 : min, max };
}

function projectElapsedHoursToX(
  elapsedHours: number | null,
  xMode: AxisMode,
  startTime?: string | null,
): number {
  if (!Number.isFinite(elapsedHours)) return Number.NaN;
  if (xMode !== 'heure') return elapsedHours as number;
  return (elapsedHours as number) + parseStartTimeHours(startTime);
}

function parseStartTimeHours(startTime?: string | null): number {
  if (!startTime) return 0;
  const [hoursRaw, minutesRaw] = startTime.split(':');
  const hours = Number.parseInt(hoursRaw ?? '', 10);
  const minutes = Number.parseInt(minutesRaw ?? '', 10);
  if (!Number.isFinite(hours) || !Number.isFinite(minutes)) return 0;
  return hours + minutes / 60;
}
