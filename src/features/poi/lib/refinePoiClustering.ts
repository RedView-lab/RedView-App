import type { PoiCategory, PoiFeature } from '../types';
import type { ProjectedPoi } from './refinePoiProjection';

export const DEFAULT_CLUSTER_RADIUS_M = 150;
export const DEFAULT_CLUSTER_LATERAL_M = 80;
export const CLUSTER_BONUS_PER_EXTRA_CATEGORY = 0.18;
export const CLUSTER_BONUS_MAX = 1.6;

export const DEFAULT_MIN_SPACING_SEC: Partial<Record<PoiCategory, number>> = {
  drinking_water: 45 * 60,
  bakery: 2 * 3600,
  convenience: 2 * 3600,
  supermarket: 2 * 3600,
  restaurant: 4 * 3600,
  fast_food: 4 * 3600,
  cafe: 4 * 3600,
  bar: 4 * 3600,
  hotel: 12 * 3600,
  alpine_hut: 12 * 3600,
  camp_site: 12 * 3600,
  shelter: 6 * 3600,
};

export const NON_CADENCED_CATEGORIES: ReadonlySet<PoiCategory> = new Set<PoiCategory>([
  'toilets',
  'bicycle',
  'bicycle_repair',
  'pharmacy',
  'hospital',
  'fuel',
]);

export interface Cluster {
  id: number;
  progressStart: number;
  progressEnd: number;
  members: ProjectedPoi[];
  distinctCategories: Set<PoiCategory>;
  bonus: number;
}

export function buildPoiClusters(
  pois: ProjectedPoi[],
  clusterRadiusM: number,
  clusterMaxLateralM: number,
): Cluster[] {
  const sorted = [...pois].sort((a, b) => a.progressM - b.progressM);
  const clusters: Cluster[] = [];
  let current: Cluster | null = null;

  for (const poi of sorted) {
    if (
      !current
      || poi.progressM - current.progressEnd > clusterRadiusM
      || poi.lateralDistanceM > clusterMaxLateralM
    ) {
      current = {
        id: clusters.length,
        progressStart: poi.progressM,
        progressEnd: poi.progressM,
        members: [poi],
        distinctCategories: new Set([poi.feature.category]),
        bonus: 1.0,
      };
      clusters.push(current);
    } else {
      current.members.push(poi);
      current.progressEnd = Math.max(current.progressEnd, poi.progressM);
      current.distinctCategories.add(poi.feature.category);
    }
    poi.clusterId = current.id;
  }

  for (const cluster of clusters) {
    const extraCategories = Math.max(0, cluster.distinctCategories.size - 1);
    cluster.bonus = Math.min(
      CLUSTER_BONUS_MAX,
      1.0 + extraCategories * CLUSTER_BONUS_PER_EXTRA_CATEGORY,
    );
    for (const member of cluster.members) {
      member.score = member.baseScore * cluster.bonus;
    }
  }

  return clusters;
}

export function capPoisPerCategory(
  category: PoiCategory,
  pois: ProjectedPoi[],
  maxPerKm: number,
  windowM: number,
  minSpacingSecOverride?: number,
  maxHotelsPerNight?: number,
  startTimeMs?: number,
  timezoneOffsetMin = 0,
): PoiFeature[] {
  if (pois.length === 0) return [];

  const candidates = pois
    .filter((p) => p.feature.category === category && p.openStatus !== 'closed')
    .sort((a, b) => b.score - a.score);

  const selected: ProjectedPoi[] = [];
  const minSpacingSec = minSpacingSecOverride ?? DEFAULT_MIN_SPACING_SEC[category];
  const minDistanceSpacingM = (windowM / Math.max(1, maxPerKm)) * 0.7;

  const getNightBucket = (etaSec: number | null): number => {
    if (etaSec == null || startTimeMs == null) return 0;
    const arrivalTimeMs = startTimeMs + etaSec * 1000 + timezoneOffsetMin * 60 * 1000;
    return Math.floor(arrivalTimeMs / (24 * 3600 * 1000));
  };

  const hotelCountByNight = new Map<number, number>();

  for (const candidate of candidates) {
    if (category === 'hotel' && maxHotelsPerNight != null && maxHotelsPerNight > 0) {
      const night = getNightBucket(candidate.etaSec);
      const currentCount = hotelCountByNight.get(night) ?? 0;
      if (currentCount >= maxHotelsPerNight) continue;
    }

    let conflicts = false;
    for (const existing of selected) {
      const dist = Math.abs(candidate.progressM - existing.progressM);
      if (dist < minDistanceSpacingM) {
        conflicts = true;
        break;
      }

      if (
        minSpacingSec != null
        && !NON_CADENCED_CATEGORIES.has(category)
        && candidate.etaSec != null
        && existing.etaSec != null
      ) {
        const timeDiff = Math.abs(candidate.etaSec - existing.etaSec);
        if (timeDiff < minSpacingSec) {
          conflicts = true;
          break;
        }
      }
    }

    if (!conflicts) {
      selected.push(candidate);
      if (category === 'hotel') {
        const night = getNightBucket(candidate.etaSec);
        hotelCountByNight.set(night, (hotelCountByNight.get(night) ?? 0) + 1);
      }
    }
  }

  return selected.map((p) => p.feature);
}
