import type { RhythmState, TimelineItem } from '../../../../types';
import type { AttachedPause, PauseAttachmentState, TimedTimelineItem } from '../types';
import { resolveFavoritePoiPauseDurationMin } from './schedule-stops';

export function buildPauseAttachment(
  filteredPrimaryItems: TimedTimelineItem[],
  rhythm?: RhythmState,
): PauseAttachmentState {
  const attachedByEventId = new Map<string, Array<Omit<AttachedPause, 'heightPx'>>>();

  filteredPrimaryItems.forEach((entry) => {
    const attachedPauses: Array<Omit<AttachedPause, 'heightPx'>> = [];
    const favoritePoiPause = buildFavoritePoiPause(entry.item, rhythm);
    if (favoritePoiPause) attachedPauses.push(favoritePoiPause);
    attachedByEventId.set(entry.item.id, attachedPauses);
  });

  return {
    attachedByEventId,
    unattachedPauses: [],
  };
}

function buildFavoritePoiPause(
  item: TimelineItem,
  rhythm?: RhythmState,
): Omit<AttachedPause, 'heightPx'> | null {
  const durationMin = resolveFavoritePoiPauseDurationMin(item, rhythm);
  if (durationMin <= 0) return null;

  return {
    id: `poi-pause-${item.id}`,
    durationMin,
    visible: item.visible !== false,
  };
}