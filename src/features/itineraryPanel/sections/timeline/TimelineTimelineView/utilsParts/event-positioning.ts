import {
  TIMELINE_BLOCK_GAP_PX,
  TIMELINE_VIEWPORT_BOTTOM_INSET_PX,
  TIMELINE_VIEWPORT_TOP_INSET_PX,
} from '../constants';
import type { TimelineEvent, TimelinePositioningResult, TimelineStandalonePause } from '../types';

export function positionTimelineBlocks(
  scheduledEvents: TimelineEvent[],
  scheduledStandalonePauses: TimelineStandalonePause[],
  standalonePauseDayKeyById: ReadonlyMap<string, string | null>,
  canvasBaseHeight: number,
): TimelinePositioningResult {
  const blocks: Array<{
    id: string;
    kind: 'event' | 'pause';
    laneKey: string;
    scheduledTopPx: number;
    stackHeightPx: number;
    heightPx: number;
    sortIndex: number;
  }> = [
    ...scheduledEvents.map((event) => ({
      id: event.item.id,
      kind: 'event' as const,
      laneKey: event.spanSegments[0]?.dayKey ?? event.dayKey ?? '__single__',
      scheduledTopPx: event.scheduledTopPx,
      // The visible 32px frame (card) drives stacking so POI frames never
      // overlap, regardless of the event's temporal span height.
      stackHeightPx: event.cardHeightPx,
      heightPx: event.heightPx,
      sortIndex: event.sortIndex,
    })),
    ...scheduledStandalonePauses.map((pause) => ({
      id: pause.id,
      kind: 'pause' as const,
      laneKey: standalonePauseDayKeyById.get(pause.id) ?? '__single__',
      scheduledTopPx: pause.scheduledTopPx,
      stackHeightPx: pause.heightPx,
      heightPx: pause.heightPx,
      sortIndex: pause.sortIndex,
    })),
  ].sort(
    (left, right) =>
      left.scheduledTopPx - right.scheduledTopPx
      || left.sortIndex - right.sortIndex
      || (left.kind === right.kind ? 0 : left.kind === 'event' ? -1 : 1),
  );

  const positionedTopById = new Map<string, number>();
  const nextAvailableTopPxByLane = new Map<string, number>();
  let maxContentBottomPx = canvasBaseHeight + TIMELINE_VIEWPORT_TOP_INSET_PX;
  let firstTopPx: number | null = null;

  blocks.forEach((block) => {
    const nextAvailableTopPx =
      nextAvailableTopPxByLane.get(block.laneKey) ?? TIMELINE_VIEWPORT_TOP_INSET_PX;
    const topPx = Math.max(block.scheduledTopPx, nextAvailableTopPx);
    positionedTopById.set(block.id, topPx);
    nextAvailableTopPxByLane.set(block.laneKey, topPx + block.stackHeightPx + TIMELINE_BLOCK_GAP_PX);
    maxContentBottomPx = Math.max(maxContentBottomPx, topPx + block.stackHeightPx);
    if (firstTopPx === null) firstTopPx = topPx;
  });

  return {
    events: scheduledEvents.map((event) => {
      const positionedTopPx = positionedTopById.get(event.item.id) ?? event.scheduledTopPx;
      const topOffsetPx = positionedTopPx - event.scheduledTopPx;
      return {
        ...event,
        topPx: positionedTopPx,
        spanSegments: event.spanSegments.map((segment, index) => ({
          ...segment,
          topPx: segment.topPx + (index === 0 ? topOffsetPx : 0),
        })),
      };
    }),
    standalonePauses: scheduledStandalonePauses.map((pause) => ({
      ...pause,
      topPx: positionedTopById.get(pause.id) ?? pause.scheduledTopPx,
    })),
    canvasHeight: maxContentBottomPx + TIMELINE_VIEWPORT_BOTTOM_INSET_PX,
    firstVisibleTopPx: firstTopPx,
  };
}