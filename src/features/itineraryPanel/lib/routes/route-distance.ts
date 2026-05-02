const EARTH_R_M = 6_371_008.8;
const DEG = Math.PI / 180;

export interface RouteDistancePoint {
  lat: number;
  lon: number;
}

export interface ProjectedRoutePoint {
  distanceM: number;
  lat: number;
  lon: number;
}

export function haversineRouteDistanceM(
  a: RouteDistancePoint,
  b: RouteDistancePoint,
): number {
  const dLat = (b.lat - a.lat) * DEG;
  const dLon = (b.lon - a.lon) * DEG;
  const lat1 = a.lat * DEG;
  const lat2 = b.lat * DEG;
  const h =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(lat1) * Math.cos(lat2) * Math.sin(dLon / 2) ** 2;
  return 2 * EARTH_R_M * Math.asin(Math.sqrt(h));
}

export function cumulativeRouteLengthsM(points: RouteDistancePoint[]): number[] {
  if (points.length === 0) return [];

  const out = new Array<number>(points.length);
  out[0] = 0;
  for (let index = 1; index < points.length; index += 1) {
    out[index] = out[index - 1] + haversineRouteDistanceM(points[index - 1], points[index]);
  }
  return out;
}

export function projectDistanceAlongRouteM(
  point: RouteDistancePoint,
  routePoints: RouteDistancePoint[],
  cumulativeLengthsM: number[] = cumulativeRouteLengthsM(routePoints),
): number | null {
  const projected = projectPointAlongRoute(point, routePoints, cumulativeLengthsM);
  return projected?.distanceM ?? null;
}

export function projectPointAlongRoute(
  point: RouteDistancePoint,
  routePoints: RouteDistancePoint[],
  cumulativeLengthsM: number[] = cumulativeRouteLengthsM(routePoints),
): ProjectedRoutePoint | null {
  if (routePoints.length < 2 || cumulativeLengthsM.length !== routePoints.length) {
    return null;
  }

  let bestDistanceSq = Number.POSITIVE_INFINITY;
  let bestSegmentStart = 0;
  let bestT = 0;

  for (let index = 1; index < routePoints.length; index += 1) {
    const start = routePoints[index - 1];
    const end = routePoints[index];
    const midLat = (start.lat + end.lat) / 2;
    const cosLat = Math.cos(midLat * DEG);
    const ax = start.lon * cosLat;
    const ay = start.lat;
    const bx = end.lon * cosLat;
    const by = end.lat;
    const px = point.lon * cosLat;
    const py = point.lat;
    const dx = bx - ax;
    const dy = by - ay;
    const segmentLengthSq = dx * dx + dy * dy;
    let t = 0;
    if (segmentLengthSq > 0) {
      t = Math.max(0, Math.min(1, ((px - ax) * dx + (py - ay) * dy) / segmentLengthSq));
    }
    const projectedX = ax + t * dx;
    const projectedY = ay + t * dy;
    const distanceSq = ((px - projectedX) * (px - projectedX)) + ((py - projectedY) * (py - projectedY));
    if (distanceSq >= bestDistanceSq) continue;
    bestDistanceSq = distanceSq;
    bestSegmentStart = index - 1;
    bestT = t;
  }

  const segmentLengthM = cumulativeLengthsM[bestSegmentStart + 1] - cumulativeLengthsM[bestSegmentStart];
  const start = routePoints[bestSegmentStart];
  const end = routePoints[bestSegmentStart + 1];
  return {
    distanceM: cumulativeLengthsM[bestSegmentStart] + (bestT * segmentLengthM),
    lat: start.lat + ((end.lat - start.lat) * bestT),
    lon: start.lon + ((end.lon - start.lon) * bestT),
  };
}

export function roundDistanceKm(distanceM: number): number {
  return Math.round(distanceM / 100) / 10;
}