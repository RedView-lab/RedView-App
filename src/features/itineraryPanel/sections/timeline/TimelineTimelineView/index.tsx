/**
 * "Timeline" - day schedule view rebuilt from the Figma timeline design.
 *
 * Instead of a pure kilometre rail, the view projects itinerary checkpoints
 * onto a day/hour canvas using the FIT prediction when available. Distances
 * still drive placement fallback and km markers, but the user now navigates a
 * date strip and reads the route as scheduled checkpoints.
 */
import { useEffect, useMemo, useRef, useState, type CSSProperties } from 'react';
import {
  BASE_HOUR_ROW_HEIGHT_PX,
  MIN_TIMELINE_HOURS,
  RAIL_HEADER_HEIGHT_PX,
  RAIL_ITEM_HEIGHT_PX,
} from './constants';
import { TimelineScheduleCanvas } from './TimelineScheduleCanvas';
import { TimelineScheduleHeader } from './TimelineScheduleHeader';
import type { TimelineTimelineViewProps } from './types';
import {
  buildDayWindow,
  buildKmMarkers,
  buildPauseAttachment,
  buildScheduledEvents,
  buildScheduledStandalonePauses,
  buildTimedItems,
  buildVisibleMinuteBounds,
  parseDayKey,
  parseStartReference,
  positionTimelineBlocks,
  resolveMarkerKmStep,
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
  onToggleFavorite,
  onRemove,
}: TimelineTimelineViewProps) {
  const normalizedHourZoom = Math.min(1.5, Math.max(0.75, hourZoom));
  const scheduleRef = useRef<HTMLDivElement | null>(null);
  const viewportRef = useRef<HTMLDivElement | null>(null);
  const lastAutoScrollKeyRef = useRef<string | null>(null);

  const reference = useMemo(() => parseStartReference(rhythm), [rhythm]);
  const timedItems = useMemo(
    () => buildTimedItems(items, prediction, reference),
    [items, prediction, reference],
  );

  const defaultAnchorDay = useMemo(() => {
    const firstDatedItem = timedItems.find((item) => item.dayKey);
    if (firstDatedItem?.date) return new Date(firstDatedItem.date);
    if (reference.reference && reference.hasRealDate) return new Date(reference.reference);
    return new Date();
  }, [reference, timedItems]);
  const defaultAnchorDayKey = useMemo(() => toDayKey(defaultAnchorDay), [defaultAnchorDay]);

  const [selectedDayKey, setSelectedDayKey] = useState(() => defaultAnchorDayKey);
  const [isCompactLayout, setIsCompactLayout] = useState(false);
  const [now, setNow] = useState(() => new Date());

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

  const selectedDayDate = useMemo(
    () => parseDayKey(selectedDayKey) ?? defaultAnchorDay,
    [defaultAnchorDay, selectedDayKey],
  );

  const dayWindow = useMemo(() => buildDayWindow(selectedDayDate), [selectedDayDate]);
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

  const pauseAttachment = useMemo(
    () => buildPauseAttachment(filteredPrimaryItems, filteredPauseItems, rhythm),
    [filteredPauseItems, filteredPrimaryItems, rhythm],
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
    return Math.max(0, Math.floor(firstMinute / 60) * 60);
  }, [reference.startMinutes, visibleMinuteBounds]);

  const endMinutes = useMemo(() => {
    const lastVisibleMinute = visibleMinuteBounds.reduce(
      (maxMinute, minute) => Math.max(maxMinute, minute),
      Number.NEGATIVE_INFINITY,
    );
    if (!Number.isFinite(lastVisibleMinute)) return startMinutes + 60;
    const roundedEnd = Math.ceil(lastVisibleMinute / 60) * 60;
    return Math.max(startMinutes + MIN_TIMELINE_HOURS * 60, roundedEnd);
  }, [startMinutes, visibleMinuteBounds]);

  const totalHours = Math.max(MIN_TIMELINE_HOURS, Math.ceil((endMinutes - startMinutes) / 60));
  const hourRowHeightPx = BASE_HOUR_ROW_HEIGHT_PX * normalizedHourZoom;
  const pixelsPerMinute = hourRowHeightPx / 60;
  const canvasBaseHeight = Math.max(totalHours * hourRowHeightPx, 0);

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
    () => buildScheduledStandalonePauses(pauseAttachment, pixelsPerMinute, startMinutes),
    [pauseAttachment, pixelsPerMinute, startMinutes],
  );

  const standalonePauseDayKeyById = useMemo(
    () =>
      new Map(
        pauseAttachment.unattachedPauses.map((pause) => [pause.item.id, pause.dayKey ?? null]),
      ),
    [pauseAttachment.unattachedPauses],
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
    ],
  );

  const hourMarks = useMemo(
    () => Array.from({ length: totalHours + 1 }, (_, index) => startMinutes / 60 + index),
    [startMinutes, totalHours],
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
        displayDays={displayDays}
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
        totalHours={totalHours}
        currentTimeLineTopPx={currentTimeLineTopPx}
        now={now}
        visibleWindowHasEvents={visibleWindowHasEvents}
        events={events}
        standalonePauses={standalonePauses}
        standalonePauseDayKeyById={standalonePauseDayKeyById}
        selectedIds={selectedIds}
        onToggleSelect={onToggleSelect}
        onToggleVisibility={onToggleVisibility}
        onToggleFavorite={onToggleFavorite}
        onRemove={onRemove}
        resolveColumnPlacement={resolveColumnPlacement}
        resolveNowLinePlacement={resolveNowLinePlacement}
      />
    </div>
  );
}

export { RAIL_HEADER_HEIGHT_PX, RAIL_ITEM_HEIGHT_PX };