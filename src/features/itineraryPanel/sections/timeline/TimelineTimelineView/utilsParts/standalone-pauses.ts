import { PAUSE_CHIP_MIN_HEIGHT_PX } from '../constants';
import type { TimedIntervalPause, TimedTimelineItem, TimelineStandalonePause } from '../types';
import { resolveVisualDurationMin } from './format';

export function buildScheduledStandalonePauses(
  manualPauseItems: TimedTimelineItem[],
  intervalPauseItems: TimedIntervalPause[],
  pixelsPerMinute: number,
  startMinutes: number,
): TimelineStandalonePause[] {
  const manualPauses = manualPauseItems.map((pause) => ({
    id: pause.item.id,
    label: pause.item.label,
    source: 'manual' as const,
    distanceKm: pause.distanceKm,
    scheduledTopPx: (pause.minuteOfDay - startMinutes) * pixelsPerMinute,
    topPx: (pause.minuteOfDay - startMinutes) * pixelsPerMinute,
    durationMin: pause.item.durationMin ?? 0,
    visible: pause.item.visible !== false,
    heightPx: resolveStandalonePauseHeightPx(pause.item.durationMin ?? 0, pixelsPerMinute),
    sortIndex: pause.sortIndex,
    dayKey: pause.dayKey,
  }));

  const intervalPauses = intervalPauseItems.map((pause) => ({
    id: pause.id,
    label: pause.label,
    source: 'interval' as const,
    distanceKm: pause.distanceKm,
    scheduledTopPx: (pause.minuteOfDay - startMinutes) * pixelsPerMinute,
    topPx: (pause.minuteOfDay - startMinutes) * pixelsPerMinute,
    durationMin: pause.durationMin,
    visible: pause.visible,
    heightPx: resolveStandalonePauseHeightPx(pause.durationMin, pixelsPerMinute),
    sortIndex: pause.sortIndex,
    dayKey: pause.dayKey,
  }));

  return [...manualPauses, ...intervalPauses].sort(
    (left, right) => left.scheduledTopPx - right.scheduledTopPx || left.sortIndex - right.sortIndex,
  );
}

function resolveStandalonePauseHeightPx(durationMin: number, pixelsPerMinute: number): number {
  const resolvedDurationMin = resolveVisualDurationMin(durationMin);
  if (resolvedDurationMin <= 0) return PAUSE_CHIP_MIN_HEIGHT_PX;
  return Math.max(PAUSE_CHIP_MIN_HEIGHT_PX, resolvedDurationMin * pixelsPerMinute);
}