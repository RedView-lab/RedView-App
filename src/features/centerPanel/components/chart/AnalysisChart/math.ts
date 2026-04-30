import {
  isInclinationMetric,
  type AxisDomain,
  type ChartMetricId,
} from '../series';

const HOVER_X_EMIT_EPSILON = 1e-4;
export const MIN_VISIBLE_FRACTION = 0.04;
const MIN_LOD_LEVEL_POINTS = 256;
const LOD_TARGET_VISIBLE_POINTS_PER_PX = 3;
const plotLodLevelsCache = new WeakMap<{ x: number; y: number }[], { x: number; y: number }[][]>();

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

function clipPointsToXDomain(
  points: { x: number; y: number }[],
  xDomain: AxisDomain,
): { x: number; y: number }[] {
  if (points.length === 0) return [];

  const firstX = points[0]?.x ?? 0;
  const lastX = points[points.length - 1]?.x ?? 0;
  if (xDomain.max < firstX || xDomain.min > lastX) return [];
  if (xDomain.min <= firstX && xDomain.max >= lastX) return points;

  const startIndex = lowerBoundPointIndex(points, xDomain.min);
  const endIndexExclusive = upperBoundPointIndex(points, xDomain.max);
  const clipped: { x: number; y: number }[] = [];

  if (xDomain.min > firstX && xDomain.min < lastX) {
    clipped.push({ x: xDomain.min, y: interpolateY(points, xDomain.min) });
  }

  if (endIndexExclusive > startIndex) {
    clipped.push(...points.slice(startIndex, endIndexExclusive));
  }

  if (xDomain.max > firstX && xDomain.max < lastX) {
    clipped.push({ x: xDomain.max, y: interpolateY(points, xDomain.max) });
  }

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

function lowerBoundPointIndex(points: { x: number; y: number }[], xValue: number): number {
  let lo = 0;
  let hi = points.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (points[mid].x < xValue) lo = mid + 1;
    else hi = mid;
  }
  return lo;
}

function upperBoundPointIndex(points: { x: number; y: number }[], xValue: number): number {
  let lo = 0;
  let hi = points.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (points[mid].x <= xValue) lo = mid + 1;
    else hi = mid;
  }
  return lo;
}

function compressPointsForPlot(
  points: { x: number; y: number }[],
  xDomain: AxisDomain,
  plotWidth: number,
): { x: number; y: number }[] {
  const bucketCount = Math.max(32, Math.round(plotWidth));
  if (points.length <= 2 || plotWidth <= 0) return points;
  return compressPointsToBucketCount(points, xDomain, bucketCount);
}

export function selectPointsForPlotLod(
  points: { x: number; y: number }[],
  xDomain: AxisDomain,
  plotWidth: number,
): { x: number; y: number }[] {
  if (points.length < 2 || plotWidth <= 0) return points;

  const fullDomain = {
    min: points[0]?.x ?? xDomain.min,
    max: points[points.length - 1]?.x ?? xDomain.max,
  };
  const fullSpan = fullDomain.max - fullDomain.min;
  if (!(fullSpan > 0)) {
    return compressPointsForPlot(clipPointsToXDomain(points, xDomain), xDomain, plotWidth);
  }

  const visibleSpan = Math.max(0, xDomain.max - xDomain.min);
  const visibleFraction = clamp(visibleSpan / fullSpan, 0, 1);
  const targetVisiblePoints = Math.max(
    192,
    Math.round(plotWidth * LOD_TARGET_VISIBLE_POINTS_PER_PX),
  );

  let selected = points;
  for (const level of getPlotLodLevels(points)) {
    if (level === points) continue;
    const expectedVisiblePoints = Math.ceil(level.length * visibleFraction);
    if (expectedVisiblePoints <= targetVisiblePoints) {
      selected = level;
      break;
    }
  }

  return compressPointsForPlot(clipPointsToXDomain(selected, xDomain), xDomain, plotWidth);
}

function getPlotLodLevels(
  points: { x: number; y: number }[],
): { x: number; y: number }[][] {
  const cached = plotLodLevelsCache.get(points);
  if (cached) return cached;

  if (points.length < MIN_LOD_LEVEL_POINTS * 2) {
    const trivial = [points];
    plotLodLevelsCache.set(points, trivial);
    return trivial;
  }

  const fullDomain = {
    min: points[0]?.x ?? 0,
    max: points[points.length - 1]?.x ?? 0,
  };
  const levels: { x: number; y: number }[][] = [points];
  let targetMaxPoints = Math.floor(points.length / 2);

  while (targetMaxPoints >= MIN_LOD_LEVEL_POINTS) {
    const reduced = compressPointsToTarget(points, fullDomain, targetMaxPoints);
    const previous = levels[levels.length - 1] ?? points;
    if (reduced.length >= previous.length) break;
    levels.push(reduced);
    targetMaxPoints = Math.floor(targetMaxPoints / 2);
  }

  plotLodLevelsCache.set(points, levels);
  return levels;
}

function compressPointsToTarget(
  points: { x: number; y: number }[],
  xDomain: AxisDomain,
  targetMaxPoints: number,
): { x: number; y: number }[] {
  const span = xDomain.max - xDomain.min;
  if (points.length <= targetMaxPoints || span <= 0 || targetMaxPoints <= 0) return points;

  const bucketCount = Math.max(32, Math.ceil(targetMaxPoints / 4));

  return compressPointsToBucketCount(points, xDomain, bucketCount);
}

function compressPointsToBucketCount(
  points: { x: number; y: number }[],
  xDomain: AxisDomain,
  bucketCount: number,
): { x: number; y: number }[] {
  const span = xDomain.max - xDomain.min;
  if (points.length <= 2 || span <= 0 || bucketCount <= 0) return points;

  const compressed: { x: number; y: number }[] = [];
  let activeBucket = -1;
  let firstPoint: { x: number; y: number } | null = null;
  let lastPoint: { x: number; y: number } | null = null;
  let minPoint: { x: number; y: number } | null = null;
  let maxPoint: { x: number; y: number } | null = null;

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
    if (!firstPoint || !lastPoint || !minPoint || !maxPoint) return;

    const ordered = [
      firstPoint,
      minPoint,
      maxPoint,
      lastPoint,
    ]
      .filter((point, index, array) => array.indexOf(point) === index)
      .sort((left, right) => left.x - right.x);

    for (const point of ordered) pushPoint(point);
    firstPoint = null;
    lastPoint = null;
    minPoint = null;
    maxPoint = null;
  };

  for (const point of points) {
    const ratio = (point.x - xDomain.min) / span;
    const nextBucket = clamp(Math.floor(ratio * bucketCount), 0, bucketCount - 1);
    if (nextBucket !== activeBucket) {
      flushBucket();
      activeBucket = nextBucket;
      firstPoint = point;
      lastPoint = point;
      minPoint = point;
      maxPoint = point;
      continue;
    }

    lastPoint = point;
    if (!minPoint || point.y < minPoint.y) minPoint = point;
    if (!maxPoint || point.y > maxPoint.y) maxPoint = point;
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