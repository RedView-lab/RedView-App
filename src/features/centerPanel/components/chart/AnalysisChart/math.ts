import {
  isInclinationMetric,
  type AxisDomain,
  type ChartMetricId,
} from '../series';

export const MIN_VISIBLE_FRACTION = 0.04;

export interface NiceDomainResult {
  domain: AxisDomain;
  step: number;
  ticks: number[];
}

export function defaultDomainFor(metric: ChartMetricId): AxisDomain {
  switch (metric) {
    case 'Altitude':
      return { min: 0, max: 2000 };
    case 'Vitesse':
    case 'Vitesse moyenne':
      return { min: 0, max: 50 };
    case 'Puissance':
    case 'Puissance moyenne':
      return { min: 0, max: 400 };
    case 'Inclinaison (°)':
      return { min: -25, max: 25 };
    case 'Inclinaison (%)':
      return { min: -20, max: 20 };
    case 'Température':
    case 'Température ressentie (°)':
      return { min: 0, max: 40 };
    case 'Vent (km/h)':
      return { min: 0, max: 80 };
    case 'Pluie (mm)':
      return { min: 0, max: 20 };
    default:
      return { min: 0, max: 100 };
  }
}

export function normalizeMetricDomain(
  metric: ChartMetricId,
  domain: AxisDomain,
): AxisDomain {
  if (isInclinationMetric(metric)) {
    const bound = Math.max(Math.abs(domain.min), Math.abs(domain.max), 5);
    const maxBound = metric === 'Inclinaison (°)' ? 45 : 30;
    const clampedBound = Math.min(maxBound, Math.ceil(bound / 5) * 5);
    return { min: -clampedBound, max: clampedBound };
  }
  return domain;
}

export function buildNiceDomain(
  min: number,
  max: number,
  targetCount: number,
  options?: {
    forceZero?: boolean;
    clampMin?: number;
    clampMax?: number;
  },
): NiceDomainResult {
  let rawMin = Number.isFinite(min) ? min : 0;
  let rawMax = Number.isFinite(max) ? max : 100;
  if (rawMin > rawMax) {
    const tmp = rawMin;
    rawMin = rawMax;
    rawMax = tmp;
  }
  if (rawMin === rawMax) {
    const pad = Math.abs(rawMin) > 0 ? Math.abs(rawMin) * 0.1 : 1;
    rawMin -= pad;
    rawMax += pad;
  }

  if (options?.forceZero) {
    if (rawMin > 0) rawMin = 0;
    if (rawMax < 0) rawMax = 0;
  }

  const range = Math.max(1e-6, rawMax - rawMin);
  const desired = Math.max(2, targetCount);
  const rough = range / desired;
  const pow10 = Math.pow(10, Math.floor(Math.log10(rough)));
  const norm = rough / pow10;
  let niceMult: number;

  if (norm < 1.4) niceMult = 1;
  else if (norm < 2.8) niceMult = 2;
  else if (norm < 4.2) niceMult = 2.5;
  else if (norm < 7.5) niceMult = 5;
  else niceMult = 10;

  const step = niceMult * pow10;
  let niceMin = Math.floor(rawMin / step) * step;
  let niceMax = Math.ceil(rawMax / step) * step;

  if (options?.forceZero && rawMin >= 0 && niceMin < 0) {
    niceMin = 0;
  }

  if (niceMax <= niceMin) {
    niceMax = niceMin + step;
  }

  if (options?.clampMin != null) niceMin = Math.max(options.clampMin, niceMin);
  if (options?.clampMax != null) niceMax = Math.min(options.clampMax, niceMax);

  const ticks: number[] = [];
  const count = Math.min(100, Math.round((niceMax - niceMin) / step) + 1);
  for (let i = 0; i < count; i++) {
    const val = Number((niceMin + i * step).toFixed(8));
    if (val <= niceMax + step * 1e-4) {
      ticks.push(val);
    }
  }

  return {
    domain: { min: niceMin, max: niceMax },
    step,
    ticks,
  };
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

export function downsampleLTTB(
  points: { x: number; y: number }[],
  targetPoints: number,
): { x: number; y: number }[] {
  if (points.length <= targetPoints || targetPoints <= 2) return points;

  const sampled: { x: number; y: number }[] = [];
  const bucketSize = (points.length - 2) / (targetPoints - 2);

  let a = 0;
  sampled.push(points[a]!);

  for (let i = 0; i < targetPoints - 2; i++) {
    let avgX = 0;
    let avgY = 0;
    const avgRangeStart = Math.floor((i + 1) * bucketSize) + 1;
    const avgRangeEnd = Math.min(Math.floor((i + 2) * bucketSize) + 1, points.length);
    const avgRangeLength = avgRangeEnd - avgRangeStart;

    for (let j = avgRangeStart; j < avgRangeEnd; j++) {
      avgX += points[j]!.x;
      avgY += points[j]!.y;
    }
    if (avgRangeLength > 0) {
      avgX /= avgRangeLength;
      avgY /= avgRangeLength;
    }

    const rangeOffs = Math.floor(i * bucketSize) + 1;
    const rangeTo = Math.min(Math.floor((i + 1) * bucketSize) + 1, points.length);

    const pointAX = points[a]!.x;
    const pointAY = points[a]!.y;

    let maxArea = -1;
    let maxAreaPointIndex = rangeOffs;

    for (let j = rangeOffs; j < rangeTo; j++) {
      const area =
        Math.abs(
          (pointAX - avgX) * (points[j]!.y - pointAY) -
            (pointAX - points[j]!.x) * (avgY - pointAY),
        ) * 0.5;
      if (area > maxArea) {
        maxArea = area;
        maxAreaPointIndex = j;
      }
    }

    sampled.push(points[maxAreaPointIndex]!);
    a = maxAreaPointIndex;
  }

  sampled.push(points[points.length - 1]!);
  return sampled;
}

export function selectPointsForPlotLod(
  points: { x: number; y: number }[],
  xDomain: AxisDomain,
  plotWidth: number,
): { x: number; y: number }[] {
  if (points.length < 2 || plotWidth <= 0) return points;

  const clipped = clipPointsToXDomain(points, xDomain);
  if (clipped.length <= 2) return clipped;

  const targetPoints = Math.max(384, Math.round(plotWidth * 2));
  if (clipped.length <= targetPoints) return clipped;

  return downsampleLTTB(clipped, targetPoints);
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
  options?: {
    forceZero?: boolean;
    clampMin?: number;
    clampMax?: number;
  },
): number[] {
  return buildNiceDomain(min, max, targetCount, options).ticks;
}

export function buildNiceXTicks(
  min: number,
  max: number,
  targetCount: number,
): number[] {
  if (!Number.isFinite(min) || !Number.isFinite(max) || max <= min) return [min || 0];

  const range = max - min;
  const desired = Math.max(2, targetCount);
  const rough = range / desired;
  const pow10 = Math.pow(10, Math.floor(Math.log10(rough)));
  const norm = rough / pow10;
  let niceMult: number;

  if (norm < 1.4) niceMult = 1;
  else if (norm < 2.8) niceMult = 2;
  else if (norm < 4.2) niceMult = 2.5;
  else if (norm < 7.5) niceMult = 5;
  else niceMult = 10;

  const step = niceMult * pow10;
  const start = Math.ceil((min - 1e-6) / step) * step;
  const ticks: number[] = [];

  for (let val = start; val <= max + step * 1e-4; val += step) {
    ticks.push(Number(val.toFixed(8)));
  }

  if (ticks.length === 0) {
    ticks.push(Number(min.toFixed(8)));
  }

  return ticks;
}

export function computeCumulativeElevationAtX(
  points: { x: number; y: number }[],
  xTarget: number,
): { gainM: number; lossM: number } {
  if (points.length < 2) return { gainM: 0, lossM: 0 };
  let gain = 0;
  let loss = 0;

  for (let i = 1; i < points.length; i++) {
    const pPrev = points[i - 1];
    const pCurr = points[i];

    if (pCurr.x <= xTarget) {
      const dy = pCurr.y - pPrev.y;
      if (dy > 0) gain += dy;
      else if (dy < 0) loss += Math.abs(dy);
    } else if (pPrev.x < xTarget && pCurr.x > xTarget) {
      const span = pCurr.x - pPrev.x;
      const t = span > 0 ? (xTarget - pPrev.x) / span : 0;
      const yInterp = pPrev.y + t * (pCurr.y - pPrev.y);
      const dy = yInterp - pPrev.y;
      if (dy > 0) gain += dy;
      else if (dy < 0) loss += Math.abs(dy);
      break;
    } else if (pPrev.x >= xTarget) {
      break;
    }
  }

  return { gainM: Math.round(gain), lossM: Math.round(loss) };
}