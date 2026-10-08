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
import { addDays, getMinuteOfDay, minuteToCanvasTopPx, resolveVisualDurationMin, toDayKey } from './format';

export function buildScheduledEvents(
  filteredPrimaryItems: TimedTimelineItem[],
  pauseAttachment: PauseAttachmentState,
  pixelsPerMinute: number,
  displayDays: Date[],
  reference: StartReference,
  startMinutes: number,
): TimelineEvent[] {
  const displayDayKeys = new Set(displayDays.map((day) => toDayKey(day)));
  return filteredPrimaryItems.map((entry, index): TimelineEvent => {
    const rawAttachedPauses = pauseAttachment.attachedByEventId.get(entry.item.id) ?? [];
    const attachedPauses = rawAttachedPauses.map((pause) => ({
      ...pause,
      heightPx: resolveAttachedPauseHeightPx(pause.durationMin, pixelsPerMinute),
    }));
    const toNextSeconds = resolveRideSecondsToNextCheckpoint(filteredPrimaryItems, index);
    // Une nuit à l'hôtel s'étend jusqu'à l'arrivée suivante, pauses comprises.
    const spanToNextSeconds = resolveSecondsToNextCheckpoint(filteredPrimaryItems, index);
    const displayDurationMin = resolveEventDisplayDurationMin(
      entry.item,
      rawAttachedPauses,
      spanToNextSeconds,
    );
    const spanSegments = buildDaySegments(
      entry.dayKey,
      entry.date,
      entry.minuteOfDay,
      displayDurationMin,
      resolveAttachedPauseDurationMin(rawAttachedPauses),
      displayDays,
      reference.hasRealDate,
      startMinutes,
      pixelsPerMinute,
    );
    const firstSegment = spanSegments[0] ?? null;
    const scheduledTopPx = firstSegment?.topPx ?? minuteToCanvasTopPx(entry.minuteOfDay, startMinutes, pixelsPerMinute);
    const pauseColumnHeightPx = attachedPauses.reduce(
      (totalHeight, pause, pauseIndex) => (
        totalHeight + pause.heightPx + (pauseIndex > 0 ? TIMELINE_BLOCK_GAP_PX : 0)
      ),
      0,
    );
    const firstSegmentHeightPx = firstSegment?.heightPx ?? 0;
    // Le cadre visible (carte) est une barre Figma fixe de 32px — elle ne grandit
    // jamais avec la durée de l'événement, seulement pour contenir les pauses attachées.
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
      startsBeforeWindow: reference.hasRealDate
        && entry.dayKey !== null
        && !displayDayKeys.has(entry.dayKey),
    };
  }).filter((event) => !event.startsBeforeWindow || event.spanSegments.length > 0);
}

/**
 * Point suivant dans le temps : le premier qui arrive après celui-ci, quel
 * que soit son rang dans la feuille de route (des points importés ou ajoutés
 * après coup n'y sont pas forcément rangés par distance).
 */
export function findNextTimedEntry<T extends Pick<TimedTimelineItem, 'elapsedSeconds'>>(
  entries: readonly T[],
  afterElapsedSeconds: number,
): T | null {
  let next: T | null = null;
  for (const candidate of entries) {
    if (candidate.elapsedSeconds <= afterElapsedSeconds) continue;
    if (!next || candidate.elapsedSeconds < next.elapsedSeconds) next = candidate;
  }
  return next;
}

function resolveSecondsToNextCheckpoint(
  entries: TimedTimelineItem[],
  currentIndex: number,
): number | null {
  const currentEntry = entries[currentIndex];
  if (!currentEntry) return null;
  const next = findNextTimedEntry(entries, currentEntry.elapsedSeconds);
  return next ? Math.max(0, next.elapsedSeconds - currentEntry.elapsedSeconds) : null;
}

/**
 * « Jusqu'au suivant » : temps de roulage jusqu'au prochain point affiché,
 * sans la pause prise ici — même définition que la colonne « Temps jusqu'au
 * prochain élément » de la feuille de route.
 */
function resolveRideSecondsToNextCheckpoint(
  entries: TimedTimelineItem[],
  currentIndex: number,
): number | null {
  const currentEntry = entries[currentIndex];
  if (!currentEntry) return null;
  const next = findNextTimedEntry(entries, currentEntry.elapsedSeconds);
  return next ? Math.max(0, next.rideElapsedSeconds - currentEntry.rideElapsedSeconds) : null;
}

function resolveAttachedPauseDurationMin(pauses: Array<Pick<AttachedPause, 'durationMin'>>): number {
  return pauses.reduce((total, pause) => total + Math.max(0, pause.durationMin), 0);
}

function isOvernightPoi(item: TimelineItem): boolean {
  return (item.kind === 'poi' || item.kind === 'waypoint') && (item.poiCategory === 'hotels' || item.poiCategory === 'refuges');
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

/**
 * Découpe [début, début + durée] par jour affiché : un bloc qui passe minuit
 * continue en haut de la colonne du lendemain. `pauseDurationMin` (pauses
 * attachées, depuis le début) donne la part de pause de chaque segment.
 */
export function buildDaySegments(
  dayKey: string | null,
  startDate: Date | null,
  minuteOfDay: number,
  durationMin: number,
  pauseDurationMin: number,
  displayDays: Date[],
  hasRealDate: boolean,
  startMinutes: number,
  pixelsPerMinute: number,
): EventSpanSegment[] {
  if (durationMin <= 0) return [];

  if (!hasRealDate || !startDate) {
    const topPx = minuteToCanvasTopPx(minuteOfDay, startMinutes, pixelsPerMinute);
    return [{
      dayKey,
      scheduledTopPx: topPx,
      topPx,
      heightPx: durationMin * pixelsPerMinute,
      pauseHeightPx: pauseDurationMin * pixelsPerMinute,
    }];
  }

  const endDate = new Date(startDate.getTime() + durationMin * 60_000);
  const pauseEndMs = startDate.getTime() + Math.max(0, pauseDurationMin) * 60_000;
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
    const segmentHeightMin = Math.min(
      Math.max(resolveVisualDurationMin(rawDurationMin), rawDurationMin),
      MINUTES_PER_DAY - segmentStartMinute,
    );
    const pauseMin = Math.max(0, (Math.min(pauseEndMs, dayEnd.getTime()) - overlapStartMs) / 60_000);
    const topPx = minuteToCanvasTopPx(segmentStartMinute, startMinutes, pixelsPerMinute);
    segments.push({
      dayKey: currentDayKey,
      scheduledTopPx: topPx,
      topPx,
      heightPx: segmentHeightMin * pixelsPerMinute,
      pauseHeightPx: Math.min(pauseMin, segmentHeightMin) * pixelsPerMinute,
    });
  });

  return segments;
}

function resolveAttachedPauseHeightPx(durationMin: number, pixelsPerMinute: number): number {
  const resolvedDurationMin = resolveVisualDurationMin(durationMin);
  if (resolvedDurationMin <= 0) return ATTACHED_PAUSE_HEIGHT_PX;
  return Math.max(ATTACHED_PAUSE_HEIGHT_PX, resolvedDurationMin * pixelsPerMinute);
}
