import type { GpxQualityMode, GpxQualityPreset, Itinerary } from '../../types';

type RoutePoint = NonNullable<Itinerary['gpxRoute']>['points'][number];

const GPX_QUALITY_PRESET_POINTS_PER_KM: Record<GpxQualityPreset, number> = {
  default: 12,
  balanced: 28,
  max: 60,
};

const GPX_QUALITY_EXPERT_MIN_POINTS_PER_KM = 5;
const GPX_QUALITY_EXPERT_MAX_POINTS_PER_KM = 160;

const EARTH_RADIUS_M = 6_371_008.8;
const MIN_SEGMENT_LENGTH_FOR_TURN_ANCHOR_M = 6;
const MIN_TURN_ANCHOR_DEGREES = 18;
const MIN_ELEVATION_ANCHOR_RELIEF_M = 4;
const qualityRouteCache = new WeakMap<RoutePoint[], Map<string, RoutePoint[]>>();

function toRad(degrees: number): number {
  return (degrees * Math.PI) / 180;
}

function haversineM(
  a: { lat: number; lon: number },
  b: { lat: number; lon: number },
): number {
  const dLat = toRad(b.lat - a.lat);
  const dLon = toRad(b.lon - a.lon);
  const lat1 = toRad(a.lat);
  const lat2 = toRad(b.lat);
  const h =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(lat1) * Math.cos(lat2) * Math.sin(dLon / 2) ** 2;
  return 2 * EARTH_RADIUS_M * Math.asin(Math.sqrt(h));
}

function pointToSegmentDistanceSq(
  point: { x: number; y: number },
  start: { x: number; y: number },
  end: { x: number; y: number },
): number {
  const dx = end.x - start.x;
  const dy = end.y - start.y;

  if (dx === 0 && dy === 0) {
    const px = point.x - start.x;
    const py = point.y - start.y;
    return px * px + py * py;
  }

  const t = Math.max(
    0,
    Math.min(
      1,
      ((point.x - start.x) * dx + (point.y - start.y) * dy) /
        (dx * dx + dy * dy),
    ),
  );
  const projX = start.x + dx * t;
  const projY = start.y + dy * t;
  const distX = point.x - projX;
  const distY = point.y - projY;
  return distX * distX + distY * distY;
}

function projectRoutePoints(points: RoutePoint[]): Array<{ x: number; y: number }> {
  const avgLat =
    points.reduce((sum, point) => sum + point.lat, 0) / Math.max(points.length, 1);
  const latScale = toRad(1) * EARTH_RADIUS_M;
  const lonScale = Math.cos(toRad(avgLat)) * latScale;

  return points.map((point) => ({
    x: point.lon * lonScale,
    y: point.lat * latScale,
  }));
}

function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value));
}

function computeRouteDistanceM(points: RoutePoint[]): number {
  if (points.length <= 1) return 0;
  const lastDistance = points[points.length - 1]?.distanceM;
  if (typeof lastDistance === 'number' && Number.isFinite(lastDistance) && lastDistance > 0) {
    return lastDistance;
  }

  let distanceM = 0;
  for (let index = 1; index < points.length; index++) {
    distanceM += haversineM(points[index - 1]!, points[index]!);
  }
  return distanceM;
}

function scoreRouteAnchors(points: RoutePoint[]): Array<{ index: number; score: number }> {
  if (points.length <= 2) return [];

  const projected = projectRoutePoints(points);
  const anchors: Array<{ index: number; score: number }> = [];

  for (let index = 1; index < points.length - 1; index++) {
    const prev = projected[index - 1]!;
    const current = projected[index]!;
    const next = projected[index + 1]!;

    const ax = current.x - prev.x;
    const ay = current.y - prev.y;
    const bx = next.x - current.x;
    const by = next.y - current.y;
    const lenA = Math.hypot(ax, ay);
    const lenB = Math.hypot(bx, by);

    let score = 0;

    if (lenA >= MIN_SEGMENT_LENGTH_FOR_TURN_ANCHOR_M && lenB >= MIN_SEGMENT_LENGTH_FOR_TURN_ANCHOR_M) {
      const cosine = clamp((ax * bx + ay * by) / (lenA * lenB), -1, 1);
      const turnDegrees = (Math.acos(cosine) * 180) / Math.PI;
      if (turnDegrees >= MIN_TURN_ANCHOR_DEGREES) {
        score += turnDegrees * Math.min(lenA, lenB);
      }
    }

    const prevElevation = points[index - 1]?.elevationM;
    const currentElevation = points[index]?.elevationM;
    const nextElevation = points[index + 1]?.elevationM;
    if (
      typeof prevElevation === 'number'
      && typeof currentElevation === 'number'
      && typeof nextElevation === 'number'
    ) {
      const isExtremum =
        (currentElevation >= prevElevation && currentElevation >= nextElevation)
        || (currentElevation <= prevElevation && currentElevation <= nextElevation);
      if (isExtremum) {
        const relief = Math.min(
          Math.abs(currentElevation - prevElevation),
          Math.abs(currentElevation - nextElevation),
        );
        if (relief >= MIN_ELEVATION_ANCHOR_RELIEF_M) {
          score += relief * 18;
        }
      }
    }

    if (score > 0) {
      anchors.push({ index, score });
    }
  }

  return anchors;
}

function selectAnchorIndices(points: RoutePoint[], maxPoints: number): number[] {
  const internalAnchorBudget = Math.max(
    0,
    Math.min(maxPoints - 2, Math.round(maxPoints * 0.18)),
  );
  if (internalAnchorBudget <= 0) return [];

  const scoredAnchors = scoreRouteAnchors(points).sort((left, right) => right.score - left.score);
  if (scoredAnchors.length === 0) return [];

  const selected: number[] = [];
  const minGap = points.length > 4_000 ? 6 : 3;
  for (const candidate of scoredAnchors) {
    if (selected.length >= internalAnchorBudget) break;
    if (selected.some((index) => Math.abs(index - candidate.index) < minGap)) continue;
    selected.push(candidate.index);
  }

  return selected.sort((left, right) => left - right);
}

/**
 * Arbre de découpe Douglas–Peucker de `points`, construit une fois pour toutes
 * les tolérances : le point où se coupe une sous-plage (son point le plus
 * éloigné) ne dépend jamais de la tolérance, seulement le fait que la récursion
 * continue. À la tolérance τ, un point est gardé quand sa propre déviation et
 * celles de chaque découpe au-dessus de lui dépassent τ : `retainSq[i]` contient
 * donc le plus petit de ces carrés de déviation (0 : jamais une découpe, +∞ :
 * les extrémités). La recherche de tolérance ci-dessous relançait toute la
 * récursion ~30 fois par segment (0,55 s pour un tracé de 100 000 points).
 */
function douglasPeuckerRetention(points: RoutePoint[]): Float64Array {
  const retainSq = new Float64Array(points.length);
  retainSq[0] = Infinity;
  retainSq[points.length - 1] = Infinity;
  if (points.length <= 2) return retainSq;

  const projected = projectRoutePoints(points);
  const stack: Array<[number, number, number]> = [[0, points.length - 1, Infinity]];

  while (stack.length > 0) {
    const [startIndex, endIndex, boundSq] = stack.pop() as [number, number, number];
    let maxDistanceSq = -1;
    let splitIndex = -1;

    for (let index = startIndex + 1; index < endIndex; index++) {
      const distanceSq = pointToSegmentDistanceSq(
        projected[index],
        projected[startIndex],
        projected[endIndex],
      );
      if (distanceSq > maxDistanceSq) {
        maxDistanceSq = distanceSq;
        splitIndex = index;
      }
    }

    if (splitIndex > startIndex) {
      const splitRetainSq = Math.min(maxDistanceSq, boundSq);
      retainSq[splitIndex] = splitRetainSq;
      stack.push([startIndex, splitIndex, splitRetainSq], [splitIndex, endIndex, splitRetainSq]);
    }
  }

  return retainSq;
}

/** Indices que Douglas–Peucker garde à `toleranceM`, d'après l'arbre de découpe. */
function douglasPeuckerIndices(retainSq: Float64Array, toleranceM: number): number[] {
  const toleranceSq = toleranceM * toleranceM;
  const last = retainSq.length - 1;
  const indices: number[] = [];
  for (let index = 0; index <= last; index++) {
    if (index === 0 || index === last || retainSq[index] > toleranceSq) indices.push(index);
  }
  return indices;
}

function simplifyIndicesToMaxPoints(points: RoutePoint[], maxPoints: number): number[] {
  if (points.length <= 2) return points.map((_, index) => index);

  const clampedMaxPoints = Math.max(2, Math.min(maxPoints, points.length));
  if (clampedMaxPoints >= points.length) {
    return points.map((_, index) => index);
  }

  const retainSq = douglasPeuckerRetention(points);
  let lowToleranceM = 0;
  let highToleranceM = 1;
  let bestIndices = douglasPeuckerIndices(retainSq, highToleranceM);

  while (bestIndices.length > clampedMaxPoints) {
    highToleranceM *= 2;
    bestIndices = douglasPeuckerIndices(retainSq, highToleranceM);
  }

  for (let iteration = 0; iteration < 24; iteration++) {
    const midToleranceM = (lowToleranceM + highToleranceM) / 2;
    const nextIndices = douglasPeuckerIndices(retainSq, midToleranceM);
    if (nextIndices.length > clampedMaxPoints) {
      lowToleranceM = midToleranceM;
    } else {
      highToleranceM = midToleranceM;
      bestIndices = nextIndices;
    }
  }

  return bestIndices;
}

function simplifyRouteWithAnchors(points: RoutePoint[], maxPoints: number): RoutePoint[] {
  const clampedMaxPoints = Math.max(2, Math.min(maxPoints, points.length));
  if (clampedMaxPoints >= points.length) return points;

  const anchors = selectAnchorIndices(points, clampedMaxPoints);
  const boundaries = [0, ...anchors, points.length - 1];
  const remainingInteriorBudget = Math.max(0, clampedMaxPoints - boundaries.length);
  const segments = boundaries.slice(0, -1).map((startIndex, index) => {
    const endIndex = boundaries[index + 1]!;
    const interiorCount = Math.max(0, endIndex - startIndex - 1);
    return {
      startIndex,
      endIndex,
      interiorCount,
      weight: Math.max(1, interiorCount),
    };
  });

  const totalWeight = segments.reduce((sum, segment) => sum + segment.weight, 0);
  const allocations = segments.map((segment) => {
    if (remainingInteriorBudget <= 0 || segment.interiorCount <= 0 || totalWeight <= 0) {
      return { count: 0, remainder: 0 };
    }
    const ideal = (remainingInteriorBudget * segment.weight) / totalWeight;
    const count = Math.min(segment.interiorCount, Math.floor(ideal));
    return { count, remainder: ideal - count };
  });

  let assignedInteriorBudget = allocations.reduce((sum, allocation) => sum + allocation.count, 0);
  while (assignedInteriorBudget < remainingInteriorBudget) {
    let nextIndex = -1;
    let bestRemainder = -1;
    for (let index = 0; index < segments.length; index++) {
      const segment = segments[index]!;
      const allocation = allocations[index]!;
      if (allocation.count >= segment.interiorCount) continue;
      if (allocation.remainder > bestRemainder) {
        bestRemainder = allocation.remainder;
        nextIndex = index;
      }
    }
    if (nextIndex < 0) break;
    allocations[nextIndex]!.count += 1;
    allocations[nextIndex]!.remainder = 0;
    assignedInteriorBudget += 1;
  }

  const mergedIndices: number[] = [];
  segments.forEach((segment, index) => {
    const segmentPoints = points.slice(segment.startIndex, segment.endIndex + 1);
    const maxSegmentPoints = Math.min(
      segmentPoints.length,
      2 + allocations[index]!.count,
    );
    const localIndices = simplifyIndicesToMaxPoints(segmentPoints, maxSegmentPoints);
    for (const localIndex of localIndices) {
      const globalIndex = segment.startIndex + localIndex;
      if (mergedIndices[mergedIndices.length - 1] !== globalIndex) {
        mergedIndices.push(globalIndex);
      }
    }
  });

  return rebuildRoutePoints(points, mergedIndices);
}

function createQualityCacheKey(quality: GpxQualityMode, pointsPerKm: number, targetPointCount: number): string {
  return `${quality}:${pointsPerKm}:${targetPointCount}`;
}

function resolveGpxQualityPointsPerKm(
  quality: GpxQualityMode,
  customPointsPerKm?: number | null,
): number {
  if (quality !== 'expert') {
    return GPX_QUALITY_PRESET_POINTS_PER_KM[quality];
  }
  const fallback = GPX_QUALITY_PRESET_POINTS_PER_KM.balanced;
  const safeValue = typeof customPointsPerKm === 'number' && Number.isFinite(customPointsPerKm)
    ? customPointsPerKm
    : fallback;
  return clamp(
    Math.round(safeValue),
    GPX_QUALITY_EXPERT_MIN_POINTS_PER_KM,
    GPX_QUALITY_EXPERT_MAX_POINTS_PER_KM,
  );
}

export function computeGpxQualityTargetPointCount(
  points: RoutePoint[],
  quality: GpxQualityMode,
  customPointsPerKm?: number | null,
): number {
  const routeDistanceKm = computeRouteDistanceM(points) / 1000;
  const pointsPerKm = resolveGpxQualityPointsPerKm(quality, customPointsPerKm);
  return Math.max(
    2,
    Math.min(
      points.length,
      Math.round(Math.max(routeDistanceKm, 0.25) * pointsPerKm),
    ),
  );
}

export function applyGpxQuality(
  points: RoutePoint[],
  quality: GpxQualityMode,
  customPointsPerKm?: number | null,
): {
  points: RoutePoint[];
  targetPointCount: number;
  pointsPerKm: number;
} {
  const pointsPerKm = resolveGpxQualityPointsPerKm(quality, customPointsPerKm);
  const targetPointCount = computeGpxQualityTargetPointCount(points, quality, pointsPerKm);
  if (points.length <= targetPointCount) {
    return { points, targetPointCount, pointsPerKm };
  }

  const cacheKey = createQualityCacheKey(quality, pointsPerKm, targetPointCount);
  const routeCache = qualityRouteCache.get(points);
  const cached = routeCache?.get(cacheKey);
  if (cached) {
    return { points: cached, targetPointCount, pointsPerKm };
  }

  const simplifiedPoints = simplifyRouteWithAnchors(points, targetPointCount);
  if (!routeCache) {
    qualityRouteCache.set(points, new Map([[cacheKey, simplifiedPoints]]));
  } else {
    routeCache.set(cacheKey, simplifiedPoints);
  }

  return { points: simplifiedPoints, targetPointCount, pointsPerKm };
}

function rebuildRoutePoints(points: RoutePoint[], indices: number[]): RoutePoint[] {
  let cumulativeDistanceM = 0;
  const lastIndex = points.length - 1;
  const totalOriginalDistanceM = points[lastIndex]?.distanceM;

  return indices.map((index, position) => {
    const point = points[index];
    if (position > 0) {
      if (
        typeof point.distanceM === 'number' &&
        Number.isFinite(point.distanceM) &&
        point.distanceM >= cumulativeDistanceM
      ) {
        cumulativeDistanceM = point.distanceM;
      } else {
        cumulativeDistanceM += haversineM(points[indices[position - 1]], point);
      }
    }

    if (
      index === lastIndex &&
      typeof totalOriginalDistanceM === 'number' &&
      Number.isFinite(totalOriginalDistanceM) &&
      totalOriginalDistanceM > 0
    ) {
      cumulativeDistanceM = totalOriginalDistanceM;
    }

    return {
      ...point,
      distanceM: cumulativeDistanceM,
    };
  });
}

export function simplifyPointsByQuality(
  points: RoutePoint[],
  quality: GpxQualityMode,
  customPointsPerKm?: number | null,
): RoutePoint[] {
  return applyGpxQuality(points, quality, customPointsPerKm).points;
}