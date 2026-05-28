/**
 * "Timeline" - day schedule view rebuilt from the Figma timeline design.
 *
 * Instead of a pure kilometre rail, the view projects itinerary checkpoints
 * onto a day/hour canvas using the FIT prediction when available. Distances
 * still drive placement fallback and km markers, but the user now navigates a
 * date strip and reads the route as scheduled checkpoints.
 */
import { useCallback, useEffect, useMemo, useRef, useState, type CSSProperties } from 'react';
import {
  BASE_HOUR_ROW_HEIGHT_PX,
  MIN_TIMELINE_HOURS,
  MINUTES_PER_DAY,
  RAIL_HEADER_HEIGHT_PX,
  RAIL_ITEM_HEIGHT_PX,
  TIMELINE_VIEWPORT_BOTTOM_INSET_PX,
  TIMELINE_VIEWPORT_TOP_INSET_PX,
} from './constants';
import { TimelineScheduleCanvas } from './TimelineScheduleCanvas';
import { TimelineScheduleHeader } from './TimelineScheduleHeader';
import type { TimelineTimelineViewProps } from './types';
import {
  buildDayWindow,
  buildKmMarkers,
  buildPauseAttachment,
  buildScheduledTimelineState,
  buildScheduledEvents,
  buildScheduledStandalonePauses,
  buildVisibleMinuteBounds,
  distanceAtElapsedSeconds,
  parseDayKey,
  parseStartReference,
  positionTimelineBlocks,
  resolveMarkerKmStep,
  resolveRideElapsedSecondsAtScheduledElapsed,
  toDayKey,
} from './utils';

export function TimelineTimelineView({
  items,
  rhythm,
  prediction,
  config,
  markerStepKm,
  hourZoom = 1,
  selectedIds,
  onToggleSelect,
  onToggleVisibility,
  onMovePause,
  onChangePauseDuration,
  onChangeIntervalPauseDuration,
  onChangeFavoritePoiPauseDuration,
  onRegisterPauseInsertionResolver,
  onToggleFavorite,
  onRemove,
}: TimelineTimelineViewProps) {
  const normalizedHourZoom = Math.min(1.5, Math.max(0.75, hourZoom));
  const scheduleRef = useRef<HTMLDivElement | null>(null);
  const viewportRef = useRef<HTMLDivElement | null>(null);
  const lastAutoScrollKeyRef = useRef<string | null>(null);

  const reference = useMemo(() => parseStartReference(rhythm), [rhythm]);
  const scheduleState = useMemo(
    () => buildScheduledTimelineState(items, prediction, reference, rhythm),
    [items, prediction, reference, rhythm],
  );
  const timedItems = scheduleState.timedItems;
  const autoPauseItems = scheduleState.autoPauses;
  const stopAnchors = scheduleState.stopAnchors;

  const defaultAnchorDay = useMemo(() => {
    const firstDatedItem = [...timedItems, ...autoPauseItems].find((item) => item.dayKey);
    if (firstDatedItem?.date) return new Date(firstDatedItem.date);
    if (reference.reference && reference.hasRealDate) return new Date(reference.reference);
    return new Date();
  }, [autoPauseItems, reference, timedItems]);
  const defaultAnchorDayKey = useMemo(() => toDayKey(defaultAnchorDay), [defaultAnchorDay]);

  const [selectedDayKey, setSelectedDayKey] = useState(() => defaultAnchorDayKey);
  const [isCompactLayout, setIsCompactLayout] = useState(false);
  const [now, setNow] = useState(() => new Date());
  const [viewportHeight, setViewportHeight] = useState(0);

  useEffect(() => {
    setSelectedDayKey(defaultAnchorDayKey);
  }, [defaultAnchorDayKey]);

  useEffect(() => {
    const node = scheduleRef.current;
    if (!node || typeof ResizeObserver === 'undefined') return;

    const observer = new ResizeObserver((entries) => {
      const entry = entries[0];
      if (!entry) return;
      setIsCompactLayout(entry.contentRect.width < 860);
    });

    observer.observe(node);
    return () => observer.disconnect();
  }, []);

  useEffect(() => {
    const handle = window.setInterval(() => setNow(new Date()), 60_000);
    return () => window.clearInterval(handle);
  }, []);

  useEffect(() => {
    const node = viewportRef.current;
    if (!node || typeof ResizeObserver === 'undefined') return;

    const observer = new ResizeObserver((entries) => {
      const entry = entries[0];
      if (!entry) return;
      setViewportHeight(entry.contentRect.height);
    });

    observer.observe(node);
    return () => observer.disconnect();
  }, []);

  const selectedDayDate = useMemo(
    () => parseDayKey(selectedDayKey) ?? defaultAnchorDay,
    [defaultAnchorDay, selectedDayKey],
  );

  const dayWindow = useMemo(() => buildDayWindow(selectedDayDate), [selectedDayDate]);
  const headerDays = useMemo(() => dayWindow, [dayWindow]);
  const displayDays = useMemo(() => {
    if (!reference.hasRealDate || isCompactLayout) return [selectedDayDate];
    return dayWindow;
  }, [dayWindow, isCompactLayout, reference.hasRealDate, selectedDayDate]);
  const displayDayKeys = useMemo(() => displayDays.map((day) => toDayKey(day)), [displayDays]);
  const displayDayKeySet = useMemo(() => new Set(displayDayKeys), [displayDayKeys]);
  const dayIndexByKey = useMemo(
    () => new Map(displayDayKeys.map((dayKey, index) => [dayKey, index])),
    [displayDayKeys],
  );
  const dayColumnCount = Math.max(1, displayDays.length);

  const primaryItems = useMemo(
    () => timedItems.filter((entry) => entry.item.kind !== 'pause'),
    [timedItems],
  );
  const timelineSpansMultipleDays = useMemo(() => {
    const dayKeys = new Set(
      [...timedItems, ...autoPauseItems]
        .map((entry) => entry.dayKey)
        .filter((dayKey): dayKey is string => Boolean(dayKey)),
    );
    return dayKeys.size > 1;
  }, [autoPauseItems, timedItems]);
  const pauseItems = useMemo(
    () => timedItems.filter((entry) => entry.item.kind === 'pause'),
    [timedItems],
  );

  const filteredPrimaryItems = useMemo(() => {
    if (!reference.hasRealDate) return primaryItems;
    return primaryItems.filter((entry) => entry.dayKey && displayDayKeySet.has(entry.dayKey));
  }, [displayDayKeySet, primaryItems, reference.hasRealDate]);

  const filteredPauseItems = useMemo(() => {
    if (!reference.hasRealDate) return pauseItems;
    return pauseItems.filter((entry) => entry.dayKey && displayDayKeySet.has(entry.dayKey));
  }, [displayDayKeySet, pauseItems, reference.hasRealDate]);

  const filteredAutoPauseItems = useMemo(() => {
    if (!reference.hasRealDate) return autoPauseItems;
    return autoPauseItems.filter((entry) => entry.dayKey && displayDayKeySet.has(entry.dayKey));
  }, [autoPauseItems, displayDayKeySet, reference.hasRealDate]);

  const pauseAttachment = useMemo(
    () => buildPauseAttachment(filteredPrimaryItems, filteredAutoPauseItems),
    [filteredAutoPauseItems, filteredPrimaryItems],
  );

  const maxDistanceKm = useMemo(
    () => items.reduce((maxDistance, item) => Math.max(maxDistance, item.distanceKm ?? 0), 0),
    [items],
  );

  const visibleMinuteBounds = useMemo(
    () =>
      buildVisibleMinuteBounds(
        filteredPrimaryItems,
        filteredPauseItems,
        pauseAttachment.unattachedPauses,
        pauseAttachment,
        displayDays,
        reference,
      ),
    [displayDays, filteredPauseItems, filteredPrimaryItems, pauseAttachment, reference],
  );

  const startMinutes = useMemo(() => {
    const firstMinute = visibleMinuteBounds.reduce(
      (minMinute, minute) => Math.min(minMinute, minute),
      Number.POSITIVE_INFINITY,
    );
    if (!Number.isFinite(firstMinute)) return reference.startMinutes;
    return Math.max(0, Math.floor(firstMinute / 10) * 10);
  }, [reference.startMinutes, visibleMinuteBounds]);

  const endMinutes = useMemo(() => {
    const lastVisibleMinute = visibleMinuteBounds.reduce(
      (maxMinute, minute) => Math.max(maxMinute, minute),
      Number.NEGATIVE_INFINITY,
    );
    if (!Number.isFinite(lastVisibleMinute)) return startMinutes + 60;
    if (reference.hasRealDate && timelineSpansMultipleDays) {
      return Math.max(startMinutes + MIN_TIMELINE_HOURS * 60, MINUTES_PER_DAY);
    }
    const roundedEnd = Math.ceil(lastVisibleMinute / 60) * 60;
    return Math.max(startMinutes + MIN_TIMELINE_HOURS * 60, roundedEnd);
  }, [reference.hasRealDate, startMinutes, timelineSpansMultipleDays, visibleMinuteBounds]);

  const totalHours = Math.max(MIN_TIMELINE_HOURS, Math.ceil((endMinutes - startMinutes) / 60));
  const baseHourRowHeightPx = BASE_HOUR_ROW_HEIGHT_PX * normalizedHourZoom;
  const availableViewportHeightPx = Math.max(
    0,
    viewportHeight - RAIL_HEADER_HEIGHT_PX - 20,
  );
  const hourRowHeightPx =
    availableViewportHeightPx > 0
      ? Math.max(baseHourRowHeightPx, availableViewportHeightPx / totalHours)
      : baseHourRowHeightPx;
  const pixelsPerMinute = hourRowHeightPx / 60;
  const canvasBaseHeight = Math.max((endMinutes - startMinutes) * pixelsPerMinute, 0);

  const scheduledEvents = useMemo(
    () =>
      buildScheduledEvents(
        filteredPrimaryItems,
        pauseAttachment,
        pixelsPerMinute,
        displayDays,
        reference,
        startMinutes,
      ),
    [displayDays, filteredPrimaryItems, pauseAttachment, pixelsPerMinute, reference, startMinutes],
  );

  const scheduledStandalonePauses = useMemo(
    () =>
      buildScheduledStandalonePauses(
        filteredPauseItems,
        pauseAttachment.unattachedPauses,
        filteredPrimaryItems,
        pixelsPerMinute,
        startMinutes,
      ),
    [filteredPauseItems, filteredPrimaryItems, pauseAttachment.unattachedPauses, pixelsPerMinute, startMinutes],
  );

  const standalonePauseDayKeyById = useMemo(
    () =>
      new Map(
        [
          ...filteredPauseItems.map((pause) => [pause.item.id, pause.dayKey ?? null] as const),
          ...pauseAttachment.unattachedPauses.map((pause) => [pause.id, pause.dayKey ?? null] as const),
        ],
      ),
    [filteredPauseItems, pauseAttachment.unattachedPauses],
  );

  const { events, standalonePauses, canvasHeight, firstVisibleTopPx } = useMemo(
    () =>
      positionTimelineBlocks(
        scheduledEvents,
        scheduledStandalonePauses,
        standalonePauseDayKeyById,
        canvasBaseHeight,
      ),
    [canvasBaseHeight, scheduledEvents, scheduledStandalonePauses, standalonePauseDayKeyById],
  );

  const kmMarkerStep = useMemo(
    () => resolveMarkerKmStep(config, markerStepKm),
    [config, markerStepKm],
  );
  const kmMarkers = useMemo(
    () =>
      buildKmMarkers(
        items,
        prediction,
        reference,
        displayDayKeySet,
        startMinutes,
        pixelsPerMinute,
        canvasHeight,
        kmMarkerStep,
        maxDistanceKm,
        stopAnchors,
      ),
    [
      canvasHeight,
      displayDayKeySet,
      items,
      kmMarkerStep,
      maxDistanceKm,
      pixelsPerMinute,
      prediction,
      reference,
      startMinutes,
      stopAnchors,
    ],
  );

  const handleMovePauseScheduled = useCallback(
    (id: string, scheduledElapsedSeconds: number) => {
      if (!prediction) return;
      const rideElapsedSeconds = resolveRideElapsedSecondsAtScheduledElapsed(
        scheduledElapsedSeconds,
        stopAnchors.filter((anchor) => anchor.id !== id),
      );
      const distanceM = distanceAtElapsedSeconds(prediction, rideElapsedSeconds);
      if (!Number.isFinite(distanceM)) return;
      onMovePause?.(id, Math.max(0, (distanceM as number) / 1000));
    },
    [onMovePause, prediction, stopAnchors],
  );

  const resolveVisiblePauseInsertionDistanceKm = useCallback(() => {
    if (!prediction) return null;

    const viewport = viewportRef.current;
    if (!viewport) return null;

    const rawTopPx = viewport.scrollTop + (viewport.clientHeight > 0 ? viewport.clientHeight * 0.5 : 0);
    const minTopPx = TIMELINE_VIEWPORT_TOP_INSET_PX;
    const maxTopPx = Math.max(minTopPx, canvasHeight - TIMELINE_VIEWPORT_BOTTOM_INSET_PX);
    const topPx = Math.min(maxTopPx, Math.max(minTopPx, rawTopPx));
    const minuteOfDay = Math.min(
      MINUTES_PER_DAY,
      Math.max(
        0,
        startMinutes + ((topPx - TIMELINE_VIEWPORT_TOP_INSET_PX) / Math.max(pixelsPerMinute, 0.001)),
      ),
    );

    let scheduledElapsedSeconds = Math.max(0, (minuteOfDay - startMinutes) * 60);
    if (reference.reference && reference.hasRealDate) {
      const scheduledDate = new Date(
        selectedDayDate.getFullYear(),
        selectedDayDate.getMonth(),
        selectedDayDate.getDate(),
        0,
        0,
        0,
        0,
      );
      scheduledDate.setMinutes(minuteOfDay, 0, 0);
      scheduledElapsedSeconds = Math.max(
        0,
        (scheduledDate.getTime() - reference.reference.getTime()) / 1000,
      );
    }

    const rideElapsedSeconds = resolveRideElapsedSecondsAtScheduledElapsed(
      scheduledElapsedSeconds,
      stopAnchors,
    );
    const distanceM = distanceAtElapsedSeconds(prediction, rideElapsedSeconds);
    if (!Number.isFinite(distanceM)) return null;

    return Math.max(0, Number((((distanceM as number) / 1000)).toFixed(3)));
  }, [canvasHeight, pixelsPerMinute, prediction, reference, selectedDayDate, startMinutes, stopAnchors]);

  useEffect(() => {
    onRegisterPauseInsertionResolver?.(resolveVisiblePauseInsertionDistanceKm);
    return () => onRegisterPauseInsertionResolver?.(null);
  }, [onRegisterPauseInsertionResolver, resolveVisiblePauseInsertionDistanceKm]);

  const hourMarks = useMemo(
    () => {
      const marks = [startMinutes];
      let nextHourMinute = Math.ceil(startMinutes / 60) * 60;

      if (nextHourMinute <= startMinutes) {
        nextHourMinute += 60;
      }

      while (nextHourMinute < endMinutes) {
        marks.push(nextHourMinute);
        nextHourMinute += 60;
      }

      if (marks[marks.length - 1] !== endMinutes) {
        marks.push(endMinutes);
      }

      return marks;
    },
    [endMinutes, startMinutes],
  );

  const currentTimeLineTopPx = useMemo(() => {
    if (!reference.hasRealDate) return null;
    if (!displayDayKeySet.has(toDayKey(now))) return null;
    const minuteOfDay = now.getHours() * 60 + now.getMinutes();
    if (minuteOfDay < startMinutes || minuteOfDay > endMinutes) return null;
    return (minuteOfDay - startMinutes) * pixelsPerMinute + 10;
  }, [displayDayKeySet, endMinutes, now, pixelsPerMinute, reference.hasRealDate, startMinutes]);
  const currentTimeLineDayIndex = useMemo(() => {
    if (!reference.hasRealDate) return null;
    return dayIndexByKey.get(toDayKey(now)) ?? null;
  }, [dayIndexByKey, now, reference.hasRealDate]);

  const autoScrollKey = useMemo(
    () =>
      [
        displayDayKeys.join(','),
        Math.round(hourRowHeightPx),
        Math.round(firstVisibleTopPx ?? -1),
        Math.round(canvasHeight),
      ].join(':'),
    [canvasHeight, displayDayKeys, firstVisibleTopPx, hourRowHeightPx],
  );

  useEffect(() => {
    const viewport = viewportRef.current;
    if (!viewport) return;
    if (lastAutoScrollKeyRef.current === autoScrollKey) return;
    lastAutoScrollKeyRef.current = autoScrollKey;

    const preferredTopPx = currentTimeLineTopPx ?? firstVisibleTopPx;
    if (preferredTopPx === null) {
      viewport.scrollTop = 0;
      return;
    }

    const targetScrollTop = Math.max(
      0,
      Math.min(
        preferredTopPx - hourRowHeightPx * 0.5,
        Math.max(0, viewport.scrollHeight - viewport.clientHeight),
      ),
    );
    viewport.scrollTop = targetScrollTop;
  }, [autoScrollKey, currentTimeLineTopPx, firstVisibleTopPx, hourRowHeightPx]);

  const visibleWindowHasEvents = events.length > 0 || standalonePauses.length > 0;
  const scheduleStyle = {
    '--rvi-tl-day-count': String(dayColumnCount),
    '--rvi-tl-hour-row-height': `${hourRowHeightPx}px`,
  } as CSSProperties;
  const canvasStyle = {
    height: canvasHeight,
  } as CSSProperties;

  function resolveColumnPlacement(dayKey: string | null): CSSProperties {
    if (!reference.hasRealDate || dayColumnCount <= 1) return {};
    const dayIndex = dayKey ? dayIndexByKey.get(dayKey) : undefined;
    const normalizedIndex = dayIndex ?? 0;
    const columnWidthPct = 100 / dayColumnCount;
    return {
      left: `calc(${normalizedIndex * columnWidthPct}% + 6px)`,
      width: `calc(${columnWidthPct}% - 12px)`,
      right: 'auto',
    };
  }

  function resolveNowLinePlacement(): CSSProperties {
    if (!reference.hasRealDate || dayColumnCount <= 1 || currentTimeLineDayIndex === null) {
      return {};
    }
    const columnWidthPct = 100 / dayColumnCount;
    return {
      left: `${currentTimeLineDayIndex * columnWidthPct}%`,
      width: `${columnWidthPct}%`,
      right: 'auto',
    };
  }

  return (
    <div ref={scheduleRef} className="rvi-tl-schedule" style={scheduleStyle} aria-label="Timeline journaliere">
      <TimelineScheduleHeader
        displayDays={headerDays}
        selectedDayKey={selectedDayKey}
        onSelectDay={setSelectedDayKey}
      />

      <TimelineScheduleCanvas
        viewportRef={viewportRef}
        hourMarks={hourMarks}
        hourRowHeightPx={hourRowHeightPx}
        kmMarkers={kmMarkers}
        canvasStyle={canvasStyle}
        displayDays={displayDays}
        selectedDayKey={selectedDayKey}
        currentTimeLineTopPx={currentTimeLineTopPx}
        now={now}
        visibleWindowHasEvents={visibleWindowHasEvents}
        events={events}
        standalonePauses={standalonePauses}
        standalonePauseDayKeyById={standalonePauseDayKeyById}
        reference={reference}
        startMinutes={startMinutes}
        pixelsPerMinute={pixelsPerMinute}
        canvasHeight={canvasHeight}
        selectedIds={selectedIds}
        onToggleSelect={onToggleSelect}
        onToggleVisibility={onToggleVisibility}
        onMovePauseScheduled={handleMovePauseScheduled}
        onChangePauseDuration={onChangePauseDuration}
        onChangeIntervalPauseDuration={onChangeIntervalPauseDuration}
        onChangeFavoritePoiPauseDuration={onChangeFavoritePoiPauseDuration}
        onToggleFavorite={onToggleFavorite}
        onRemove={onRemove}
        resolveColumnPlacement={resolveColumnPlacement}
        resolveNowLinePlacement={resolveNowLinePlacement}
      />
    </div>
  );
}

export { RAIL_HEADER_HEIGHT_PX, RAIL_ITEM_HEIGHT_PX };