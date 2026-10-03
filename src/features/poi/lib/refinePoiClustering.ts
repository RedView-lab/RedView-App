import type { PoiCategory } from '../types';
import type { ProjectedPoi } from './refinePoiProjection';
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
