import type { GpxRoute, PoiFeature } from '../types';

interface RefinementOptions {
  maxPerCategoryPerKm: number;
  windowM?: number;
}

interface ProjectedRoutePoint {
  x: number;
  y: number;
  progressM: number;
}

interface ProjectedPoi {
  feature: PoiFeature;
  progressM: number;
  lateralDistanceM: number;
}

const METERS_PER_DEG_LAT = 110_540;
const METERS_PER_DEG_LON = 111_320;

export function refinePoiFeaturesAlongRoute(
  features: PoiFeature[],
  routePoints: GpxRoute['points'],
  options: RefinementOptions,
): PoiFeature[] {
  const maxPerCategoryPerKm = Math.max(0, Math.floor(options.maxPerCategoryPerKm));
  const windowM = Math.max(250, options.windowM ?? 1_000);
  if (features.length <= 1 || routePoints.length < 2 || maxPerCategoryPerKm <= 0) {
    return features;
  }

  const route = projectRoute(routePoints);
  const projected = features.map((feature) => projectPoi(feature, route));
  const groups = new Map<string, ProjectedPoi[]>();

  for (const candidate of projected) {
    const key = candidate.feature.category;
    const existing = groups.get(key);
    if (existing) {
      existing.push(candidate);
    } else {
      groups.set(key, [candidate]);
    }
  }

  const kept: ProjectedPoi[] = [];
  for (const group of groups.values()) {
    group.sort((a, b) => {
      if (a.progressM !== b.progressM) return a.progressM - b.progressM;
      if (a.lateralDistanceM !== b.lateralDistanceM) {
        return a.lateralDistanceM - b.lateralDistanceM;
      }
      return a.feature.id - b.feature.id;
    });

    const recentProgress: number[] = [];
    let recentStart = 0;

    for (const candidate of group) {
      while (
        recentStart < recentProgress.length
        && recentProgress[recentStart] < candidate.progressM - windowM
      ) {
        recentStart += 1;
      }

      if (recentProgress.length - recentStart >= maxPerCategoryPerKm) {
        continue;
      }

      recentProgress.push(candidate.progressM);
      kept.push(candidate);
    }
  }

  kept.sort((a, b) => {
    if (a.progressM !== b.progressM) return a.progressM - b.progressM;
    if (a.feature.category !== b.feature.category) {
      return a.feature.category.localeCompare(b.feature.category);
    }
    if (a.lateralDistanceM !== b.lateralDistanceM) {
      return a.lateralDistanceM - b.lateralDistanceM;
    }
    return a.feature.id - b.feature.id;
  });

  return kept.map((entry) => entry.feature);
}

function projectRoute(points: GpxRoute['points']): ProjectedRoutePoint[] {
  const originLat = points[0]?.lat ?? 0;
  const cosLat = Math.cos((originLat * Math.PI) / 180);
  let cumulative = 0;

  return points.map((point, index) => {
    if (index > 0) {
      cumulative += planarDistanceM(points[index - 1]!, point, cosLat);
    }
    return {
      x: point.lon * METERS_PER_DEG_LON * cosLat,
      y: point.lat * METERS_PER_DEG_LAT,
      progressM: point.distanceM ?? cumulative,
    };
  });
}

function projectPoi(
  feature: PoiFeature,
  route: ProjectedRoutePoint[],
): ProjectedPoi {
  const originLat = (route[0]?.y ?? 0) / METERS_PER_DEG_LAT;
  const cosLat = Math.cos((originLat * Math.PI) / 180);
  const pointX = feature.lon * METERS_PER_DEG_LON * cosLat;
  const pointY = feature.lat * METERS_PER_DEG_LAT;

  let bestProgress = route[0]?.progressM ?? 0;
  let bestDistance = Number.POSITIVE_INFINITY;

  for (let index = 1; index < route.length; index += 1) {
    const a = route[index - 1]!;
    const b = route[index]!;
    const dx = b.x - a.x;
    const dy = b.y - a.y;
    const lenSq = dx * dx + dy * dy;

    if (lenSq <= 1e-6) {
      const dist = Math.hypot(pointX - a.x, pointY - a.y);
      if (dist < bestDistance) {
        bestDistance = dist;
        bestProgress = a.progressM;
      }
      continue;
    }

    const t = Math.max(0, Math.min(1, ((pointX - a.x) * dx + (pointY - a.y) * dy) / lenSq));
    const projX = a.x + dx * t;
    const projY = a.y + dy * t;
    const dist = Math.hypot(pointX - projX, pointY - projY);

    if (dist < bestDistance) {
      bestDistance = dist;
      bestProgress = a.progressM + (b.progressM - a.progressM) * t;
    }
  }

  return {
    feature,
    progressM: bestProgress,
    lateralDistanceM: bestDistance,
  };
}

function planarDistanceM(
  a: { lat: number; lon: number },
  b: { lat: number; lon: number },
  cosLat: number,
): number {
  const dx = (a.lon - b.lon) * METERS_PER_DEG_LON * cosLat;
  const dy = (a.lat - b.lat) * METERS_PER_DEG_LAT;
  return Math.hypot(dx, dy);
}