import { PAUSE_CHIP_MIN_HEIGHT_PX } from '../constants';
import type { TimedAutoPause, TimedTimelineItem, TimelineStandalonePause } from '../types';
import { resolveVisualDurationMin } from './format';

export function buildScheduledStandalonePauses(
  manualPauseItems: TimedTimelineItem[],
  autoPauseItems: TimedAutoPause[],
  primaryItems: TimedTimelineItem[],
  pixelsPerMinute: number,
  startMinutes: number,
): TimelineStandalonePause[] {
  const manualPauses = manualPauseItems.map((pause) => ({
    id: pause.item.id,
    label: pause.item.label,
    source: 'manual' as const,
    distanceKm: pause.distanceKm,
    elapsedSeconds: pause.elapsedSeconds,
    scheduledTopPx: (pause.minuteOfDay - startMinutes) * pixelsPerMinute,
    topPx: (pause.minuteOfDay - startMinutes) * pixelsPerMinute,
    durationMin: pause.item.durationMin ?? 0,
    toNextSeconds: resolveSecondsToNextCheckpoint(primaryItems, pause.elapsedSeconds),
    visible: pause.item.visible !== false,
    heightPx: resolveStandalonePauseHeightPx(pause.item.durationMin ?? 0, pixelsPerMinute),
    sortIndex: pause.sortIndex,
    dayKey: pause.dayKey,
  }));

  const autoPauses = autoPauseItems.map((pause) => ({
    id: pause.id,
    label: pause.label,
    source: pause.source,
    poiCategory: pause.poiCategory,
    distanceKm: pause.distanceKm,
    elapsedSeconds: pause.elapsedSeconds,
    scheduledTopPx: (pause.minuteOfDay - startMinutes) * pixelsPerMinute,
    topPx: (pause.minuteOfDay - startMinutes) * pixelsPerMinute,
    durationMin: pause.durationMin,
    toNextSeconds: resolveSecondsToNextCheckpoint(primaryItems, pause.elapsedSeconds),
    visible: pause.visible,
    heightPx: resolveStandalonePauseHeightPx(pause.durationMin, pixelsPerMinute),
    sortIndex: pause.sortIndex,
    dayKey: pause.dayKey,
  }));

  return [...manualPauses, ...autoPauses].sort(
    (left, right) => left.scheduledTopPx - right.scheduledTopPx || left.sortIndex - right.sortIndex,
  );
}

function resolveStandalonePauseHeightPx(durationMin: number, pixelsPerMinute: number): number {
  const resolvedDurationMin = resolveVisualDurationMin(durationMin);
  if (resolvedDurationMin <= 0) return PAUSE_CHIP_MIN_HEIGHT_PX;
  return Math.max(PAUSE_CHIP_MIN_HEIGHT_PX, resolvedDurationMin * pixelsPerMinute);
}

function resolveSecondsToNextCheckpoint(
  entries: TimedTimelineItem[],
  currentElapsedSeconds: number,
): number | null {
  for (let index = 0; index < entries.length; index += 1) {
    const candidate = entries[index];
    if (!candidate) continue;
    if (candidate.elapsedSeconds <= currentElapsedSeconds) continue;
    return Math.max(0, candidate.elapsedSeconds - currentElapsedSeconds);
  }

  return null;
}