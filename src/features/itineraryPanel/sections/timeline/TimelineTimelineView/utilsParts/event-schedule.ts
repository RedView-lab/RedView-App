import type { TimelineItem } from '../../../../types';
import {
  ATTACHED_PAUSE_HEIGHT_PX,
  MINUTES_PER_DAY,
  RAIL_ITEM_HEIGHT_PX,
  TIMELINE_BLOCK_GAP_PX,
} from '../constants';
import type {
  AttachedPause,
  EventSpanSegment,
  PauseAttachmentState,
  StartReference,
  TimedTimelineItem,
  TimelineEvent,
} from '../types';
import { addDays, getMinuteOfDay, resolveVisualDurationMin, toDayKey } from './format';

export function buildVisibleMinuteBounds(
  filteredPrimaryItems: TimedTimelineItem[],
  filteredPauseItems: TimedTimelineItem[],
  unattachedAutoPauseItems: PauseAttachmentState['unattachedPauses'],
  pauseAttachment: PauseAttachmentState,
  displayDays: Date[],
  reference: StartReference,
): number[] {
  const bounds: number[] = [];

  filteredPrimaryItems.forEach((entry, index) => {
    const attachedPauses = pauseAttachment.attachedByEventId.get(entry.item.id) ?? [];
    const spanToNextSeconds = resolveSecondsToNextCheckpoint(filteredPrimaryItems, index);
    const durationMin = resolveEventDisplayDurationMin(entry.item, attachedPauses, spanToNextSeconds);
    collectVisibleMinuteBounds(
      bounds,
      entry.date,
      entry.minuteOfDay,
      durationMin,
      displayDays,
      reference.hasRealDate,
    );
  });

  filteredPauseItems.forEach((entry) => {
    collectVisibleMinuteBounds(
      bounds,
      entry.date,
      entry.minuteOfDay,
      resolveVisualDurationMin(entry.item.durationMin ?? 0),
      displayDays,
      reference.hasRealDate,
    );
  });

  unattachedAutoPauseItems.forEach((entry) => {
    collectVisibleMinuteBounds(
      bounds,
      entry.date,
      entry.minuteOfDay,
      resolveVisualDurationMin(entry.durationMin),
      displayDays,
      reference.hasRealDate,
    );
  });

  const finiteBounds = bounds.filter((value) => Number.isFinite(value));
  return finiteBounds.length > 0 ? finiteBounds : [reference.startMinutes];
}

export function buildScheduledEvents(
  filteredPrimaryItems: TimedTimelineItem[],
  pauseAttachment: PauseAttachmentState,
  pixelsPerMinute: number,
  displayDays: Date[],
  reference: StartReference,
  startMinutes: number,
): TimelineEvent[] {
  return filteredPrimaryItems.map((entry, index): TimelineEvent => {
    const rawAttachedPauses = pauseAttachment.attachedByEventId.get(entry.item.id) ?? [];
    const attachedPauses = rawAttachedPauses.map((pause) => ({
      ...pause,
      heightPx: resolveAttachedPauseHeightPx(pause.durationMin, pixelsPerMinute),
    }));
    const toNextSeconds = resolveSecondsToNextPoi(filteredPrimaryItems, index);
    const spanToNextSeconds = resolveSecondsToNextCheckpoint(filteredPrimaryItems, index);
    const displayDurationMin = resolveEventDisplayDurationMin(
      entry.item,
      rawAttachedPauses,
      spanToNextSeconds,
    );
    const spanSegments = buildEventSpanSegments(
      entry.dayKey,
      entry.date,
      entry.minuteOfDay,
      displayDurationMin,
      displayDays,
      reference.hasRealDate,
      startMinutes,
      pixelsPerMinute,
    );
    const firstSegment = spanSegments[0] ?? null;
    const scheduledTopPx = firstSegment?.topPx ?? (entry.minuteOfDay - startMinutes) * pixelsPerMinute;
    const pauseColumnHeightPx = attachedPauses.reduce(
      (totalHeight, pause, pauseIndex) => (
        totalHeight + pause.heightPx + (pauseIndex > 0 ? TIMELINE_BLOCK_GAP_PX : 0)
      ),
      0,
    );
    const firstSegmentHeightPx = firstSegment?.heightPx ?? 0;
    // The visible frame (card) is a fixed 32px Figma bar — it never grows with
    // the event's temporal duration, only to fit attached pauses.
    const cardHeightPx = Math.max(RAIL_ITEM_HEIGHT_PX, pauseColumnHeightPx);
    const heightPx = Math.max(cardHeightPx, pauseColumnHeightPx, firstSegmentHeightPx);

    return {
      ...entry,
      scheduledTopPx,
      topPx: scheduledTopPx,
      attachedPauses,
      toNextSeconds,
      displayDurationMin,
      cardHeightPx,
      heightPx,
      spanSegments,
    };
  });
}

function resolveSecondsToNextPoi(entries: TimedTimelineItem[], currentIndex: number): number | null {
  const currentEntry = entries[currentIndex];
  if (!currentEntry) return null;

  for (let index = currentIndex + 1; index < entries.length; index += 1) {
    const candidate = entries[index];
    if (!candidate || candidate.item.kind !== 'poi') continue;
    if (candidate.elapsedSeconds <= currentEntry.elapsedSeconds) continue;
    return Math.max(0, candidate.elapsedSeconds - currentEntry.elapsedSeconds);
  }

  return null;
}

function resolveSecondsToNextCheckpoint(
  entries: TimedTimelineItem[],
  currentIndex: number,
): number | null {
  const currentEntry = entries[currentIndex];
  if (!currentEntry) return null;

  for (let index = currentIndex + 1; index < entries.length; index += 1) {
    const candidate = entries[index];
    if (!candidate) continue;
    if (candidate.elapsedSeconds <= currentEntry.elapsedSeconds) continue;
    return Math.max(0, candidate.elapsedSeconds - currentEntry.elapsedSeconds);
  }

  return null;
}

function resolveAttachedPauseDurationMin(pauses: Array<Pick<AttachedPause, 'durationMin'>>): number {
  return pauses.reduce((total, pause) => total + Math.max(0, pause.durationMin), 0);
}

function isOvernightPoi(item: TimelineItem): boolean {
  return item.kind === 'poi' && (item.poiCategory === 'hotels' || item.poiCategory === 'refuges');
}

function resolveEventDisplayDurationMin(
  item: TimelineItem,
  attachedPauses: Array<Pick<AttachedPause, 'durationMin'>>,
  spanToNextSeconds: number | null,
): number {
  const attachedPauseDurationMin = resolveAttachedPauseDurationMin(attachedPauses);
  let durationMin = Math.max(attachedPauseDurationMin, item.durationMin ?? 0);

  if (
    isOvernightPoi(item)
    && spanToNextSeconds !== null
    && Number.isFinite(spanToNextSeconds)
    && spanToNextSeconds > 0
  ) {
    durationMin = Math.max(durationMin, spanToNextSeconds / 60);
  }

  return resolveVisualDurationMin(durationMin);
}

function collectVisibleMinuteBounds(
  bounds: number[],
  startDate: Date | null,
  minuteOfDay: number,
  durationMin: number,
  displayDays: Date[],
  hasRealDate: boolean,
) {
  bounds.push(minuteOfDay);
  if (durationMin <= 0) return;

  if (!hasRealDate || !startDate) {
    bounds.push(minuteOfDay + durationMin);
    return;
  }

  const endDate = new Date(startDate.getTime() + durationMin * 60_000);
  displayDays.forEach((day) => {
    const dayStart = new Date(day.getFullYear(), day.getMonth(), day.getDate(), 0, 0, 0, 0);
    const dayEnd = addDays(dayStart, 1);
    const overlapStartMs = Math.max(startDate.getTime(), dayStart.getTime());
    const overlapEndMs = Math.min(endDate.getTime(), dayEnd.getTime());
    if (overlapEndMs <= overlapStartMs) return;

    bounds.push(getMinuteOfDay(new Date(overlapStartMs)));
    bounds.push(
      overlapEndMs === dayEnd.getTime()
        ? MINUTES_PER_DAY
        : getMinuteOfDay(new Date(overlapEndMs)),
    );
  });
}

function buildEventSpanSegments(
  dayKey: string | null,
  startDate: Date | null,
  minuteOfDay: number,
  durationMin: number,
  displayDays: Date[],
  hasRealDate: boolean,
  startMinutes: number,
  pixelsPerMinute: number,
): EventSpanSegment[] {
  if (durationMin <= 0) return [];

  if (!hasRealDate || !startDate) {
    return [{
      dayKey,
      topPx: (minuteOfDay - startMinutes) * pixelsPerMinute,
      heightPx: durationMin * pixelsPerMinute,
    }];
  }

  const endDate = new Date(startDate.getTime() + durationMin * 60_000);
  const segments: EventSpanSegment[] = [];

  displayDays.forEach((day) => {
    const currentDayKey = toDayKey(day);
    const dayStart = new Date(day.getFullYear(), day.getMonth(), day.getDate(), 0, 0, 0, 0);
    const dayEnd = addDays(dayStart, 1);
    const overlapStartMs = Math.max(startDate.getTime(), dayStart.getTime());
    const overlapEndMs = Math.min(endDate.getTime(), dayEnd.getTime());
    if (overlapEndMs <= overlapStartMs) return;

    const segmentStartMinute = getMinuteOfDay(new Date(overlapStartMs));
    const rawDurationMin = (overlapEndMs - overlapStartMs) / 60_000;
    const segmentHeightMin = Math.max(resolveVisualDurationMin(rawDurationMin), rawDurationMin);
    segments.push({
      dayKey: currentDayKey,
      topPx: (segmentStartMinute - startMinutes) * pixelsPerMinute,
      heightPx: segmentHeightMin * pixelsPerMinute,
    });
  });

  return segments;
}

function resolveAttachedPauseHeightPx(durationMin: number, pixelsPerMinute: number): number {
  const resolvedDurationMin = resolveVisualDurationMin(durationMin);
  if (resolvedDurationMin <= 0) return ATTACHED_PAUSE_HEIGHT_PX;
  return Math.max(ATTACHED_PAUSE_HEIGHT_PX, resolvedDurationMin * pixelsPerMinute);
}
