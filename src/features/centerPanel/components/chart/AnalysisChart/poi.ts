import type { AxisDomain } from '../series';
import {
  POI_CLUSTER_COMPACT_VISIBLE_FRACTION,
  POI_CLUSTER_OVERLAP_X_PX,
  POI_CLUSTER_OVERLAP_X_PX_COMPACT,
  POI_CLUSTER_OVERLAP_Y_PX,
  POI_CLUSTER_OVERLAP_Y_PX_COMPACT,
  POI_MARKER_SIZE_PX,
  POI_MARKER_SPREAD_STEP_PX,
  type PoiMarkerGroup,
  type VisiblePoiAnnotation,
} from './types';
import { clamp, MIN_VISIBLE_FRACTION, normalizeUnitInterval } from './math';

export function buildPoiMarkerGroups(
  annotations: VisiblePoiAnnotation[],
  visibleFraction: number,
): PoiMarkerGroup[] {
  if (annotations.length === 0) return [];

  // Isolate favorites so a single favorite doesn't force a whole town of non-favorites to fan out across the chart
  const favorites = annotations.filter((a) => Boolean(a.favorite));
  const nonFavorites = annotations.filter((a) => !a.favorite);

  const clusterList = (list: VisiblePoiAnnotation[]): PoiMarkerGroup[] => {
    if (list.length === 0) return [];
    const sorted = [...list].sort((left, right) => left.xPx - right.xPx);
    const rawGroups: VisiblePoiAnnotation[][] = [];

    for (const annotation of sorted) {
      const targetGroup = rawGroups[rawGroups.length - 1] ?? null;
      if (targetGroup && annotationFitsCluster(targetGroup, annotation, visibleFraction)) {
        targetGroup.push(annotation);
        continue;
      }
      rawGroups.push([annotation]);
    }

    return rawGroups.map((members) => {
      const count = members.length;
      const avgX = members.reduce((sum, member) => sum + member.xRatio, 0) / count;
      const topY = members.reduce((min, member) => Math.min(min, member.yRatio), members[0].yRatio);
      return {
        id: count === 1 ? members[0].id : `cluster:${members.map((member) => member.id).join('|')}`,
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

function annotationsOverlap(
  left: VisiblePoiAnnotation,
  right: VisiblePoiAnnotation,
  visibleFraction: number,
): boolean {
  const compactMode = visibleFraction >= POI_CLUSTER_COMPACT_VISIBLE_FRACTION;
  const maxDeltaX = compactMode ? POI_CLUSTER_OVERLAP_X_PX_COMPACT : POI_CLUSTER_OVERLAP_X_PX;
  const maxDeltaY = compactMode ? POI_CLUSTER_OVERLAP_Y_PX_COMPACT : POI_CLUSTER_OVERLAP_Y_PX;
  return (
    Math.abs(left.xPx - right.xPx) <= maxDeltaX &&
    Math.abs(left.yPx - right.yPx) <= maxDeltaY
  );
}

function annotationFitsCluster(
  cluster: VisiblePoiAnnotation[],
  annotation: VisiblePoiAnnotation,
  visibleFraction: number,
): boolean {
  if (cluster.length === 0) return false;
  const anchor = cluster[0];
  const previous = cluster[cluster.length - 1];
  return (
    annotationsOverlap(anchor, annotation, visibleFraction) &&
    annotationsOverlap(previous, annotation, visibleFraction)
  );
}

export function buildPoiSpreadOffsetPx(_index: number, _count: number): number {
  // POIs superpose at their actual route position with no horizontal shift
  return 0;
}

export function shouldRenderPoiCluster(
  group: PoiMarkerGroup,
  visibleFraction: number,
  expandedPoiClusterId: string | null,
): boolean {
  // If the group contains any favorite, never cluster: show the favorite pin in front of rounds
  if (group.members.some((m) => m.favorite)) {
    return false;
  }
  // Only cluster when there are 6 or more co-located non-favorite POIs and not expanded
  return group.count >= 6 && !shouldExpandPoiCluster(group, visibleFraction, expandedPoiClusterId);
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