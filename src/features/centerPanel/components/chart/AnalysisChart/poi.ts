import type { AxisDomain } from '../series';
import {
  POI_CLUSTER_DISTANCE_WINDOW_KM,
  POI_CLUSTER_MIN_COUNT,
  POI_MARKER_SIZE_PX,
  POI_MARKER_SPREAD_STEP_PX,
  type PoiMarkerGroup,
  type VisiblePoiAnnotation,
} from './types';
import { clamp, MIN_VISIBLE_FRACTION, normalizeUnitInterval } from './math';

export function getPoiDistanceKm(annotation: VisiblePoiAnnotation): number {
  if (typeof annotation.distanceKm === 'number' && Number.isFinite(annotation.distanceKm)) {
    return annotation.distanceKm;
  }
  if (typeof annotation.x === 'number' && Number.isFinite(annotation.x)) {
    return annotation.x;
  }
  return 0;
}

export function buildPoiMarkerGroups(
  annotations: VisiblePoiAnnotation[],
  _visibleFraction: number,
): PoiMarkerGroup[] {
  if (annotations.length === 0) return [];

  // Isolate favorites so a single favorite doesn't force a whole town of non-favorites to fan out across the chart
  const favorites = annotations.filter((a) => Boolean(a.favorite));
  const nonFavorites = annotations.filter((a) => !a.favorite);

  const clusterList = (list: VisiblePoiAnnotation[]): PoiMarkerGroup[] => {
    if (list.length === 0) return [];
    // Sort primarily by distanceKm along route, secondary by xRatio
    const sorted = [...list].sort((left, right) => {
      const distA = getPoiDistanceKm(left);
      const distB = getPoiDistanceKm(right);
      if (distA !== distB) return distA - distB;
      return left.xRatio - right.xRatio;
    });

    const rawGroups: VisiblePoiAnnotation[][] = [];
    let i = 0;
    while (i < sorted.length) {
      const startDist = getPoiDistanceKm(sorted[i]);
      let j = i;
      while (
        j < sorted.length &&
        getPoiDistanceKm(sorted[j]) - startDist <= POI_CLUSTER_DISTANCE_WINDOW_KM
      ) {
        j++;
      }

      const countInWindow = j - i;
      // Only group dense clusters with >= 10 POIs within 1.0 km
      if (countInWindow >= POI_CLUSTER_MIN_COUNT) {
        rawGroups.push(sorted.slice(i, j));
        i = j;
      } else {
        // All other POIs are kept as single individual markers
        rawGroups.push([sorted[i]]);
        i++;
      }
    }

    return rawGroups.map((members) => {
      const count = members.length;
      const avgX = members.reduce((sum, member) => sum + member.xRatio, 0) / count;
      const topY = members.reduce((min, member) => Math.min(min, member.yRatio), members[0].yRatio);
      return {
        // First member + size identifies a cluster (members are disjoint and
        // sorted) without concatenating every member id on each pan frame.
        id: count === 1
          ? members[0].id
          : `cluster:${members[0].id}:${members[count - 1].id}:${count}`,
        kind: count === 1 ? 'single' : 'cluster',
        count,
        xRatio: avgX,
        yRatio: topY,
        members,
      };
    });
  };

  const favoriteGroups = clusterList(favorites);
  const nonFavoriteGroups = clusterList(nonFavorites);

  return [...nonFavoriteGroups, ...favoriteGroups];
}

export function shouldRenderPoiCluster(
  group: PoiMarkerGroup,
  visibleFraction: number,
  expandedPoiClusterId: string | null,
): boolean {
  if (group.kind !== 'cluster') {
    return false;
  }
  // If the group contains any favorite, never cluster: show the favorite pin in front of rounds
  if (group.members.some((m) => m.favorite)) {
    return false;
  }
  // Only cluster when there are 10 or more co-located non-favorite POIs and not expanded
  return (
    group.count >= POI_CLUSTER_MIN_COUNT &&
    !shouldExpandPoiCluster(group, visibleFraction, expandedPoiClusterId)
  );
}

export function shouldExpandPoiCluster(
  group: PoiMarkerGroup,
  visibleFraction: number,
  expandedPoiClusterId: string | null,
): boolean {
  return isMaxPoiZoom(visibleFraction) || expandedPoiClusterId === group.id;
}

function isMaxPoiZoom(visibleFraction: number): boolean {
  return visibleFraction <= MIN_VISIBLE_FRACTION + 1e-3;
}

export function buildViewportForPoiCluster(input: {
  members: VisiblePoiAnnotation[];
  count: number;
  xDomain: AxisDomain;
  plotXDomain: AxisDomain;
  plotWidth: number;
}): { detailZoom: number; detailOffset: number } | null {
  const { members, count, xDomain, plotXDomain, plotWidth } = input;
  if (members.length <= 1) return null;

  const fullSpan = xDomain.max - xDomain.min;
  const currentSpan = plotXDomain.max - plotXDomain.min;
  if (!(fullSpan > 0) || !(currentSpan > 0)) return null;

  const minX = Math.min(...members.map((member) => member.x));
  const maxX = Math.max(...members.map((member) => member.x));
  const desiredPixelSpan = Math.max(
    POI_MARKER_SIZE_PX * 1.25 + (count - 1) * POI_MARKER_SPREAD_STEP_PX,
    plotWidth * 0.16,
  );
  const pixelPaddingRatio = plotWidth > 0 ? desiredPixelSpan / plotWidth : 0.16;
  const domainPadding = currentSpan * pixelPaddingRatio * 0.75;
  const targetSpan = clamp(
    maxX - minX + domainPadding * 2,
    fullSpan * MIN_VISIBLE_FRACTION,
    fullSpan,
  );
  const center = (minX + maxX) / 2;
  const minStart = xDomain.min;
  const maxStart = xDomain.max - targetSpan;
  const start = clamp(center - targetSpan / 2, minStart, maxStart);
  const visibleFraction = clamp(targetSpan / fullSpan, MIN_VISIBLE_FRACTION, 1);
  const remainingSpan = fullSpan - targetSpan;
  const detailOffset = remainingSpan <= 1e-6 ? 0 : (start - xDomain.min) / remainingSpan;
  const detailZoom =
    visibleFraction >= 0.999
      ? 0
      : clamp((1 - visibleFraction) / (1 - MIN_VISIBLE_FRACTION), 0, 1);

  return {
    detailZoom,
    detailOffset: normalizeUnitInterval(detailOffset),
  };
}