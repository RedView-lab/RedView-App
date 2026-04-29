import type { Dispatch, SetStateAction } from 'react';
import type { Map as MapboxMap } from 'mapbox-gl';

import { routeLengthM } from '@/features/poi/lib/gpx-loader';

import {
  cumulativeRouteLengthsM,
  haversineRouteDistanceM,
  projectPointAlongRoute,
  roundDistanceKm,
} from '../lib/route-distance';
import {
  computeRouteSurfaceMetricsFromBrouter,
  extractRouteProfileFromPoints,
} from '../lib/route-metrics';
import type { Itinerary, ItineraryProject, ItineraryRouteAuditFinding } from '../types';

type RoutePoints = NonNullable<Itinerary['gpxRoute']>['points'];
type RoutePoint = RoutePoints[number];
type ProfilePoint = {
  lat: number;
  lon: number;
  distanceM: number;
  elevationM: number;
  gradientPct: number;
};

export interface UseItineraryBrouterRoutingArgs {
  active: ItineraryProject['itineraries'][number] | null;
  isMapLoaded: boolean;
  map: MapboxMap | null;
  rollbackPendingTraceAppend: (itineraryId: string) => boolean;
  setProject: Dispatch<SetStateAction<ItineraryProject>>;
}

export function toStoredRoutePoints(profile: ProfilePoint[]): RoutePoints {
  return profile.map((point) => ({
    lat: point.lat,
    lon: point.lon,
    distanceM: point.distanceM,
    elevationM: point.elevationM,
    gradientPct: point.gradientPct,
  }));
}

export function toGeometryRoutePoints(coordinates: [number, number][]): RoutePoints {
  return coordinates.map((coordinate) => ({
    lat: coordinate[1],
    lon: coordinate[0],
    elevationM: Number.isFinite((coordinate as [number, number, number?])[2])
      ? ((coordinate as [number, number, number?])[2] as number)
      : null,
  }));
}

export function buildStoredRoutePointsFromBrouter(
  geometryPoints: RoutePoints,
  messageProfile: ProfilePoint[] | null,
  targetDistanceM: number,
): RoutePoints {
  const geometryProfile = extractRouteProfileFromPoints(geometryPoints);
  const denseGeometryPoints = geometryProfile
    ? scaleRouteProfileDistances(toStoredRoutePoints(geometryProfile), targetDistanceM)
    : null;

  if (denseGeometryPoints) {
    return denseGeometryPoints;
  }

  return messageProfile
    ? enrichGeometryRoutePoints(geometryPoints, messageProfile)
    : geometryPoints;
}

function scaleRouteProfileDistances(points: RoutePoints, targetDistanceM: number): RoutePoints {
  if (points.length === 0 || !(targetDistanceM > 0)) return points;

  const totalDistanceM = points[points.length - 1]?.distanceM;
  if (!Number.isFinite(totalDistanceM) || (totalDistanceM as number) <= 0) {
    return points;
  }

  const scale = targetDistanceM / (totalDistanceM as number);
  if (!Number.isFinite(scale) || Math.abs(scale - 1) < 1e-6) return points;

  return points.map((point) => ({
    ...point,
    distanceM: Number.isFinite(point.distanceM) ? (point.distanceM as number) * scale : point.distanceM,
  }));
}

function enrichGeometryRoutePoints(
  geometryPoints: RoutePoints,
  profile: ProfilePoint[],
): RoutePoints {
  if (geometryPoints.length === 0 || profile.length < 2) return geometryPoints;

  const geometryDistancesM = new Array<number>(geometryPoints.length).fill(0);
  for (let index = 1; index < geometryPoints.length; index++) {
    geometryDistancesM[index] =
      geometryDistancesM[index - 1] + haversineMeters(geometryPoints[index - 1], geometryPoints[index]);
  }

  const geometryTotalDistanceM = geometryDistancesM[geometryDistancesM.length - 1] ?? 0;
  const profileTotalDistanceM = profile[profile.length - 1]?.distanceM ?? 0;
  const distanceScale =
    geometryTotalDistanceM > 0 && profileTotalDistanceM > 0
      ? profileTotalDistanceM / geometryTotalDistanceM
      : 1;

  return geometryPoints.map((point, index) => {
    const distanceM = geometryDistancesM[index] * distanceScale;
    const sample = interpolateProfileSample(profile, distanceM);
    return {
      lat: point.lat,
      lon: point.lon,
      distanceM,
      elevationM: sample.elevationM,
      gradientPct: sample.gradientPct,
    };
  });
}

function interpolateProfileSample(
  profile: Array<Pick<ProfilePoint, 'distanceM' | 'elevationM' | 'gradientPct'>>,
  distanceM: number,
): { elevationM: number; gradientPct: number } {
  if (distanceM <= profile[0].distanceM) {
    return {
      elevationM: profile[0].elevationM,
      gradientPct: profile[0].gradientPct,
    };
  }

  const last = profile[profile.length - 1];
  if (distanceM >= last.distanceM) {
    return {
      elevationM: last.elevationM,
      gradientPct: last.gradientPct,
    };
  }

  let low = 0;
  let high = profile.length - 1;
  while (low + 1 < high) {
    const mid = Math.floor((low + high) / 2);
    if (profile[mid].distanceM <= distanceM) low = mid;
    else high = mid;
  }

  const start = profile[low];
  const end = profile[high];
  const spanM = end.distanceM - start.distanceM;
  if (spanM <= 0) {
    return {
      elevationM: start.elevationM,
      gradientPct: start.gradientPct,
    };
  }

  const t = (distanceM - start.distanceM) / spanM;
  return {
    elevationM: start.elevationM + (end.elevationM - start.elevationM) * t,
    gradientPct: start.gradientPct + (end.gradientPct - start.gradientPct) * t,
  };
}

function haversineMeters(a: { lat: number; lon: number }, b: { lat: number; lon: number }): number {
  const toRad = (degrees: number) => (degrees * Math.PI) / 180;
  const deltaLat = toRad(b.lat - a.lat);
  const deltaLon = toRad(b.lon - a.lon);
  const latA = toRad(a.lat);
  const latB = toRad(b.lat);
  const h =
    Math.sin(deltaLat / 2) ** 2 +
    Math.cos(latA) * Math.cos(latB) * Math.sin(deltaLon / 2) ** 2;
  return 2 * 6_371_008.8 * Math.asin(Math.sqrt(h));
}

export function routePointsEqual(
  left: RoutePoints | null | undefined,
  right: RoutePoints | null | undefined,
): boolean {
  return routePointsSignature(left) === routePointsSignature(right);
}

function routePointsSignature(points: RoutePoints | null | undefined): string {
  if (!points || points.length === 0) return 'empty';
  const indices = Array.from(new Set([0, Math.floor((points.length - 1) / 2), points.length - 1]));
  return [
    String(points.length),
    ...indices.map((index) => {
      const point = points[index];
      return [
        index,
        point.lat.toFixed(6),
        point.lon.toFixed(6),
        Number.isFinite(point.distanceM) ? (point.distanceM as number).toFixed(1) : 'null',
        Number.isFinite(point.elevationM)
          ? (point.elevationM as number).toFixed(2)
          : 'null',
        Number.isFinite(point.gradientPct)
          ? (point.gradientPct as number).toFixed(3)
          : 'null',
      ].join(':');
    }),
  ].join('|');
}

function sameRoutePoint(left: RoutePoint | undefined, right: RoutePoint | undefined): boolean {
  if (!left || !right) return false;
  return Math.abs(left.lat - right.lat) < 1e-6 && Math.abs(left.lon - right.lon) < 1e-6;
}

export function getRoutePointTotalDistanceM(points: RoutePoints): number {
  const last = points[points.length - 1];
  if (last && Number.isFinite(last.distanceM)) return last.distanceM as number;
  return routeLengthM(points);
}

export function roundRouteDistanceKm(distanceM: number): number {
  return roundDistanceKm(distanceM);
}

function getRoutePointDistances(points: RoutePoints): number[] {
  if (points.length === 0) return [];

  const distances = new Array<number>(points.length);
  distances[0] = 0;
  for (let index = 1; index < points.length; index += 1) {
    const point = points[index];
    const nextDistance = point.distanceM;
    if (Number.isFinite(nextDistance) && (nextDistance as number) >= distances[index - 1]) {
      distances[index] = nextDistance as number;
      continue;
    }
    distances[index] = distances[index - 1] + haversineRouteDistanceM(points[index - 1], point);
  }
  return distances;
}

function interpolateRoutePointAtDistance(
  points: RoutePoints,
  distances: number[],
  targetDistanceM: number,
): RoutePoint | null {
  if (points.length === 0 || distances.length !== points.length) return null;
  if (targetDistanceM <= distances[0]) return { ...points[0], distanceM: 0 };
  const lastIndex = points.length - 1;
  if (targetDistanceM >= distances[lastIndex]) {
    return { ...points[lastIndex], distanceM: distances[lastIndex] };
  }

  let low = 0;
  let high = lastIndex;
  while (low + 1 < high) {
    const mid = Math.floor((low + high) / 2);
    if (distances[mid] <= targetDistanceM) low = mid;
    else high = mid;
  }

  const startPoint = points[low];
  const endPoint = points[high];
  const spanM = distances[high] - distances[low];
  if (spanM <= 0) return { ...startPoint, distanceM: targetDistanceM };
  const t = Math.max(0, Math.min(1, (targetDistanceM - distances[low]) / spanM));

  return {
    lat: startPoint.lat + ((endPoint.lat - startPoint.lat) * t),
    lon: startPoint.lon + ((endPoint.lon - startPoint.lon) * t),
    distanceM: targetDistanceM,
    elevationM:
      Number.isFinite(startPoint.elevationM) && Number.isFinite(endPoint.elevationM)
        ? (startPoint.elevationM as number) + (((endPoint.elevationM as number) - (startPoint.elevationM as number)) * t)
        : startPoint.elevationM ?? endPoint.elevationM ?? null,
    gradientPct:
      Number.isFinite(startPoint.gradientPct) && Number.isFinite(endPoint.gradientPct)
        ? (startPoint.gradientPct as number) + (((endPoint.gradientPct as number) - (startPoint.gradientPct as number)) * t)
        : startPoint.gradientPct ?? endPoint.gradientPct ?? null,
  };
}

function dedupeRoutePoints(points: RoutePoints): RoutePoints {
  const deduped: RoutePoints = [];
  for (const point of points) {
    const previous = deduped[deduped.length - 1];
    if (previous && sameRoutePoint(previous, point)) continue;
    deduped.push(point);
  }
  return deduped;
}

function normalizeRoutePointDistances(points: RoutePoints): RoutePoints {
  if (points.length === 0) return [];
  let cumulativeDistanceM = 0;
  return points.map((point, index) => {
    if (index > 0) {
      cumulativeDistanceM += haversineRouteDistanceM(points[index - 1], point);
    }
    return {
      ...point,
      distanceM: cumulativeDistanceM,
    };
  });
}

function routePatchBoundaryDistanceM(
  patchPoint: { lat: number; lon: number; kind: 'start' | 'waypoint' | 'end' },
  routePoints: RoutePoints,
  routeDistances: number[],
): number | null {
  if (patchPoint.kind === 'start') return 0;
  if (patchPoint.kind === 'end') return routeDistances[routeDistances.length - 1] ?? 0;
  return projectPointAlongRoute(patchPoint, routePoints, routeDistances)?.distanceM ?? null;
}

export function replaceRouteSegment(
  basePoints: RoutePoints,
  patch: NonNullable<Itinerary['pendingRoutePatch']>,
  replacementPoints: RoutePoints,
): RoutePoints {
  if (basePoints.length === 0) return replacementPoints;

  const baseDistances = getRoutePointDistances(basePoints);
  const startDistanceM = routePatchBoundaryDistanceM(patch.start, basePoints, baseDistances);
  const endDistanceM = routePatchBoundaryDistanceM(patch.end, basePoints, baseDistances);
  if (startDistanceM == null || endDistanceM == null || endDistanceM < startDistanceM) {
    return replacementPoints;
  }

  const prefix = basePoints
    .filter((_, index) => baseDistances[index] < startDistanceM - 1e-6)
    .map((point) => ({ ...point }));
  const startBoundaryPoint = interpolateRoutePointAtDistance(basePoints, baseDistances, startDistanceM);
  if (startBoundaryPoint) prefix.push(startBoundaryPoint);

  const endBoundaryPoint = interpolateRoutePointAtDistance(basePoints, baseDistances, endDistanceM);
  const suffix = basePoints
    .filter((_, index) => baseDistances[index] > endDistanceM + 1e-6)
    .map((point) => ({ ...point }));
  if (endBoundaryPoint) suffix.unshift(endBoundaryPoint);

  return normalizeRoutePointDistances(
    dedupeRoutePoints([
      ...prefix,
      ...replacementPoints.map((point) => ({ ...point })),
      ...suffix,
    ]),
  );
}

export function recomputeApproxSurfaceMetrics(
  existingMetrics: Itinerary['metrics'] | undefined,
  basePoints: RoutePoints,
  patch: NonNullable<Itinerary['pendingRoutePatch']>,
  replacementSurfaceMetrics: ReturnType<typeof computeRouteSurfaceMetricsFromBrouter>,
  replacementDistanceM: number,
): { tarmacPercent?: number; offroadPercent?: number } | undefined {
  if (!replacementSurfaceMetrics) {
    return existingMetrics
      ? {
          tarmacPercent: existingMetrics.tarmacPercent,
          offroadPercent: existingMetrics.offroadPercent,
        }
      : undefined;
  }

  const baseDistances = getRoutePointDistances(basePoints);
  const startDistanceM = routePatchBoundaryDistanceM(patch.start, basePoints, baseDistances);
  const endDistanceM = routePatchBoundaryDistanceM(patch.end, basePoints, baseDistances);
  if (startDistanceM == null || endDistanceM == null || endDistanceM < startDistanceM) {
    return {
      tarmacPercent: Math.round(replacementSurfaceMetrics.tarmacPercent),
      offroadPercent: Math.round(replacementSurfaceMetrics.offroadPercent),
    };
  }

  const remainingBaseDistanceM = Math.max(0, (baseDistances[baseDistances.length - 1] ?? 0) - (endDistanceM - startDistanceM));
  return mergeSurfaceMetrics(
    existingMetrics,
    remainingBaseDistanceM,
    replacementSurfaceMetrics,
    replacementDistanceM,
  );
}

export function appendRoutePoints(basePoints: RoutePoints, extensionPoints: RoutePoints): RoutePoints {
  if (basePoints.length === 0) return extensionPoints;
  if (extensionPoints.length === 0) return basePoints;

  const baseDistanceM = getRoutePointTotalDistanceM(basePoints);
  const shouldDropFirstExtensionPoint = sameRoutePoint(
    basePoints[basePoints.length - 1],
    extensionPoints[0],
  );
  const segmentTail = shouldDropFirstExtensionPoint ? extensionPoints.slice(1) : extensionPoints;
  if (segmentTail.length === 0) return basePoints;

  return [
    ...basePoints,
    ...segmentTail.map((point) => ({
      ...point,
      distanceM: baseDistanceM + (Number.isFinite(point.distanceM) ? (point.distanceM as number) : 0),
    })),
  ];
}

export function mergeSurfaceMetrics(
  existingMetrics: Itinerary['metrics'] | undefined,
  baseDistanceM: number,
  segmentSurfaceMetrics: ReturnType<typeof computeRouteSurfaceMetricsFromBrouter>,
  segmentDistanceM: number,
): { tarmacPercent?: number; offroadPercent?: number } | undefined {
  if (!segmentSurfaceMetrics) {
    return existingMetrics
      ? {
          tarmacPercent: existingMetrics.tarmacPercent,
          offroadPercent: existingMetrics.offroadPercent,
        }
      : undefined;
  }

  const baseTarmacDistanceM =
    existingMetrics?.tarmacPercent != null ? (existingMetrics.tarmacPercent / 100) * baseDistanceM : Number.NaN;
  const baseOffroadDistanceM =
    existingMetrics?.offroadPercent != null ? (existingMetrics.offroadPercent / 100) * baseDistanceM : Number.NaN;
  const segmentTarmacDistanceM =
    (segmentSurfaceMetrics.tarmacPercent / 100) * Math.max(segmentDistanceM, 0);
  const segmentOffroadDistanceM =
    (segmentSurfaceMetrics.offroadPercent / 100) * Math.max(segmentDistanceM, 0);

  if (!Number.isFinite(baseTarmacDistanceM) || !Number.isFinite(baseOffroadDistanceM)) {
    return {
      tarmacPercent: Math.round(segmentSurfaceMetrics.tarmacPercent),
      offroadPercent: Math.round(segmentSurfaceMetrics.offroadPercent),
    };
  }

  const totalClassifiedDistanceM =
    baseTarmacDistanceM +
    baseOffroadDistanceM +
    segmentTarmacDistanceM +
    segmentOffroadDistanceM;
  if (!(totalClassifiedDistanceM > 0)) return undefined;

  return {
    tarmacPercent: Math.round(((baseTarmacDistanceM + segmentTarmacDistanceM) / totalClassifiedDistanceM) * 100),
    offroadPercent: Math.round(((baseOffroadDistanceM + segmentOffroadDistanceM) / totalClassifiedDistanceM) * 100),
  };
}

export function isBrouterUnmappedPointError(error: unknown): boolean {
  if (!(error instanceof Error)) return false;
  const message = error.message.toLowerCase();
  return message.includes('brouter http 422') && message.includes('from-position not mapped in existing datafile');
}

export function routeAuditEqual(
  left: ItineraryRouteAuditFinding[] | undefined,
  right: ItineraryRouteAuditFinding[] | undefined,
): boolean {
  const leftFindings = left ?? [];
  const rightFindings = right ?? [];
  return (
    leftFindings.length === rightFindings.length &&
    leftFindings.every((finding, index) => {
      const other = rightFindings[index];
      return (
        finding.id === other?.id &&
        finding.kind === other.kind &&
        finding.title === other.title &&
        finding.detail === other.detail &&
        finding.coordinates.length === other.coordinates.length &&
        finding.coordinates.every((coord, coordIndex) => {
          const next = other.coordinates[coordIndex];
          return coord[0] === next?.[0] && coord[1] === next?.[1];
        })
      );
    })
  );
}

export function projectTimelineLocationDistances(
  timeline: Itinerary['timeline'],
  routePoints: RoutePoints,
  totalDistanceKm: number,
): Itinerary['timeline'] {
  const cumulativeLengths = cumulativeRouteLengthsM(routePoints);
  const snappedStart = routePoints[0] ?? null;
  const snappedEnd = routePoints[routePoints.length - 1] ?? null;
  let changed = false;

  const nextTimeline = timeline.map((row) => {
    if (row.kind === 'start') {
      if (
        row.distanceKm === 0 &&
        row.lat === snappedStart?.lat &&
        row.lon === snappedStart?.lon
      ) {
        return row;
      }
      changed = true;
      return {
        ...row,
        distanceKm: 0,
        lat: snappedStart?.lat ?? row.lat,
        lon: snappedStart?.lon ?? row.lon,
      };
    }

    if (row.kind === 'end') {
      if (
        row.distanceKm === totalDistanceKm &&
        row.lat === snappedEnd?.lat &&
        row.lon === snappedEnd?.lon
      ) {
        return row;
      }
      changed = true;
      return {
        ...row,
        distanceKm: totalDistanceKm,
        lat: snappedEnd?.lat ?? row.lat,
        lon: snappedEnd?.lon ?? row.lon,
      };
    }

    if (row.kind !== 'waypoint') return row;

    const snappedWaypoint =
      row.lat != null && row.lon != null
        ? projectPointAlongRoute(
            { lat: row.lat, lon: row.lon },
            routePoints,
            cumulativeLengths,
          )
        : null;
    const projectedDistanceKm =
      snappedWaypoint == null ? null : roundDistanceKm(snappedWaypoint.distanceM);
    if (
      row.distanceKm === projectedDistanceKm &&
      row.lat === snappedWaypoint?.lat &&
      row.lon === snappedWaypoint?.lon
    ) {
      return row;
    }
    changed = true;
    return {
      ...row,
      distanceKm: projectedDistanceKm,
      lat: snappedWaypoint?.lat ?? row.lat,
      lon: snappedWaypoint?.lon ?? row.lon,
    };
  });

  return changed ? nextTimeline : timeline;
}