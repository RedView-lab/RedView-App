import type { BrouterRoute } from '../../lib/brouter';
import { extractRouteProfileFromPoints } from '../../lib/route-metrics';
import { parseMessages } from '../../lib/route-metrics/parser';
import type { ParsedRow, Surface } from '../../lib/route-metrics/types';

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

/**
 * @param elevationOverride profil d'altitude affiné (MNT IGN / Terrarium,
 *   échantillonné aux sommets de la géométrie, cf. refineRouteProfileWithIgnAltimetry) :
 *   remplace les altitudes BRouter sans toucher à la géométrie.
 */
export function buildStoredRoutePointsFromBrouter(
  geometryPoints: RoutePoints,
  messageProfile: ProfilePoint[] | null,
  targetDistanceM: number,
  elevationOverride?: ProfilePoint[] | null,
): RoutePoints {
  const geometryProfile = extractRouteProfileFromPoints(geometryPoints);
  const denseGeometryPoints = geometryProfile
    ? scaleRouteProfileDistances(toStoredRoutePoints(geometryProfile), targetDistanceM)
    : null;

  if (denseGeometryPoints) {
    // Sans cela le profil affiné était ignoré dès que BRouter fournit des
    // coordonnées 3D (cas normal) : l'affinage altimétrique n'avait aucun effet.
    return elevationOverride && elevationOverride.length >= 2
      ? reElevateRoutePoints(denseGeometryPoints, elevationOverride)
      : denseGeometryPoints;
  }

  const fallbackProfile = elevationOverride && elevationOverride.length >= 2 ? elevationOverride : messageProfile;
  return fallbackProfile
    ? enrichGeometryRoutePoints(geometryPoints, fallbackProfile)
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
  const lastSample = surfaceSamples[surfaceSamples.length - 1]!;
  const distances: number[] = [];

  const enriched = points.map((point, index) => {
    const fallbackDistanceM = index > 0
      ? Number(points[index - 1]?.distanceM ?? 0) + haversineMeters(points[index - 1], point)
      : 0;
    const distanceM = Number.isFinite(point.distanceM) ? (point.distanceM as number) : fallbackDistanceM;
    distances.push(distanceM);

    while (
      sampleIndex < surfaceSamples.length - 1
      && surfaceSamples[sampleIndex]!.distanceM < distanceM
    ) {
      sampleIndex += 1;
    }

    const sample = surfaceSamples[sampleIndex] ?? lastSample;
    // Attributs pour le moteur de temps, omis quand inconnus (taille du projet).
    const next = { ...point, surface: sample.surface };
    delete next.roughness;
    delete next.wayCode;
    if (sample.roughness > 0) next.roughness = sample.roughness;
    if (sample.wayCode > 0) next.wayCode = sample.wayCode;
    return next;
  });

  // Feu / stop : porté par le seul point le plus proche du nœud, pas par tout
  // le tronçon.
  for (const sample of surfaceSamples) {
    if (!sample.signal) continue;
    let lo = 0;
    let hi = distances.length - 1;
    while (lo + 1 < hi) {
      const mid = (lo + hi) >> 1;
      if (distances[mid]! <= sample.distanceM) lo = mid;
      else hi = mid;
    }
    const index = Math.abs(distances[hi]! - sample.distanceM) < Math.abs(distances[lo]! - sample.distanceM) ? hi : lo;
    const target = enriched[index]!;
    enriched[index] = { ...target, wayCode: (target.wayCode ?? 0) | 0x80 };
  }

  return enriched;
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

/**
 * Profil des lignes de `messages` BRouter (support de l'audit du tracé, apparié
 * aux messages ligne à ligne) avec les altitudes / pentes du profil MNT affiné,
 * échantillonné, lui, à chaque sommet de la géométrie.
 */
export function reElevateMessageProfile(
  messageProfile: ProfilePoint[],
  elevationProfile: ProfilePoint[],
): ProfilePoint[] {
  const totalDistanceM = messageProfile[messageProfile.length - 1]?.distanceM ?? 0;
  const profileTotalDistanceM = elevationProfile[elevationProfile.length - 1]?.distanceM ?? 0;
  const scale = totalDistanceM > 0 && profileTotalDistanceM > 0 ? profileTotalDistanceM / totalDistanceM : 1;
  return messageProfile.map((point) => ({
    ...point,
    ...interpolateProfileSample(elevationProfile, point.distanceM * scale),
  }));
}

/** Altitudes / pentes reprises du profil (à distance relative égale), géométrie inchangée. */
function reElevateRoutePoints(points: RoutePoints, profile: ProfilePoint[]): RoutePoints {
  const totalDistanceM = Number(points[points.length - 1]?.distanceM ?? 0);
  const profileTotalDistanceM = profile[profile.length - 1]?.distanceM ?? 0;
  const scale = totalDistanceM > 0 && profileTotalDistanceM > 0 ? profileTotalDistanceM / totalDistanceM : 1;
  return points.map((point) => {
    const sample = interpolateProfileSample(profile, Number(point.distanceM ?? 0) * scale);
    return { ...point, elevationM: sample.elevationM, gradientPct: sample.gradientPct };
  });
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

interface SurfaceSample {
  distanceM: number;
  surface: Surface;
  roughness: number;
  wayCode: number;
  signal: boolean;
}

function buildSurfaceSamples(rows: ParsedRow[]): SurfaceSample[] {
  const samples: SurfaceSample[] = [];
  let cumulativeDistanceM = 0;

  for (let index = 0; index < rows.length; index += 1) {
    if (index > 0) {
      cumulativeDistanceM += Math.max(0, rows[index]!.segDistM);
    }
    const row = rows[index]!;
    samples.push({
      distanceM: cumulativeDistanceM,
      surface: row.surface,
      roughness: row.roughness,
      wayCode: row.wayCode,
      signal: row.signal,
    });
  }

  return samples;
}