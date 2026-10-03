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

/** Segments per bounding-box chunk of the projection index. */
const PROJECTION_CHUNK_SIZE = 32;

/**
 * Per-route acceleration structure for {@link projectPointAlongRoute}:
 * per-segment cos(midLat) and per-chunk lon/lat bounding boxes. Lets the
 * nearest-segment search skip whole chunks with an exact lower bound, so a
 * 50k-point route costs ~N/32 box tests + a few chunks instead of N cos() calls.
 */
interface RouteProjectionIndex {
  segmentCos: Float64Array;
  chunkMinLon: Float64Array;
  chunkMaxLon: Float64Array;
  chunkMinLat: Float64Array;
  chunkMaxLat: Float64Array;
  chunkMinCos: Float64Array;
}

const projectionIndexCache = new WeakMap<RouteDistancePoint[], RouteProjectionIndex>();

function getRouteProjectionIndex(routePoints: RouteDistancePoint[]): RouteProjectionIndex {
  const cached = projectionIndexCache.get(routePoints);
  if (cached && cached.segmentCos.length === routePoints.length - 1) return cached;

  const segmentCount = routePoints.length - 1;
  const chunkCount = Math.ceil(segmentCount / PROJECTION_CHUNK_SIZE);
  const index: RouteProjectionIndex = {
    segmentCos: new Float64Array(segmentCount),
    chunkMinLon: new Float64Array(chunkCount).fill(Infinity),
    chunkMaxLon: new Float64Array(chunkCount).fill(-Infinity),
    chunkMinLat: new Float64Array(chunkCount).fill(Infinity),
    chunkMaxLat: new Float64Array(chunkCount).fill(-Infinity),
    chunkMinCos: new Float64Array(chunkCount).fill(Infinity),
  };

  for (let segment = 0; segment < segmentCount; segment += 1) {
    const start = routePoints[segment];
    const end = routePoints[segment + 1];
    const cosLat = Math.cos(((start.lat + end.lat) / 2) * DEG);
    index.segmentCos[segment] = cosLat;
    const chunk = (segment / PROJECTION_CHUNK_SIZE) | 0;
    const minLon = Math.min(start.lon, end.lon);
    const maxLon = Math.max(start.lon, end.lon);
    const minLat = Math.min(start.lat, end.lat);
    const maxLat = Math.max(start.lat, end.lat);
    if (minLon < index.chunkMinLon[chunk]) index.chunkMinLon[chunk] = minLon;
    if (maxLon > index.chunkMaxLon[chunk]) index.chunkMaxLon[chunk] = maxLon;
    if (minLat < index.chunkMinLat[chunk]) index.chunkMinLat[chunk] = minLat;
    if (maxLat > index.chunkMaxLat[chunk]) index.chunkMaxLat[chunk] = maxLat;
    if (cosLat < index.chunkMinCos[chunk]) index.chunkMinCos[chunk] = cosLat;
  }

  projectionIndexCache.set(routePoints, index);
  return index;
}

export function projectPointAlongRoute(
  point: RouteDistancePoint,
  routePoints: RouteDistancePoint[],
  cumulativeLengthsM: number[] = cumulativeRouteLengthsM(routePoints),
): ProjectedRoutePoint | null {
  if (routePoints.length < 2 || cumulativeLengthsM.length !== routePoints.length) {
    return null;
  }

  const index = getRouteProjectionIndex(routePoints);
  const chunkCount = index.chunkMinLon.length;
  const segmentCount = routePoints.length - 1;

  // Lower bound of the (segment-metric) squared distance from the query to any
  // segment in a chunk: distance to the chunk's lon/lat box, lon scaled by the
  // smallest cos in the chunk (segment metric scales lon by cos >= that).
  const chunkBoundSq = new Float64Array(chunkCount);
  let firstChunk = 0;
  for (let chunk = 0; chunk < chunkCount; chunk += 1) {
    const dLon = Math.max(index.chunkMinLon[chunk] - point.lon, 0, point.lon - index.chunkMaxLon[chunk]);
    const dLat = Math.max(index.chunkMinLat[chunk] - point.lat, 0, point.lat - index.chunkMaxLat[chunk]);
    const scaledLon = dLon * Math.max(0, index.chunkMinCos[chunk]);
    const bound = scaledLon * scaledLon + dLat * dLat;
    chunkBoundSq[chunk] = bound;
    if (bound < chunkBoundSq[firstChunk]) firstChunk = chunk;
  }

  let bestDistanceSq = Number.POSITIVE_INFINITY;
  let bestSegmentStart = 0;
  let bestT = 0;

  const scanChunk = (chunk: number) => {
    const from = chunk * PROJECTION_CHUNK_SIZE;
    const to = Math.min(segmentCount, from + PROJECTION_CHUNK_SIZE);
    for (let segment = from; segment < to; segment += 1) {
      const start = routePoints[segment];
      const end = routePoints[segment + 1];
      const cosLat = index.segmentCos[segment];
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
      if (distanceSq > bestDistanceSq) continue;
      // Ties keep the earliest segment, as a plain in-order scan would.
      if (distanceSq === bestDistanceSq && segment >= bestSegmentStart) continue;
      bestDistanceSq = distanceSq;
      bestSegmentStart = segment;
      bestT = t;
    }
  };

  // Seed with the closest chunk to get a tight bound, then prune the rest.
  scanChunk(firstChunk);
  for (let chunk = 0; chunk < chunkCount; chunk += 1) {
    if (chunk === firstChunk || chunkBoundSq[chunk] > bestDistanceSq) continue;
    scanChunk(chunk);
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

const METERS_PER_DEG_LAT = EARTH_R_M * DEG;
/**
 * Marge au-delà du passage le plus proche dans laquelle un passage plus tôt
 * est préféré : une étape routée est sur la trace (au calage BRouter près),
 * mais une boucle ou un aller-retour repasse à quelques mètres d'elle.
 */
const VIA_POINT_PASSAGE_TOLERANCE_M = 30;

/**
 * Projection d'un point de passage (étape routée dans l'ordre) : le premier
 * passage de la trace près du point, au-delà de `minDistanceM` (l'étape
 * précédente). Le plus proche ne suffit pas quand la trace repasse au même
 * endroit : l'étape prenait le kilomètre du second passage.
 */
export function projectViaPointAlongRoute(
  point: RouteDistancePoint,
  routePoints: RouteDistancePoint[],
  cumulativeLengthsM: number[] = cumulativeRouteLengthsM(routePoints),
  minDistanceM = 0,
): ProjectedRoutePoint | null {
  if (routePoints.length < 2 || cumulativeLengthsM.length !== routePoints.length) {
    return null;
  }

  const index = getRouteProjectionIndex(routePoints);
  const chunkCount = index.chunkMinLon.length;
  const segmentCount = routePoints.length - 1;
  const minM = Math.max(0, Math.min(cumulativeLengthsM[segmentCount], minDistanceM));

  // Premier segment qui atteint minM, et t minimal sur ce segment.
  let firstSegment = 0;
  while (firstSegment < segmentCount - 1 && cumulativeLengthsM[firstSegment + 1] < minM) firstSegment += 1;
  const firstSegmentLengthM = cumulativeLengthsM[firstSegment + 1] - cumulativeLengthsM[firstSegment];
  const firstMinT = firstSegmentLengthM > 0
    ? Math.max(0, Math.min(1, (minM - cumulativeLengthsM[firstSegment]) / firstSegmentLengthM))
    : 0;
  const firstChunk = (firstSegment / PROJECTION_CHUNK_SIZE) | 0;

  const chunkBoundSq = new Float64Array(chunkCount);
  for (let chunk = firstChunk; chunk < chunkCount; chunk += 1) {
    const dLon = Math.max(index.chunkMinLon[chunk] - point.lon, 0, point.lon - index.chunkMaxLon[chunk]);
    const dLat = Math.max(index.chunkMinLat[chunk] - point.lat, 0, point.lat - index.chunkMaxLat[chunk]);
    const scaledLon = dLon * Math.max(0, index.chunkMinCos[chunk]);
    chunkBoundSq[chunk] = scaledLon * scaledLon + dLat * dLat;
  }

  // Distance² (métrique du segment) du point à `segment` ; t dans `projectedT`.
  let projectedT = 0;
  const distanceSqTo = (segment: number): number => {
    const start = routePoints[segment];
    const end = routePoints[segment + 1];
    const cosLat = index.segmentCos[segment];
    const ax = start.lon * cosLat;
    const ay = start.lat;
    const dx = end.lon * cosLat - ax;
    const dy = end.lat - ay;
    const px = point.lon * cosLat;
    const py = point.lat;
    const minT = segment === firstSegment ? firstMinT : 0;
    const segmentLengthSq = dx * dx + dy * dy;
    projectedT = segmentLengthSq > 0
      ? Math.max(minT, Math.min(1, ((px - ax) * dx + (py - ay) * dy) / segmentLengthSq))
      : minT;
    const ex = px - (ax + projectedT * dx);
    const ey = py - (ay + projectedT * dy);
    return ex * ex + ey * ey;
  };
  const segmentsOf = (chunk: number): [number, number] => [
    Math.max(firstSegment, chunk * PROJECTION_CHUNK_SIZE),
    Math.min(segmentCount, (chunk + 1) * PROJECTION_CHUNK_SIZE),
  ];

  // 1. Passage le plus proche au-delà de minM.
  let bestDistanceSq = Number.POSITIVE_INFINITY;
  for (let chunk = firstChunk; chunk < chunkCount; chunk += 1) {
    if (chunkBoundSq[chunk] > bestDistanceSq) continue;
    const [from, to] = segmentsOf(chunk);
    for (let segment = from; segment < to; segment += 1) {
      bestDistanceSq = Math.min(bestDistanceSq, distanceSqTo(segment));
    }
  }
  if (!Number.isFinite(bestDistanceSq)) return null;

  // 2. Premier passage à moins de (plus proche + tolérance), puis son point
  //    le plus proche en avançant tant que la distance décroît.
  const thresholdDeg = Math.sqrt(bestDistanceSq) + VIA_POINT_PASSAGE_TOLERANCE_M / METERS_PER_DEG_LAT;
  const thresholdSq = thresholdDeg * thresholdDeg;
  for (let chunk = firstChunk; chunk < chunkCount; chunk += 1) {
    if (chunkBoundSq[chunk] > thresholdSq) continue;
    const [from, to] = segmentsOf(chunk);
    for (let segment = from; segment < to; segment += 1) {
      let distanceSq = distanceSqTo(segment);
      if (distanceSq > thresholdSq) continue;
      let bestSegment = segment;
      let bestT = projectedT;
      for (let next = segment + 1; next < segmentCount; next += 1) {
        const nextDistanceSq = distanceSqTo(next);
        if (nextDistanceSq > distanceSq) break;
        distanceSq = nextDistanceSq;
        bestSegment = next;
        bestT = projectedT;
      }
      const segmentLengthM = cumulativeLengthsM[bestSegment + 1] - cumulativeLengthsM[bestSegment];
      const start = routePoints[bestSegment];
      const end = routePoints[bestSegment + 1];
      return {
        distanceM: cumulativeLengthsM[bestSegment] + (bestT * segmentLengthM),
        lat: start.lat + ((end.lat - start.lat) * bestT),
        lon: start.lon + ((end.lon - start.lon) * bestT),
      };
    }
  }
  return null;
}

export function roundDistanceKm(distanceM: number): number {
  return Math.round(distanceM / 100) / 10;
}