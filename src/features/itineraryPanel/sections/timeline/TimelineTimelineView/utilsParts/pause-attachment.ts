import type { AttachedPause, PauseAttachmentState, TimedAutoPause, TimedTimelineItem } from '../types';

export function buildPauseAttachment(
  filteredPrimaryItems: TimedTimelineItem[],
  autoPauseItems: TimedAutoPause[],
): PauseAttachmentState {
  const attachedByEventId = new Map<string, Array<Omit<AttachedPause, 'heightPx'>>>();

  filteredPrimaryItems.forEach((entry) => {
    attachedByEventId.set(entry.item.id, []);
  });

  const unattachedPauses: TimedAutoPause[] = [];

  autoPauseItems.forEach((pause) => {
    if (pause.source === 'favorite-poi' && pause.attachedToItemId) {
      const attachedPauses = attachedByEventId.get(pause.attachedToItemId) ?? [];
      attachedPauses.push({
        id: pause.id,
        durationMin: pause.durationMin,
        visible: pause.visible,
        source: 'favorite-poi',
      });
      attachedByEventId.set(pause.attachedToItemId, attachedPauses);
      return;
    }

    unattachedPauses.push(pause);
  });

  return {
    attachedByEventId,
    unattachedPauses,
  };
}
