import type { PoiCategory } from '../types';
import type { ProjectedPoi } from './refinePoiProjection';
const CLUSTER_BONUS_PER_EXTRA_CATEGORY = 0.18;
const CLUSTER_BONUS_MAX = 1.6;

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
