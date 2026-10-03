import {
  ATTACHED_PAUSE_HEIGHT_PX,
  PAUSE_CHIP_MIN_HEIGHT_PX,
  RAIL_ITEM_HEIGHT_PX,
  TIMELINE_BLOCK_GAP_PX,
  TIMELINE_VIEWPORT_BOTTOM_INSET_PX,
  TIMELINE_VIEWPORT_TOP_INSET_PX,
} from '../constants';
import type {
  AttachedPause,
  EventSpanSegment,
  TimelineEvent,
  TimelinePositioningResult,
  TimelineStandalonePause,
} from '../types';

interface StackBlock {
  id: string;
  kind: 'event' | 'pause';
  laneKey: string;
  scheduledTopPx: number;
  stackHeightPx: number;
  sortIndex: number;
}

function continuationBlockId(id: string, segmentIndex: number): string {
  return `${id}::day-${segmentIndex}`;
}

/**
 * Empile les cartes par colonne-jour sans chevauchement. Avec des dates
 * réelles (`dayEndPx` = minuit), rien ne dépasse minuit : une carte qui y
 * arrive est coupée et sa suite (segments `index ≥ 1`) s'empile en haut de la
 * colonne du lendemain (`startsBeforeWindow` : seule la suite est dans la
 * fenêtre) ; une colonne trop pleine en fin de journée remonte ses
 * cartes au lieu de les pousser sous minuit.
 */
export function positionTimelineBlocks(
  scheduledEvents: TimelineEvent[],
  scheduledStandalonePauses: TimelineStandalonePause[],
  standalonePauseDayKeyById: ReadonlyMap<string, string | null>,
  canvasBaseHeight: number,
  dayEndPx: number | null,
): TimelinePositioningResult {
  // Hauteur d'un bloc posé à `topPx`, coupée à minuit.
  const clipToDayEnd = (heightPx: number, topPx: number, minHeightPx: number) => {
    if (dayEndPx === null) return heightPx;
    const availablePx = dayEndPx - Math.max(topPx, TIMELINE_VIEWPORT_TOP_INSET_PX);
    return Math.max(minHeightPx, Math.min(heightPx, availablePx));
  };

  const blocks: StackBlock[] = [];
  scheduledEvents.forEach((event) => {
    if (!event.startsBeforeWindow) blocks.push({
      id: event.item.id,
      kind: 'event',
      laneKey: event.spanSegments[0]?.dayKey ?? event.dayKey ?? '__single__',
      scheduledTopPx: event.scheduledTopPx,
      // The visible 32px frame (card) drives stacking so POI frames never
      // overlap, regardless of the event's temporal span height.
      stackHeightPx: clipToDayEnd(event.cardHeightPx, event.scheduledTopPx, RAIL_ITEM_HEIGHT_PX),
      sortIndex: event.sortIndex,
    });
    event.spanSegments.forEach((segment, index) => {
      if (index === 0 && !event.startsBeforeWindow) return;
      blocks.push({
        id: continuationBlockId(event.item.id, index),
        kind: 'event',
        laneKey: segment.dayKey ?? '__single__',
        scheduledTopPx: segment.scheduledTopPx,
        stackHeightPx: clipToDayEnd(
          Math.max(RAIL_ITEM_HEIGHT_PX, segment.pauseHeightPx),
          segment.scheduledTopPx,
          RAIL_ITEM_HEIGHT_PX,
        ),
        sortIndex: event.sortIndex,
      });
    });
  });
  scheduledStandalonePauses.forEach((pause) => {
    if (!pause.startsBeforeWindow) blocks.push({
      id: pause.id,
      kind: 'pause',
      laneKey: standalonePauseDayKeyById.get(pause.id) ?? '__single__',
      scheduledTopPx: pause.scheduledTopPx,
      stackHeightPx: clipToDayEnd(pause.heightPx, pause.scheduledTopPx, PAUSE_CHIP_MIN_HEIGHT_PX),
      sortIndex: pause.sortIndex,
    });
    pause.continuations.forEach((segment, index) => {
      blocks.push({
        id: continuationBlockId(pause.id, index + 1),
        kind: 'pause',
        laneKey: segment.dayKey ?? '__single__',
        scheduledTopPx: segment.scheduledTopPx,
        stackHeightPx: clipToDayEnd(
          Math.max(PAUSE_CHIP_MIN_HEIGHT_PX, segment.heightPx),
          segment.scheduledTopPx,
          PAUSE_CHIP_MIN_HEIGHT_PX,
        ),
        sortIndex: pause.sortIndex,
      });
    });
  });

  blocks.sort(
    (left, right) =>
      left.scheduledTopPx - right.scheduledTopPx
      || left.sortIndex - right.sortIndex
      || (left.kind === right.kind ? 0 : left.kind === 'event' ? -1 : 1),
  );

  const positionedTopById = new Map<string, number>();
  const blocksByLane = new Map<string, StackBlock[]>();
  const nextAvailableTopPxByLane = new Map<string, number>();

  blocks.forEach((block) => {
    const nextAvailableTopPx =
      nextAvailableTopPxByLane.get(block.laneKey) ?? TIMELINE_VIEWPORT_TOP_INSET_PX;
    const topPx = Math.max(block.scheduledTopPx, nextAvailableTopPx);
    positionedTopById.set(block.id, topPx);
    nextAvailableTopPxByLane.set(block.laneKey, topPx + block.stackHeightPx + TIMELINE_BLOCK_GAP_PX);
    const laneBlocks = blocksByLane.get(block.laneKey);
    if (laneBlocks) laneBlocks.push(block);
    else blocksByLane.set(block.laneKey, [block]);
  });

  if (dayEndPx !== null) {
    blocksByLane.forEach((laneBlocks) => {
      let limitPx = dayEndPx;
      for (let index = laneBlocks.length - 1; index >= 0; index -= 1) {
        const block = laneBlocks[index]!;
        const currentTopPx = positionedTopById.get(block.id) ?? block.scheduledTopPx;
        const topPx = Math.max(
          TIMELINE_VIEWPORT_TOP_INSET_PX,
          Math.min(currentTopPx, limitPx - block.stackHeightPx),
        );
        positionedTopById.set(block.id, topPx);
        limitPx = topPx - TIMELINE_BLOCK_GAP_PX;
      }
    });
  }

  // Hauteur retenue à l'empilement : une carte remontée avant minuit garde
  // cette hauteur (la recouper depuis sa nouvelle position la ferait grandir
  // sur la carte suivante).
  const stackHeightById = new Map(blocks.map((block) => [block.id, block.stackHeightPx] as const));
  let maxContentBottomPx = canvasBaseHeight + TIMELINE_VIEWPORT_TOP_INSET_PX;
  let firstTopPx: number | null = null;
  blocks.forEach((block) => {
    const topPx = positionedTopById.get(block.id) ?? block.scheduledTopPx;
    maxContentBottomPx = Math.max(maxContentBottomPx, topPx + block.stackHeightPx);
    if (firstTopPx === null || topPx < firstTopPx) firstTopPx = topPx;
  });

  const positionContinuation = (
    segment: EventSpanSegment,
    blockId: string,
    minHeightPx: number,
  ): EventSpanSegment => {
    const topPx = positionedTopById.get(blockId) ?? segment.scheduledTopPx;
    const stackHeightPx = stackHeightById.get(blockId) ?? minHeightPx;
    return {
      ...segment,
      topPx,
      heightPx: Math.max(stackHeightPx, clipToDayEnd(segment.heightPx, topPx, minHeightPx)),
      pauseHeightPx: segment.pauseHeightPx > 0
        ? Math.max(ATTACHED_PAUSE_HEIGHT_PX, Math.min(segment.pauseHeightPx, stackHeightPx))
        : 0,
    };
  };

  return {
    events: scheduledEvents.map((event) => {
      const positionedTopPx = positionedTopById.get(event.item.id) ?? event.scheduledTopPx;
      const cardHeightPx = Math.min(
        stackHeightById.get(event.item.id) ?? event.cardHeightPx,
        clipToDayEnd(event.cardHeightPx, positionedTopPx, RAIL_ITEM_HEIGHT_PX),
      );
      return {
        ...event,
        topPx: positionedTopPx,
        cardHeightPx,
        heightPx: Math.max(cardHeightPx, clipToDayEnd(event.heightPx, positionedTopPx, RAIL_ITEM_HEIGHT_PX)),
        attachedPauses: clipAttachedPauses(event.attachedPauses, cardHeightPx),
        spanSegments: event.spanSegments.map((segment, index) => (
          index === 0 && !event.startsBeforeWindow
            ? { ...segment, topPx: positionedTopPx }
            : positionContinuation(segment, continuationBlockId(event.item.id, index), RAIL_ITEM_HEIGHT_PX)
        )),
      };
    }),
    standalonePauses: scheduledStandalonePauses.map((pause) => {
      const topPx = positionedTopById.get(pause.id) ?? pause.scheduledTopPx;
      return {
        ...pause,
        topPx,
        heightPx: Math.min(
          stackHeightById.get(pause.id) ?? pause.heightPx,
          clipToDayEnd(pause.heightPx, topPx, PAUSE_CHIP_MIN_HEIGHT_PX),
        ),
        continuations: pause.continuations.map((segment, index) => (
          positionContinuation(segment, continuationBlockId(pause.id, index + 1), PAUSE_CHIP_MIN_HEIGHT_PX)
        )),
      };
    }),
    canvasHeight: maxContentBottomPx + TIMELINE_VIEWPORT_BOTTOM_INSET_PX,
    firstVisibleTopPx: firstTopPx,
  };
}

/** La colonne de pauses d'une carte coupée à minuit s'arrête avec la carte. */
function clipAttachedPauses(pauses: AttachedPause[], cardHeightPx: number): AttachedPause[] {
  let remainingPx = cardHeightPx;
  return pauses.map((pause, index) => {
    if (index > 0) remainingPx -= TIMELINE_BLOCK_GAP_PX;
    const heightPx = Math.max(ATTACHED_PAUSE_HEIGHT_PX, Math.min(pause.heightPx, remainingPx));
    remainingPx -= heightPx;
    return heightPx === pause.heightPx ? pause : { ...pause, heightPx };
  });
}
