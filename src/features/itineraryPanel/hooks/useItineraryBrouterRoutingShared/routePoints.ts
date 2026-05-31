import type { BrouterRoute } from '../../lib/brouter';
import { extractRouteProfileFromPoints } from '../../lib/route-metrics';
import { parseMessages } from '../../lib/route-metrics/parser';
import type { Surface } from '../../lib/route-metrics/types';

import type { ProfilePoint, RoutePoints } from './types';

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

export function applyBrouterSurfaceToRoutePoints(
  route: BrouterRoute,
  points: RoutePoints,
): RoutePoints {
  if (points.length === 0) return points;

  const rows = parseMessages(route);
  if (rows.length === 0) return points;

  const surfaceSamples = buildSurfaceSamples(rows);
  if (surfaceSamples.length === 0) return points;

  let sampleIndex = 0;
  const lastSample = surfaceSamples[surfaceSamples.length - 1];

  return points.map((point, index) => {
    const fallbackDistanceM = index > 0
      ? Number(points[index - 1]?.distanceM ?? 0) + haversineMeters(points[index - 1], point)
      : 0;
    const distanceM = Number.isFinite(point.distanceM) ? (point.distanceM as number) : fallbackDistanceM;

    while (
      sampleIndex < surfaceSamples.length - 1
      && surfaceSamples[sampleIndex]!.distanceM < distanceM
    ) {
      sampleIndex += 1;
    }

    return {
      ...point,
      surface: (surfaceSamples[sampleIndex] ?? lastSample).surface,
    };
  });
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

function buildSurfaceSamples(
  rows: Array<{ segDistM: number; surface: Surface }>,
): Array<{ distanceM: number; surface: Surface }> {
  const samples: Array<{ distanceM: number; surface: Surface }> = [];
  let cumulativeDistanceM = 0;

  for (let index = 0; index < rows.length; index += 1) {
    if (index > 0) {
      cumulativeDistanceM += Math.max(0, rows[index]!.segDistM);
    }
    samples.push({
      distanceM: cumulativeDistanceM,
      surface: rows[index]!.surface,
    });
  }

  return samples;
}