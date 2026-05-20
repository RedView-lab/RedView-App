import type { Itinerary } from '../../types';

type RoutePoint = NonNullable<Itinerary['gpxRoute']>['points'][number];

const EARTH_RADIUS_M = 6_371_008.8;

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

function douglasPeuckerIndices(points: RoutePoint[], toleranceM: number): number[] {
  if (points.length <= 2) return points.map((_, index) => index);

  const projected = projectRoutePoints(points);
  const keep = new Array<boolean>(points.length).fill(false);
  keep[0] = true;
  keep[points.length - 1] = true;

  const stack: Array<[number, number]> = [[0, points.length - 1]];
  const toleranceSq = toleranceM * toleranceM;

  while (stack.length > 0) {
    const [startIndex, endIndex] = stack.pop() as [number, number];
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

    if (splitIndex > startIndex && maxDistanceSq > toleranceSq) {
      keep[splitIndex] = true;
      stack.push([startIndex, splitIndex], [splitIndex, endIndex]);
    }
  }

  return keep.flatMap((value, index) => (value ? [index] : []));
}

function rebuildRoutePoints(points: RoutePoint[], indices: number[]): RoutePoint[] {
  let cumulativeDistanceM = 0;
  return indices.map((index, position) => {
    const point = points[index];
    if (position > 0) {
      cumulativeDistanceM += haversineM(points[indices[position - 1]], point);
    }
    return {
      ...point,
      distanceM: cumulativeDistanceM,
    };
  });
}

export function simplifyRouteToMaxPoints(
  points: RoutePoint[],
  maxPoints: number,
): RoutePoint[] {
  if (points.length <= 2) return points;

  const clampedMaxPoints = Math.max(2, Math.min(maxPoints, points.length));
  if (clampedMaxPoints >= points.length) return points;

  let lowToleranceM = 0;
  let highToleranceM = 1;
  let bestIndices = douglasPeuckerIndices(points, highToleranceM);

  while (bestIndices.length > clampedMaxPoints) {
    highToleranceM *= 2;
    bestIndices = douglasPeuckerIndices(points, highToleranceM);
  }

  for (let iteration = 0; iteration < 24; iteration++) {
    const midToleranceM = (lowToleranceM + highToleranceM) / 2;
    const nextIndices = douglasPeuckerIndices(points, midToleranceM);
    if (nextIndices.length > clampedMaxPoints) {
      lowToleranceM = midToleranceM;
    } else {
      highToleranceM = midToleranceM;
      bestIndices = nextIndices;
    }
  }

  return rebuildRoutePoints(points, bestIndices);
}

export function simplifyPointsByQuality(
  points: RoutePoint[],
  quality: 'default' | 'balanced' | 'max',
): RoutePoint[] {
  let targetPointsPerKm = 10;
  if (quality === 'balanced') {
    targetPointsPerKm = 50;
  } else if (quality === 'max') {
    targetPointsPerKm = 100;
  }

  let distanceM = 0;
  for (let i = 1; i < points.length; i++) {
    distanceM += haversineM(points[i - 1], points[i]);
  }
  const routeDistanceKm = distanceM / 1000;

  const nextMaxPoints = Math.max(
    2,
    Math.round(Math.max(routeDistanceKm, 0.25) * targetPointsPerKm),
  );
  if (points.length <= nextMaxPoints) return points;

  return simplifyRouteToMaxPoints(points, nextMaxPoints);
}