import {
  isInclinationMetric,
  type AxisDomain,
  type ChartMetricId,
} from '../series';

const HOVER_X_EMIT_EPSILON = 1e-4;
export const MIN_VISIBLE_FRACTION = 0.04;

export function defaultDomainFor(metric: ChartMetricId): AxisDomain {
  switch (metric) {
    case 'Vitesse':
    case 'Vitesse moyenne':
      return { min: 0, max: 50 };
    case 'Puissance':
    case 'Puissance moyenne':
      return { min: 0, max: 400 };
    case 'Altitude':
      return { min: 0, max: 3000 };
    case 'Inclinaison (°)':
      return { min: -90, max: 90 };
    case 'Inclinaison (%)':
      return { min: -100, max: 100 };
    default:
      return { min: 0, max: 100 };
  }
}

export function normalizeMetricDomain(
  metric: ChartMetricId,
  domain: AxisDomain,
): AxisDomain {
  if (!isInclinationMetric(metric)) return domain;
  const min = Math.min(domain.min, 0);
  const max = Math.max(domain.max, 0);
  if (metric === 'Inclinaison (°)') {
    return {
      min: clamp(min, -90, 90),
      max: clamp(max, -90, 90),
    };
  }
  return { min, max };
}

export function clampXDomainToRoute(
  domain: AxisDomain | null,
  routeClamp: AxisDomain | null,
): AxisDomain | null {
  if (!domain) return routeClamp;
  if (!routeClamp) return domain;

  const max = Math.min(domain.max, routeClamp.max);
  const min = Math.max(domain.min, routeClamp.min);
  if (!Number.isFinite(min) || !Number.isFinite(max) || max <= min) return routeClamp;
  return { min, max };
}

export function clipPointsToXDomain(
  points: { x: number; y: number }[],
  xDomain: AxisDomain,
): { x: number; y: number }[] {
  if (points.length === 0) return [];

  const firstX = points[0]?.x ?? 0;
  const lastX = points[points.length - 1]?.x ?? 0;
  const clipped = points
    .filter((point) => point.x >= xDomain.min && point.x <= xDomain.max)
    .map((point) => ({ ...point }));

  if (xDomain.min >= firstX && xDomain.min <= lastX) {
    clipped.push({ x: xDomain.min, y: interpolateY(points, xDomain.min) });
  }
  if (xDomain.max >= firstX && xDomain.max <= lastX) {
    clipped.push({ x: xDomain.max, y: interpolateY(points, xDomain.max) });
  }

  clipped.sort((left, right) => left.x - right.x);

  const deduped: { x: number; y: number }[] = [];
  for (const point of clipped) {
    const prev = deduped[deduped.length - 1];
    if (prev && Math.abs(prev.x - point.x) < 1e-6) {
      deduped[deduped.length - 1] = point;
      continue;
    }
    deduped.push(point);
  }

  return deduped;
}

export function compressPointsForPlot(
  points: { x: number; y: number }[],
  xDomain: AxisDomain,
  plotWidth: number,
): { x: number; y: number }[] {
  const bucketCount = Math.max(32, Math.round(plotWidth * 1.5));
  const span = xDomain.max - xDomain.min;
  if (points.length <= bucketCount * 2 || span <= 0 || plotWidth <= 0) return points;

  const compressed: { x: number; y: number }[] = [];
  let activeBucket = -1;
  let bucketPoints: { x: number; y: number }[] = [];

  const pushPoint = (point: { x: number; y: number }) => {
    const previous = compressed[compressed.length - 1];
    if (
      previous &&
      Math.abs(previous.x - point.x) < 1e-6 &&
      Math.abs(previous.y - point.y) < 1e-6
    ) {
      return;
    }
    compressed.push(point);
  };

  const flushBucket = () => {
    if (bucketPoints.length === 0) return;

    let minPoint = bucketPoints[0];
    let maxPoint = bucketPoints[0];
    for (const point of bucketPoints) {
      if (point.y < minPoint.y) minPoint = point;
      if (point.y > maxPoint.y) maxPoint = point;
    }

    const ordered = [
      bucketPoints[0],
      minPoint,
      maxPoint,
      bucketPoints[bucketPoints.length - 1],
    ]
      .filter((point, index, array) => array.indexOf(point) === index)
      .sort((left, right) => left.x - right.x);

    for (const point of ordered) pushPoint(point);
    bucketPoints = [];
  };

  for (const point of points) {
    const ratio = (point.x - xDomain.min) / span;
    const nextBucket = clamp(Math.floor(ratio * bucketCount), 0, bucketCount - 1);
    if (nextBucket !== activeBucket) {
      flushBucket();
      activeBucket = nextBucket;
    }
    bucketPoints.push(point);
  }

  flushBucket();
  return compressed;
}

export function ratioFor(value: number, domain: AxisDomain): number {
  const span = domain.max - domain.min;
  if (span <= 0) return 0;
  return Math.max(0, Math.min(1, (value - domain.min) / span));
}

export function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value));
}

export function normalizeUnitInterval(value: number): number {
  if (!Number.isFinite(value)) return 0;
  return clamp(value, 0, 1);
}

export function sameOptionalNumber(
  left: number | null,
  right: number | null,
): boolean {
  if (left == null || right == null) return left === right;
  return Math.abs(left - right) <= HOVER_X_EMIT_EPSILON;
}

export function detailZoomToVisibleFraction(detailZoom: number): number {
  return 1 - normalizeUnitInterval(detailZoom) * (1 - MIN_VISIBLE_FRACTION);
}

export function buildVisibleXDomain(
  xDomain: AxisDomain,
  visibleFraction: number,
  detailOffset: number,
): AxisDomain {
  const span = xDomain.max - xDomain.min;
  if (span <= 0) return xDomain;

  const visibleSpan = span * clamp(visibleFraction, MIN_VISIBLE_FRACTION, 1);
  const remainingSpan = Math.max(0, span - visibleSpan);
  const start = xDomain.min + remainingSpan * normalizeUnitInterval(detailOffset);
  return {
    min: start,
    max: start + visibleSpan,
  };
}

export function interpolateY(
  points: { x: number; y: number }[],
  xValue: number,
): number {
  if (points.length === 0) return Number.NaN;
  if (xValue <= points[0].x) return points[0].y;
  if (xValue >= points[points.length - 1].x) return points[points.length - 1].y;

  let lo = 0;
  let hi = points.length - 1;
  while (hi - lo > 1) {
    const mid = (lo + hi) >> 1;
    if (points[mid].x <= xValue) lo = mid;
    else hi = mid;
  }

  const a = points[lo];
  const b = points[hi];
  const span = b.x - a.x;
  if (span <= 0) return a.y;
  const t = (xValue - a.x) / span;
  return a.y + (b.y - a.y) * t;
}

export function buildInterpolatedTicks(
  max: number,
  min: number,
  count: number,
): number[] {
  if (count <= 1) return [max];
  return Array.from({ length: count }, (_, index) => {
    const ratio = index / (count - 1);
    return max + (min - max) * ratio;
  });
}

export function buildNiceTicks(
  min: number,
  max: number,
  targetCount: number,
): number[] {
  const range = Math.max(1e-9, max - min);
  const desired = Math.max(2, targetCount);
  const rough = range / desired;
  const pow10 = Math.pow(10, Math.floor(Math.log10(rough)));
  const norm = rough / pow10;
  let nice: number;

  if (norm < 1.5) nice = 1;
  else if (norm < 3) nice = 2;
  else if (norm < 4) nice = 2.5;
  else if (norm < 7) nice = 5;
  else nice = 10;

  const step = nice * pow10;
  const start = Math.ceil(min / step) * step;
  const ticks: number[] = [];
  for (let value = start; value <= max + step * 1e-6; value += step) {
    ticks.push(Number((Math.round(value / step) * step).toFixed(10)));
  }
  if (ticks.length === 0 || ticks[0] > min + step * 1e-6) ticks.unshift(min);
  if (ticks[ticks.length - 1] < max - step * 1e-6) ticks.push(max);

  const seen = new Set<number>();
  return ticks.filter((value) => {
    if (seen.has(value)) return false;
    seen.add(value);
    return true;
  });
}