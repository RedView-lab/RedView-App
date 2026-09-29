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
  MINUTES_PER_DAY,
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
  onHourZoomChange,
  selectedIds,
  filters,
  onSelectRow,
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
  const [localHourZoom, setLocalHourZoom] = useState(hourZoom);
  useEffect(() => {
    if (Number.isFinite(hourZoom)) {
      setLocalHourZoom(hourZoom);
    }
  }, [hourZoom]);

  const normalizedHourZoom = Math.min(3.0, Math.max(0.4, localHourZoom));
  const scheduleRef = useRef<HTMLDivElement | null>(null);
  const viewportRef = useRef<HTMLDivElement | null>(null);
  const isNavigatingRef = useRef(false);
  const pendingScrollTopRef = useRef<number | null>(null);

  const reference = useMemo(() => parseStartReference(rhythm), [rhythm]);
  const scheduleState = useMemo(
    () => buildScheduledTimelineState(items, prediction, reference, rhythm),
    [items, prediction, reference, rhythm],
  );
  const timedItems = scheduleState.timedItems;
  const autoPauseItems = scheduleState.autoPauses;
  const stopAnchors = scheduleState.stopAnchors;

  const defaultAnchorDay = useMemo(() => {
    const activeAutoPauses = filters && !filters.pause ? [] : autoPauseItems;
    const firstDatedItem = [...timedItems, ...activeAutoPauses].find((item) => item.dayKey);
    if (firstDatedItem?.date) return new Date(firstDatedItem.date);
    if (reference.reference && reference.hasRealDate) return new Date(reference.reference);
    return new Date();
  }, [autoPauseItems, filters, reference, timedItems]);
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
  const pauseItems = useMemo(() => {
    if (filters && !filters.pause) return [];
    return timedItems.filter((entry) => entry.item.kind === 'pause');
  }, [filters, timedItems]);

  const filteredPrimaryItems = useMemo(() => {
    if (!reference.hasRealDate) return primaryItems;
    return primaryItems.filter((entry) => entry.dayKey && displayDayKeySet.has(entry.dayKey));
  }, [displayDayKeySet, primaryItems, reference.hasRealDate]);

  const filteredPauseItems = useMemo(() => {
    if (filters && !filters.pause) return [];
    if (!reference.hasRealDate) return pauseItems;
    return pauseItems.filter((entry) => entry.dayKey && displayDayKeySet.has(entry.dayKey));
  }, [displayDayKeySet, filters, pauseItems, reference.hasRealDate]);

  const filteredAutoPauseItems = useMemo(() => {
    if (filters && !filters.pause) return [];
    if (!reference.hasRealDate) return autoPauseItems;
    return autoPauseItems.filter((entry) => entry.dayKey && displayDayKeySet.has(entry.dayKey));
  }, [autoPauseItems, displayDayKeySet, filters, reference.hasRealDate]);

  const pauseAttachment = useMemo(
    () => buildPauseAttachment(filteredPrimaryItems, filteredAutoPauseItems),
    [filteredAutoPauseItems, filteredPrimaryItems],
  );

  const maxDistanceKm = useMemo(
    () => items.reduce((maxDistance, item) => Math.max(maxDistance, item.distanceKm ?? 0), 0),
    [items],
  );

  const startMinutes = useMemo(() => {
    return Math.max(0, Math.floor(reference.startMinutes / 60) * 60);
  }, [reference.startMinutes]);

  const endMinutes = useMemo(() => {
    const lastItemMinute = [...timedItems, ...autoPauseItems].reduce(
      (maxMinute, item) => Math.max(maxMinute, item.minuteOfDay),
      startMinutes,
    );
    const roundedLastMinute = Math.ceil(lastItemMinute / 60) * 60;
    return Math.max(startMinutes + 12 * 60, MINUTES_PER_DAY, roundedLastMinute);
  }, [autoPauseItems, startMinutes, timedItems]);

  const visibleDurationMinutes = Math.max(60, endMinutes - startMinutes);
  const hourRowHeightPx = BASE_HOUR_ROW_HEIGHT_PX * normalizedHourZoom;
  const pixelsPerMinute = hourRowHeightPx / 60;
  const canvasBaseHeight = Math.max(visibleDurationMinutes * pixelsPerMinute, 0);

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

  const [viewportMetrics, setViewportMetrics] = useState({
    clientHeight: 0,
    scrollHeight: 0,
    scrollTop: 0,
  });

  const updateViewportMetrics = useCallback(() => {
    const vp = viewportRef.current;
    if (!vp) return;
    setViewportMetrics({
      clientHeight: vp.clientHeight,
      scrollHeight: vp.scrollHeight,
      scrollTop: vp.scrollTop,
    });
  }, []);

  useEffect(() => {
    const vp = viewportRef.current;
    if (!vp) return;
    updateViewportMetrics();
    vp.addEventListener('scroll', updateViewportMetrics, { passive: true });
    const ro = typeof ResizeObserver !== 'undefined'
      ? new ResizeObserver(() => updateViewportMetrics())
      : null;
    ro?.observe(vp);
    return () => {
      vp.removeEventListener('scroll', updateViewportMetrics);
      ro?.disconnect();
    };
  }, [canvasHeight, updateViewportMetrics]);

  useEffect(() => {
    if (pendingScrollTopRef.current !== null && viewportRef.current) {
      viewportRef.current.scrollTop = pendingScrollTopRef.current;
      pendingScrollTopRef.current = null;
      updateViewportMetrics();
    }
  }, [canvasHeight, updateViewportMetrics]);

  useEffect(() => {
    const handleWindowPointerUp = () => {
      isNavigatingRef.current = false;
    };
    window.addEventListener('pointerup', handleWindowPointerUp);
    window.addEventListener('pointercancel', handleWindowPointerUp);
    return () => {
      window.removeEventListener('pointerup', handleWindowPointerUp);
      window.removeEventListener('pointercancel', handleWindowPointerUp);
    };
  }, []);

  const verticalFraction = useMemo(() => {
    if (viewportMetrics.scrollHeight <= 0 || viewportMetrics.clientHeight <= 0) return 1;
    return Math.min(1, Math.max(0.04, viewportMetrics.clientHeight / viewportMetrics.scrollHeight));
  }, [viewportMetrics.clientHeight, viewportMetrics.scrollHeight]);

  const verticalOffset = useMemo(() => {
    const maxScroll = Math.max(0, viewportMetrics.scrollHeight - viewportMetrics.clientHeight);
    if (maxScroll <= 0) return 1;
    const ratio = Math.max(0, Math.min(1, viewportMetrics.scrollTop / maxScroll));
    return 1 - ratio;
  }, [viewportMetrics.clientHeight, viewportMetrics.scrollHeight, viewportMetrics.scrollTop]);

  const handleVerticalNavigatorChange = useCallback(
    (next: { visibleFraction: number; offset: number }) => {
      const vp = viewportRef.current;
      if (!vp) return;

      isNavigatingRef.current = true;
      const currentClientHeight = vp.clientHeight || viewportMetrics.clientHeight;
      if (currentClientHeight <= 0) return;

      // Double-click reset to default 1.0 view
      if (next.visibleFraction >= 0.999 && next.offset === 0) {
        setLocalHourZoom(1);
        onHourZoomChange?.(1);
        vp.scrollTop = 0;
        setViewportMetrics({
          clientHeight: currentClientHeight,
          scrollHeight: vp.scrollHeight,
          scrollTop: 0,
        });
        return;
      }

      const clampedFraction = Math.max(0.04, Math.min(1, next.visibleFraction));
      const clampedOffset = Math.max(0, Math.min(1, next.offset));

      // Handle zoom if fraction changed
      const fractionDiff = Math.abs(clampedFraction - verticalFraction);
      let effectiveCanvasHeight = vp.scrollHeight;
      if (fractionDiff > 0.005) {
        const desiredCanvasHeight = currentClientHeight / clampedFraction;
        const visibleDurationHours = Math.max(1, visibleDurationMinutes / 60);
        const desiredHourRowHeightPx = desiredCanvasHeight / visibleDurationHours;
        const targetZoom = Math.min(
          3.0,
          Math.max(0.4, Number((desiredHourRowHeightPx / BASE_HOUR_ROW_HEIGHT_PX).toFixed(2))),
        );

        setLocalHourZoom(targetZoom);
        onHourZoomChange?.(targetZoom);
        effectiveCanvasHeight = desiredCanvasHeight;
      }

      // Scroll position calculation:
      // Offset 1 is top (scrollTop = 0), Offset 0 is bottom (scrollTop = maxScroll)
      const desiredMaxScroll = Math.max(0, effectiveCanvasHeight - currentClientHeight);
      const targetScrollTop = Math.max(0, Math.min(desiredMaxScroll, (1 - clampedOffset) * desiredMaxScroll));

      vp.scrollTop = targetScrollTop;
      pendingScrollTopRef.current = targetScrollTop;

      setViewportMetrics({
        clientHeight: currentClientHeight,
        scrollHeight: Math.round(effectiveCanvasHeight),
        scrollTop: targetScrollTop,
      });
    },
    [onHourZoomChange, verticalFraction, viewportMetrics.clientHeight, visibleDurationMinutes],
  );

  const handleZoomWheel = useCallback((e: React.WheelEvent<HTMLDivElement>) => {
    const vp = viewportRef.current;
    if (!vp) return;
    vp.scrollTop += e.deltaY;
  }, []);

  const hasInitialAutoScrolledRef = useRef(false);
  const lastAutoScrollDayKeyRef = useRef<string | null>(null);

  useEffect(() => {
    const viewport = viewportRef.current;
    if (!viewport) return;
    if (isNavigatingRef.current) return;

    const daysKey = displayDayKeys.join(',');
    const isNewDay = lastAutoScrollDayKeyRef.current !== daysKey;
    if (!isNewDay && hasInitialAutoScrolledRef.current) return;
    if (canvasHeight <= 0) return;

    lastAutoScrollDayKeyRef.current = daysKey;
    hasInitialAutoScrolledRef.current = true;

    const fallbackTopPx = (reference.startMinutes - startMinutes) * pixelsPerMinute + TIMELINE_VIEWPORT_TOP_INSET_PX;
    const preferredTopPx = currentTimeLineTopPx ?? firstVisibleTopPx ?? fallbackTopPx;
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
  }, [canvasHeight, currentTimeLineTopPx, displayDayKeys, firstVisibleTopPx, hourRowHeightPx, pixelsPerMinute, reference.startMinutes, startMinutes]);

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
      left: `${normalizedIndex * columnWidthPct}%`,
      width: `${columnWidthPct}%`,
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
        verticalFraction={verticalFraction}
        verticalOffset={verticalOffset}
        onVerticalNavigatorChange={handleVerticalNavigatorChange}
        onZoomWheel={handleZoomWheel}
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
        onSelectRow={onSelectRow}
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