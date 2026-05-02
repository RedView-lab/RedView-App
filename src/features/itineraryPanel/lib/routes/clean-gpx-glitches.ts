import type { Itinerary } from '../../types';

type RoutePoint = NonNullable<Itinerary['gpxRoute']>['points'][number];

const EARTH_RADIUS_M = 6_371_008.8;
const STATIONARY_RADIUS_M = 50;
const RETURN_TOLERANCE_M = 20;
const MIN_LOOP_PATH_M = 60;
const MIN_CLUSTER_POINTS = 4;
const IMPOSSIBLE_SLOPE_PCT = 50;
const SHORT_GLITCH_SEGMENT_M = 20;
const REASONABLE_SPAN_SLOPE_PCT = 20;

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

function segmentLengthM(points: RoutePoint[], startIndex: number, endIndex: number): number {
  let total = 0;
  for (let index = startIndex + 1; index <= endIndex; index++) {
    total += haversineM(points[index - 1], points[index]);
  }
  return total;
}

function rebuildCumulativeDistances(points: RoutePoint[]): RoutePoint[] {
  let cumulativeDistanceM = 0;
  return points.map((point, index) => {
    if (index > 0) {
      cumulativeDistanceM += haversineM(points[index - 1], point);
    }
    return {
      ...point,
      distanceM: cumulativeDistanceM,
    };
  });
}

function makeClusterRepresentative(
  points: RoutePoint[],
  startIndex: number,
  endIndex: number,
): RoutePoint {
  if (startIndex === 0) return { ...points[startIndex] };
  if (endIndex === points.length - 1) return { ...points[endIndex] };

  const cluster = points.slice(startIndex, endIndex + 1);
  const base = cluster[Math.floor(cluster.length / 2)] ?? points[startIndex];
  const avgLat = cluster.reduce((sum, point) => sum + point.lat, 0) / cluster.length;
  const avgLon = cluster.reduce((sum, point) => sum + point.lon, 0) / cluster.length;
  const elevationValues = cluster
    .map((point) => point.elevationM)
    .filter((value): value is number => value != null && Number.isFinite(value));
  const avgElevationM =
    elevationValues.length > 0
      ? elevationValues.reduce((sum, value) => sum + value, 0) / elevationValues.length
      : base.elevationM ?? null;

  return {
    ...base,
    lat: avgLat,
    lon: avgLon,
    elevationM: avgElevationM,
  };
}

function collapseStationarySpiderwebs(points: RoutePoint[]): RoutePoint[] {
  if (points.length < MIN_CLUSTER_POINTS) return points;

  const cleaned: RoutePoint[] = [];

  for (let index = 0; index < points.length; ) {
    let clusterEnd = index;
    while (
      clusterEnd + 1 < points.length &&
      haversineM(points[index], points[clusterEnd + 1]) <= STATIONARY_RADIUS_M
    ) {
      clusterEnd += 1;
    }

    const clusterPointCount = clusterEnd - index + 1;
    const clusterPathM = segmentLengthM(points, index, clusterEnd);
    const netDriftM = haversineM(points[index], points[clusterEnd]);
    const loopLike =
      clusterPointCount >= MIN_CLUSTER_POINTS &&
      clusterPathM >= MIN_LOOP_PATH_M &&
      (netDriftM <= RETURN_TOLERANCE_M || clusterPathM >= Math.max(60, netDriftM * 3));

    if (loopLike) {
      cleaned.push(makeClusterRepresentative(points, index, clusterEnd));
      index = clusterEnd + 1;
      continue;
    }

    cleaned.push({ ...points[index] });
    index += 1;
  }

  return cleaned.length >= 2 ? cleaned : points;
}

function smoothImpossibleAltitudeSpikes(points: RoutePoint[]): RoutePoint[] {
  if (points.length < 3) return points;

  const next = points.map((point) => ({ ...point }));

  for (let index = 1; index < next.length - 1; index++) {
    const prev = next[index - 1];
    const curr = next[index];
    const after = next[index + 1];
    if (
      prev.elevationM == null ||
      curr.elevationM == null ||
      after.elevationM == null ||
      !Number.isFinite(prev.elevationM) ||
      !Number.isFinite(curr.elevationM) ||
      !Number.isFinite(after.elevationM)
    ) {
      continue;
    }

    const prevDistM = Math.max(1, haversineM(prev, curr));
    const nextDistM = Math.max(1, haversineM(curr, after));
    const spanDistM = Math.max(1, haversineM(prev, after));
    const prevSlopePct = (Math.abs(curr.elevationM - prev.elevationM) / prevDistM) * 100;
    const nextSlopePct = (Math.abs(after.elevationM - curr.elevationM) / nextDistM) * 100;
    const spanSlopePct = (Math.abs(after.elevationM - prev.elevationM) / spanDistM) * 100;
    const looksImpossible =
      (prevDistM <= SHORT_GLITCH_SEGMENT_M || nextDistM <= SHORT_GLITCH_SEGMENT_M) &&
      (prevSlopePct >= IMPOSSIBLE_SLOPE_PCT || nextSlopePct >= IMPOSSIBLE_SLOPE_PCT) &&
      spanSlopePct <= REASONABLE_SPAN_SLOPE_PCT;
    if (!looksImpossible) continue;

    const ratio = prevDistM / (prevDistM + nextDistM);
    curr.elevationM = prev.elevationM + (after.elevationM - prev.elevationM) * ratio;
    curr.gradientPct = undefined;
  }

  return next;
}

export function cleanGpxGlitches(points: RoutePoint[]): RoutePoint[] {
  if (points.length < 3) return points;

  const withoutSpiderwebs = collapseStationarySpiderwebs(points);
  const smoothedElevations = smoothImpossibleAltitudeSpikes(withoutSpiderwebs);
  return rebuildCumulativeDistances(smoothedElevations);
}