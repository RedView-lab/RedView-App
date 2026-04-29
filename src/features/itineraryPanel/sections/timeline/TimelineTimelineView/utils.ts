import { elapsedSecondsAtDistance } from '@/features/centerPanel/flyover/playback';
import type { PredictionResult } from '@/features/fitPredictor';
import type { RhythmState, TimelineItem, TimelineRailConfig } from '../../../types';
import { DEFAULT_TIMELINE_RAIL } from '../../../types';
import {
  ATTACHED_PAUSE_HEIGHT_PX,
  DAY_WINDOW_DAYS,
  DEFAULT_START_MINUTES,
  KM_MARKER_MIN_STEP,
  MIN_RENDER_DURATION_MIN,
  MINUTES_PER_DAY,
  PAUSE_CHIP_MIN_HEIGHT_PX,
  RAIL_ITEM_HEIGHT_PX,
  TIMELINE_BLOCK_GAP_PX,
  TIMELINE_VIEWPORT_BOTTOM_INSET_PX,
  TIMELINE_VIEWPORT_TOP_INSET_PX,
  WEEKDAY_SHORT,
} from './constants';
import type {
  AttachedPause,
  EventSpanSegment,
  KmMarker,
  PauseAttachmentState,
  StartReference,
  TimedTimelineItem,
  TimelineEvent,
  TimelinePositioningResult,
  TimelineStandalonePause,
} from './types';

export function parseStartReference(rhythm?: RhythmState): StartReference {
  const startTime = rhythm?.startTime?.trim() ?? '';
  const startMinutes = parseTimeMinutes(startTime) ?? DEFAULT_START_MINUTES;
  const startDate = rhythm?.startDate?.trim() ?? '';

  if (startDate && startTime) {
    const date = parseDateTime(startDate, startTime);
    if (date) {
      return {
        reference: date,
        hasRealDate: true,
        startMinutes,
      };
    }
  }

  if (startTime) {
    return {
      reference: new Date(2000, 0, 1, Math.floor(startMinutes / 60), startMinutes % 60),
      hasRealDate: false,
      startMinutes,
    };
  }

  return {
    reference: null,
    hasRealDate: false,
    startMinutes: DEFAULT_START_MINUTES,
  };
}

export function parseDateTime(dateValue: string, timeValue: string): Date | null {
  const dateMatch = /^(\d{4})-(\d{2})-(\d{2})$/u.exec(dateValue);
  const timeMatch = /^(\d{1,2}):(\d{2})$/u.exec(timeValue);
  if (!dateMatch || !timeMatch) return null;

  const date = new Date(
    Number(dateMatch[1]),
    Number(dateMatch[2]) - 1,
    Number(dateMatch[3]),
    Number(timeMatch[1]),
    Number(timeMatch[2]),
    0,
    0,
  );
  return Number.isNaN(date.getTime()) ? null : date;
}

export function parseTimeMinutes(value: string | null | undefined): number | null {
  if (!value) return null;
  const match = /^(\d{1,2}):(\d{2})$/u.exec(value.trim());
  if (!match) return null;

  const hours = Number(match[1]);
  const minutes = Number(match[2]);
  if (!Number.isFinite(hours) || !Number.isFinite(minutes)) return null;
  return hours * 60 + minutes;
}

export function toDayKey(date: Date): string {
  return [
    date.getFullYear(),
    String(date.getMonth() + 1).padStart(2, '0'),
    String(date.getDate()).padStart(2, '0'),
  ].join('-');
}

export function parseDayKey(dayKey: string): Date | null {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/u.exec(dayKey);
  if (!match) return null;
  const date = new Date(Number(match[1]), Number(match[2]) - 1, Number(match[3]));
  return Number.isNaN(date.getTime()) ? null : date;
}

export function addDays(date: Date, days: number): Date {
  const result = new Date(date);
  result.setDate(result.getDate() + days);
  return result;
}

export function buildDayWindow(anchor: Date): Date[] {
  const start = addDays(anchor, -3);
  return Array.from({ length: DAY_WINDOW_DAYS }, (_, index) => addDays(start, index));
}

export function formatDayLabel(date: Date): string {
  return WEEKDAY_SHORT[date.getDay()] ?? '';
}

export function formatDistanceLabel(distanceKm: number): string {
  if (!Number.isFinite(distanceKm)) return '--';
  return `${distanceKm.toFixed(1)} km`;
}

export function formatLegDuration(seconds: number | null): string {
  if (seconds === null || !Number.isFinite(seconds)) return '--';
  const totalMinutes = Math.max(0, Math.round(seconds / 60));
  const hours = Math.floor(totalMinutes / 60);
  const minutes = totalMinutes % 60;
  if (hours <= 0) return `${minutes}min`;
  return `${String(hours).padStart(2, '0')}h${String(minutes).padStart(2, '0')}`;
}

export function formatPauseDuration(minutes: number): string {
  if (!Number.isFinite(minutes)) return '--';
  if (minutes < 60) return `${Math.max(1, Math.round(minutes))}min`;
  const hours = Math.floor(minutes / 60);
  const remainder = minutes % 60;
  return remainder > 0 ? `${hours}h${String(remainder).padStart(2, '0')}` : `${hours}h`;
}

export function formatHourLabel(hour: number, isBoundary: boolean): string {
  const date = new Date(2000, 0, 1, hour, 0, 0, 0);
  if (isBoundary) {
    return date
      .toLocaleTimeString('en-US', { hour: 'numeric', hour12: true })
      .replace('\u202f', ' ');
  }
  return `${hour}:00`;
}

export function getMinuteOfDay(date: Date): number {
  return date.getHours() * 60 + date.getMinutes() + date.getSeconds() / 60;
}

export function resolveVisualDurationMin(durationMin: number | null | undefined): number {
  if (durationMin === null || durationMin === undefined || !Number.isFinite(durationMin) || durationMin <= 0) {
    return 0;
  }
  return Math.max(MIN_RENDER_DURATION_MIN, durationMin);
}

export function resolveMarkerKmStep(
  config?: Partial<TimelineRailConfig>,
  markerStepKm?: number,
): number {
  if (Number.isFinite(markerStepKm) && markerStepKm !== undefined && markerStepKm > 0) {
    return Math.max(5, Math.round(markerStepKm / 5) * 5);
  }
  const kmPerRow = config?.kmPerRow ?? DEFAULT_TIMELINE_RAIL.kmPerRow;
  const rawStep = Math.max(KM_MARKER_MIN_STEP, kmPerRow * 5);
  return Math.ceil(rawStep / 5) * 5;
}

export function resolveTotalDistanceM(
  items: TimelineItem[],
  prediction?: PredictionResult | null,
): number {
  const itemDistanceM = items.reduce(
    (maxDistanceM, item) => Math.max(maxDistanceM, (item.distanceKm ?? 0) * 1000),
    0,
  );
  return Math.max(prediction?.total_distance_m ?? 0, itemDistanceM);
}

export function buildTimedItems(
  items: TimelineItem[],
  prediction: PredictionResult | null | undefined,
  reference: StartReference,
): TimedTimelineItem[] {
  const totalDistanceM = resolveTotalDistanceM(items, prediction);

  return items
    .filter((item) => item.distanceKm !== null)
    .map((item, sortIndex) => {
      const distanceKm = item.distanceKm ?? 0;
      const distanceM = distanceKm * 1000;
      const elapsedSeconds =
        elapsedSecondsAtDistance(prediction, distanceM, totalDistanceM) ??
        estimateElapsedSeconds(distanceKm);
      const date = reference.reference
        ? new Date(reference.reference.getTime() + elapsedSeconds * 1000)
        : null;
      const minuteOfDay = date
        ? getMinuteOfDay(date)
        : reference.startMinutes + elapsedSeconds / 60;

      return {
        item,
        sortIndex,
        distanceKm,
        elapsedSeconds,
        minuteOfDay,
        date,
        dayKey: date && reference.hasRealDate ? toDayKey(date) : null,
      };
    })
    .sort(
      (left, right) =>
        left.elapsedSeconds - right.elapsedSeconds ||
        left.distanceKm - right.distanceKm ||
        left.sortIndex - right.sortIndex,
    );
}

export function buildPauseAttachment(
  filteredPrimaryItems: TimedTimelineItem[],
  filteredPauseItems: TimedTimelineItem[],
  rhythm?: RhythmState,
): PauseAttachmentState {
  const usedPauseIds = new Set<string>();
  const attachedByEventId = new Map<string, Array<Omit<AttachedPause, 'heightPx'>>>();

  filteredPrimaryItems.forEach((entry) => {
    const attachedPauses: Array<Omit<AttachedPause, 'heightPx'>> = [];
    const favoritePoiPause = buildFavoritePoiPause(entry.item, rhythm);
    if (favoritePoiPause) attachedPauses.push(favoritePoiPause);

    if (entry.item.kind !== 'start' && entry.item.kind !== 'end') {
      filteredPauseItems.forEach((pause) => {
        if (usedPauseIds.has(pause.item.id)) return;
        if (Math.abs(pause.distanceKm - entry.distanceKm) > 0.15) return;
        usedPauseIds.add(pause.item.id);
        attachedPauses.push({
          id: pause.item.id,
          durationMin: pause.item.durationMin ?? 0,
          visible: pause.item.visible !== false,
        });
      });
    }

    attachedByEventId.set(entry.item.id, attachedPauses);
  });

  return {
    attachedByEventId,
    unattachedPauses: filteredPauseItems.filter((pause) => !usedPauseIds.has(pause.item.id)),
  };
}

export function buildVisibleMinuteBounds(
  filteredPrimaryItems: TimedTimelineItem[],
  filteredPauseItems: TimedTimelineItem[],
  pauseAttachment: PauseAttachmentState,
  displayDays: Date[],
  reference: StartReference,
): number[] {
  const bounds = [reference.startMinutes];

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

  return bounds.filter((value) => Number.isFinite(value));
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
      (totalHeight, pause, pauseIndex) =>
        totalHeight + pause.heightPx + (pauseIndex > 0 ? TIMELINE_BLOCK_GAP_PX : 0),
      0,
    );
    const firstSegmentHeightPx = firstSegment?.heightPx ?? 0;
    const cardHeightPx = Math.max(RAIL_ITEM_HEIGHT_PX, pauseColumnHeightPx, firstSegmentHeightPx);
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

export function buildScheduledStandalonePauses(
  pauseAttachment: PauseAttachmentState,
  pixelsPerMinute: number,
  startMinutes: number,
): TimelineStandalonePause[] {
  return pauseAttachment.unattachedPauses.map((pause) => ({
    id: pause.item.id,
    scheduledTopPx: (pause.minuteOfDay - startMinutes) * pixelsPerMinute,
    topPx: (pause.minuteOfDay - startMinutes) * pixelsPerMinute,
    durationMin: pause.item.durationMin ?? 0,
    visible: pause.item.visible !== false,
    heightPx: resolveStandalonePauseHeightPx(pause.item.durationMin ?? 0, pixelsPerMinute),
    sortIndex: pause.sortIndex,
  }));
}

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
    heightPx: number;
    sortIndex: number;
  }> = [
    ...scheduledEvents.map((event) => ({
      id: event.item.id,
      kind: 'event' as const,
      laneKey: event.spanSegments[0]?.dayKey ?? event.dayKey ?? '__single__',
      scheduledTopPx: event.scheduledTopPx,
      heightPx: event.heightPx,
      sortIndex: event.sortIndex,
    })),
    ...scheduledStandalonePauses.map((pause) => ({
      id: pause.id,
      kind: 'pause' as const,
      laneKey: standalonePauseDayKeyById.get(pause.id) ?? '__single__',
      scheduledTopPx: pause.scheduledTopPx,
      heightPx: pause.heightPx,
      sortIndex: pause.sortIndex,
    })),
  ].sort(
    (left, right) =>
      left.scheduledTopPx - right.scheduledTopPx ||
      left.sortIndex - right.sortIndex ||
      (left.kind === right.kind ? 0 : left.kind === 'event' ? -1 : 1),
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
    nextAvailableTopPxByLane.set(block.laneKey, topPx + block.heightPx + TIMELINE_BLOCK_GAP_PX);
    maxContentBottomPx = Math.max(maxContentBottomPx, topPx + block.heightPx);
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

export function buildKmMarkers(
  items: TimelineItem[],
  prediction: PredictionResult | null | undefined,
  reference: StartReference,
  displayDayKeySet: ReadonlySet<string>,
  startMinutes: number,
  pixelsPerMinute: number,
  canvasHeight: number,
  kmMarkerStep: number,
  maxDistanceKm: number,
): KmMarker[] {
  const totalDistanceM = resolveTotalDistanceM(items, prediction);
  if (totalDistanceM <= 0) return [];

  const markers: KmMarker[] = [];
  for (let km = kmMarkerStep; km < maxDistanceKm; km += kmMarkerStep) {
    const elapsedSeconds =
      elapsedSecondsAtDistance(prediction, km * 1000, totalDistanceM) ?? estimateElapsedSeconds(km);
    const markerDate = reference.reference
      ? new Date(reference.reference.getTime() + elapsedSeconds * 1000)
      : null;

    if (reference.hasRealDate && markerDate && !displayDayKeySet.has(toDayKey(markerDate))) {
      continue;
    }

    const minuteOfDay = markerDate
      ? getMinuteOfDay(markerDate)
      : reference.startMinutes + elapsedSeconds / 60;
    const topPx = (minuteOfDay - startMinutes) * pixelsPerMinute + TIMELINE_VIEWPORT_TOP_INSET_PX;
    if (topPx < -20 || topPx > canvasHeight + 20) continue;

    markers.push({
      id: `km-${km}`,
      label: `km${Math.round(km)}`,
      topPx,
    });
  }

  return markers;
}

function estimateElapsedSeconds(distanceKm: number): number {
  const fallbackSpeedKmh = 18;
  return (Math.max(0, distanceKm) / fallbackSpeedKmh) * 3600;
}

function resolveSecondsToNextPoi(
  entries: TimedTimelineItem[],
  currentIndex: number,
): number | null {
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

  if (isOvernightPoi(item) && spanToNextSeconds !== null && Number.isFinite(spanToNextSeconds) && spanToNextSeconds > 0) {
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
    return [
      {
        dayKey,
        topPx: (minuteOfDay - startMinutes) * pixelsPerMinute,
        heightPx: durationMin * pixelsPerMinute,
      },
    ];
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
    const segmentHeightMin = Math.max(MIN_RENDER_DURATION_MIN, rawDurationMin);
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

function resolveStandalonePauseHeightPx(durationMin: number, pixelsPerMinute: number): number {
  const resolvedDurationMin = resolveVisualDurationMin(durationMin);
  if (resolvedDurationMin <= 0) return PAUSE_CHIP_MIN_HEIGHT_PX;
  return Math.max(PAUSE_CHIP_MIN_HEIGHT_PX, resolvedDurationMin * pixelsPerMinute);
}

function buildFavoritePoiPause(
  item: TimelineItem,
  rhythm?: RhythmState,
): Omit<AttachedPause, 'heightPx'> | null {
  if (!rhythm?.pauseAtFavoritePois) return null;
  if (item.kind !== 'poi' || !item.favorite || !item.poiCategory) return null;

  const durationMin = rhythm.poiPauseDurations[item.poiCategory];
  if (durationMin === null || durationMin === undefined || !Number.isFinite(durationMin) || durationMin <= 0) {
    return null;
  }

  return {
    id: `poi-pause-${item.id}`,
    durationMin,
    visible: item.visible !== false,
  };
}