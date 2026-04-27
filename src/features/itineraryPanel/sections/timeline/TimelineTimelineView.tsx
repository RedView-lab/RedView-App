/**
 * "Timeline" — day schedule view rebuilt from the Figma timeline design.
 *
 * Instead of a pure kilometre rail, the view projects itinerary checkpoints
 * onto a day/hour canvas using the FIT prediction when available. Distances
 * still drive placement fallback and km markers, but the user now navigates a
 * date strip and reads the route as scheduled checkpoints.
 */
import { useEffect, useMemo, useRef, useState, type CSSProperties } from 'react';
import { elapsedSecondsAtDistance } from '@/features/centerPanel/flyover/playback';
import type { PredictionResult } from '@/features/fitPredictor';
import {
  IconEye,
  IconPauseCircle,
  IconStar,
  IconTrash,
} from '../../components/icons';
import type { RhythmState, TimelineItem, TimelineRailConfig } from '../../types';
import { DEFAULT_TIMELINE_RAIL } from '../../types';
import { KindBadge } from './KindBadge';

interface TimelineTimelineViewProps {
  items: TimelineItem[];
  rhythm?: RhythmState;
  prediction?: PredictionResult | null;
  config?: Partial<TimelineRailConfig>;
  markerStepKm?: number;
  hourZoom?: number;
  selectedIds?: ReadonlySet<string>;
  onToggleSelect?: (id: string, selected: boolean) => void;
  onToggleVisibility?: (id: string, visible: boolean) => void;
  onToggleFavorite?: (id: string, favorite: boolean) => void;
  onRemove?: (id: string) => void;
}

interface StartReference {
  reference: Date | null;
  hasRealDate: boolean;
  startMinutes: number;
}

interface TimedTimelineItem {
  item: TimelineItem;
  sortIndex: number;
  distanceKm: number;
  elapsedSeconds: number;
  minuteOfDay: number;
  date: Date | null;
  dayKey: string | null;
}

interface AttachedPause {
  id: string;
  durationMin: number;
  visible: boolean;
  heightPx: number;
}

interface TimelineEvent extends TimedTimelineItem {
  scheduledTopPx: number;
  topPx: number;
  attachedPauses: AttachedPause[];
  toNextSeconds: number | null;
  cardHeightPx: number;
  heightPx: number;
}

interface TimelineStandalonePause {
  id: string;
  scheduledTopPx: number;
  topPx: number;
  durationMin: number;
  visible: boolean;
  heightPx: number;
  sortIndex: number;
}

const RAIL_HEADER_HEIGHT_PX = 30;
const RAIL_ITEM_HEIGHT_PX = 32;
const BASE_HOUR_ROW_HEIGHT_PX = 96;
const DEFAULT_START_MINUTES = 8 * 60;
const MIN_TIMELINE_HOURS = 1;
const DAY_WINDOW_DAYS = 6;
const KM_MARKER_MIN_STEP = 25;
const ATTACHED_PAUSE_HEIGHT_PX = 24;
const PAUSE_CHIP_MIN_HEIGHT_PX = 28;
const TIMELINE_BLOCK_GAP_PX = 4;
const TIMELINE_VIEWPORT_TOP_INSET_PX = 10;

const WEEKDAY_SHORT = ['Dim', 'Lun', 'Mar', 'Mer', 'Jeu', 'Ven', 'Sam'] as const;

function parseStartReference(rhythm?: RhythmState): StartReference {
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

function parseDateTime(dateValue: string, timeValue: string): Date | null {
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

function parseTimeMinutes(value: string | null | undefined): number | null {
  if (!value) return null;
  const match = /^(\d{1,2}):(\d{2})$/u.exec(value.trim());
  if (!match) return null;
  const hours = Number(match[1]);
  const minutes = Number(match[2]);
  if (!Number.isFinite(hours) || !Number.isFinite(minutes)) return null;
  return hours * 60 + minutes;
}

function toDayKey(date: Date): string {
  return [
    date.getFullYear(),
    String(date.getMonth() + 1).padStart(2, '0'),
    String(date.getDate()).padStart(2, '0'),
  ].join('-');
}

function parseDayKey(dayKey: string): Date | null {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/u.exec(dayKey);
  if (!match) return null;
  const date = new Date(Number(match[1]), Number(match[2]) - 1, Number(match[3]));
  return Number.isNaN(date.getTime()) ? null : date;
}

function addDays(date: Date, days: number): Date {
  const result = new Date(date);
  result.setDate(result.getDate() + days);
  return result;
}

function formatDayLabel(date: Date): string {
  return WEEKDAY_SHORT[date.getDay()] ?? '';
}

function formatDistanceLabel(distanceKm: number): string {
  if (!Number.isFinite(distanceKm)) return '--';
  return `${distanceKm.toFixed(1)} km`;
}

function formatLegDuration(seconds: number | null): string {
  if (!Number.isFinite(seconds)) return '--';
  const totalMinutes = Math.max(0, Math.round((seconds as number) / 60));
  const hours = Math.floor(totalMinutes / 60);
  const minutes = totalMinutes % 60;
  if (hours <= 0) return `${minutes}min`;
  return `${String(hours).padStart(2, '0')}h${String(minutes).padStart(2, '0')}`;
}

function formatPauseDuration(minutes: number): string {
  if (!Number.isFinite(minutes)) return '--';
  if (minutes < 60) return `${Math.max(1, Math.round(minutes))}min`;
  const hours = Math.floor(minutes / 60);
  const remainder = minutes % 60;
  return remainder > 0 ? `${hours}h${String(remainder).padStart(2, '0')}` : `${hours}h`;
}

function formatHourLabel(hour: number, isBoundary: boolean): string {
  const date = new Date(2000, 0, 1, hour, 0, 0, 0);
  if (isBoundary) {
    return date
      .toLocaleTimeString('en-US', { hour: 'numeric', hour12: true })
      .replace('\u202f', ' ');
  }
  return `${hour}:00`;
}

function resolveStandalonePauseHeightPx(): number {
  return PAUSE_CHIP_MIN_HEIGHT_PX;
}

function buildFavoritePoiPause(
  item: TimelineItem,
  rhythm?: RhythmState,
): Omit<AttachedPause, 'heightPx'> | null {
  if (!rhythm?.pauseAtFavoritePois) return null;
  if (item.kind !== 'poi' || !item.favorite || !item.poiCategory) return null;
  const durationMin = rhythm.poiPauseDurations[item.poiCategory];
  if (!Number.isFinite(durationMin) || (durationMin as number) <= 0) return null;
  return {
    id: `poi-pause-${item.id}`,
    durationMin: durationMin as number,
    visible: item.visible !== false,
  };
}

function resolveTotalDistanceM(items: TimelineItem[], prediction?: PredictionResult | null): number {
  const itemDistanceM = items.reduce(
    (maxDistanceM, item) => Math.max(maxDistanceM, (item.distanceKm ?? 0) * 1000),
    0,
  );
  return Math.max(prediction?.total_distance_m ?? 0, itemDistanceM);
}

function estimateElapsedSeconds(distanceKm: number): number {
  const fallbackSpeedKmh = 18;
  return (Math.max(0, distanceKm) / fallbackSpeedKmh) * 3600;
}

function buildTimedItems(
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
        ? date.getHours() * 60 + date.getMinutes() + date.getSeconds() / 60
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

function resolveMarkerKmStep(
  config?: Partial<TimelineRailConfig>,
  markerStepKm?: number,
): number {
  if (Number.isFinite(markerStepKm) && (markerStepKm as number) > 0) {
    return Math.max(5, Math.round((markerStepKm as number) / 5) * 5);
  }
  const kmPerRow = config?.kmPerRow ?? DEFAULT_TIMELINE_RAIL.kmPerRow;
  const rawStep = Math.max(KM_MARKER_MIN_STEP, kmPerRow * 5);
  return Math.ceil(rawStep / 5) * 5;
}

function buildDayWindow(anchor: Date): Date[] {
  const start = addDays(anchor, -3);
  return Array.from({ length: DAY_WINDOW_DAYS }, (_, index) => addDays(start, index));
}

function stopEventPropagation(event: React.MouseEvent<HTMLButtonElement>) {
  event.stopPropagation();
}

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
  const [now, setNow] = useState(() => new Date());

  useEffect(() => {
    setSelectedDayKey(defaultAnchorDayKey);
  }, [defaultAnchorDayKey]);

  useEffect(() => {
    const handle = window.setInterval(() => setNow(new Date()), 60_000);
    return () => window.clearInterval(handle);
  }, []);

  const selectedDayDate = useMemo(
    () => parseDayKey(selectedDayKey) ?? defaultAnchorDay,
    [defaultAnchorDay, selectedDayKey],
  );

  const dayWindow = useMemo(() => buildDayWindow(selectedDayDate), [selectedDayDate]);

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
    return primaryItems.filter((entry) => entry.dayKey === selectedDayKey);
  }, [primaryItems, reference.hasRealDate, selectedDayKey]);

  const filteredPauseItems = useMemo(() => {
    if (!reference.hasRealDate) return pauseItems;
    return pauseItems.filter((entry) => entry.dayKey === selectedDayKey);
  }, [pauseItems, reference.hasRealDate, selectedDayKey]);

  const maxDistanceKm = useMemo(
    () => items.reduce((maxDistance, item) => Math.max(maxDistance, item.distanceKm ?? 0), 0),
    [items],
  );

  const startMinutes = useMemo(() => {
    const visibleMinutes = [
      reference.startMinutes,
      ...filteredPrimaryItems.map((entry) => entry.minuteOfDay),
      ...filteredPauseItems.map((entry) => entry.minuteOfDay),
    ];
    const firstMinute = visibleMinutes.reduce(
      (minMinute, minute) => Math.min(minMinute, minute),
      Number.POSITIVE_INFINITY,
    );
    if (!Number.isFinite(firstMinute)) return reference.startMinutes;
    return Math.max(0, Math.floor(firstMinute / 60) * 60);
  }, [filteredPauseItems, filteredPrimaryItems, reference.startMinutes]);

  const endMinutes = useMemo(() => {
    const visibleMinutes = [
      reference.startMinutes,
      ...filteredPrimaryItems.map((entry) => entry.minuteOfDay),
      ...filteredPauseItems.map((entry) => entry.minuteOfDay),
    ];
    const lastVisibleMinute = visibleMinutes.reduce(
      (maxMinute, minute) => Math.max(maxMinute, minute),
      Number.NEGATIVE_INFINITY,
    );
    if (!Number.isFinite(lastVisibleMinute)) return startMinutes + 60;
    const roundedEnd = Math.ceil(lastVisibleMinute / 60) * 60;
    return Math.max(startMinutes + MIN_TIMELINE_HOURS * 60, roundedEnd);
  }, [filteredPauseItems, filteredPrimaryItems, reference.startMinutes, startMinutes]);

  const totalHours = Math.max(MIN_TIMELINE_HOURS, Math.ceil((endMinutes - startMinutes) / 60));
  const pauseAttachment = useMemo(() => {
    const usedPauseIds = new Set<string>();
    const attachedByEventId = new Map<string, Array<Omit<AttachedPause, 'heightPx'>>>();

    filteredPrimaryItems.forEach((entry) => {
      const attachedPauses: Array<Omit<AttachedPause, 'heightPx'>> = [];
      const favoritePoiPause = buildFavoritePoiPause(entry.item, rhythm);
      if (favoritePoiPause) {
        attachedPauses.push(favoritePoiPause);
      }

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
  }, [filteredPauseItems, filteredPrimaryItems, rhythm]);

  const hourRowHeightPx = BASE_HOUR_ROW_HEIGHT_PX * normalizedHourZoom;
  const pixelsPerMinute = hourRowHeightPx / 60;
  const canvasBaseHeight = Math.max(totalHours * hourRowHeightPx, 0);

  const scheduledEvents = useMemo(() => {
    return filteredPrimaryItems.map((entry, index): TimelineEvent => {
      const attachedPauses = (pauseAttachment.attachedByEventId.get(entry.item.id) ?? []).map(
        (pause) => ({
          ...pause,
          heightPx: ATTACHED_PAUSE_HEIGHT_PX,
        }),
      );

      const scheduledTopPx = (entry.minuteOfDay - startMinutes) * pixelsPerMinute;
      const pauseColumnHeightPx = attachedPauses.reduce(
        (totalHeight, pause, pauseIndex) =>
          totalHeight + pause.heightPx + (pauseIndex > 0 ? TIMELINE_BLOCK_GAP_PX : 0),
        0,
      );
      const cardHeightPx = Math.max(RAIL_ITEM_HEIGHT_PX, pauseColumnHeightPx);
      const heightPx = Math.max(cardHeightPx, pauseColumnHeightPx, RAIL_ITEM_HEIGHT_PX);

      return {
        ...entry,
        scheduledTopPx,
        topPx: scheduledTopPx,
        attachedPauses,
        toNextSeconds: resolveSecondsToNextPoi(filteredPrimaryItems, index),
        cardHeightPx,
        heightPx,
      };
    });
  }, [filteredPrimaryItems, pauseAttachment.attachedByEventId, pixelsPerMinute, startMinutes]);

  const scheduledStandalonePauses = useMemo((): TimelineStandalonePause[] => {
    return pauseAttachment.unattachedPauses.map((pause) => ({
      id: pause.item.id,
      scheduledTopPx: (pause.minuteOfDay - startMinutes) * pixelsPerMinute,
      topPx: (pause.minuteOfDay - startMinutes) * pixelsPerMinute,
      durationMin: pause.item.durationMin ?? 0,
      visible: pause.item.visible !== false,
      heightPx: resolveStandalonePauseHeightPx(),
      sortIndex: pause.sortIndex,
    }));
  }, [pauseAttachment.unattachedPauses, pixelsPerMinute, startMinutes]);

  const { events, standalonePauses, canvasHeight, firstVisibleTopPx } = useMemo(() => {
    const blocks: Array<{
      id: string;
      kind: 'event' | 'pause';
      scheduledTopPx: number;
      heightPx: number;
      sortIndex: number;
    }> = [
      ...scheduledEvents.map((event) => ({
        id: event.item.id,
        kind: 'event' as const,
        scheduledTopPx: event.scheduledTopPx,
        heightPx: event.heightPx,
        sortIndex: event.sortIndex,
      })),
      ...scheduledStandalonePauses.map((pause) => ({
        id: pause.id,
        kind: 'pause' as const,
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
    let nextAvailableTopPx = TIMELINE_VIEWPORT_TOP_INSET_PX;
    let maxBottomPx = canvasBaseHeight + TIMELINE_VIEWPORT_TOP_INSET_PX;
    let firstTopPx: number | null = null;

    blocks.forEach((block) => {
      const topPx = Math.max(block.scheduledTopPx, nextAvailableTopPx);
      positionedTopById.set(block.id, topPx);
      nextAvailableTopPx = topPx + block.heightPx + TIMELINE_BLOCK_GAP_PX;
      maxBottomPx = Math.max(maxBottomPx, topPx + block.heightPx);
      if (firstTopPx === null) firstTopPx = topPx;
    });

    return {
      events: scheduledEvents.map((event) => ({
        ...event,
        topPx: positionedTopById.get(event.item.id) ?? event.scheduledTopPx,
      })),
      standalonePauses: scheduledStandalonePauses.map((pause) => ({
        ...pause,
        topPx: positionedTopById.get(pause.id) ?? pause.scheduledTopPx,
      })),
      canvasHeight: maxBottomPx,
      firstVisibleTopPx: firstTopPx,
    };
  }, [canvasBaseHeight, scheduledEvents, scheduledStandalonePauses]);

  const kmMarkerStep = useMemo(
    () => resolveMarkerKmStep(config, markerStepKm),
    [config, markerStepKm],
  );
  const kmMarkers = useMemo(() => {
    const totalDistanceM = resolveTotalDistanceM(items, prediction);
    if (totalDistanceM <= 0) return [];

    const markers: Array<{ id: string; label: string; topPx: number }> = [];
    for (let km = kmMarkerStep; km < maxDistanceKm; km += kmMarkerStep) {
      const elapsedSeconds =
        elapsedSecondsAtDistance(prediction, km * 1000, totalDistanceM) ?? estimateElapsedSeconds(km);
      const markerDate = reference.reference
        ? new Date(reference.reference.getTime() + elapsedSeconds * 1000)
        : null;
      if (reference.hasRealDate && markerDate && toDayKey(markerDate) !== selectedDayKey) continue;
      const minuteOfDay = markerDate
        ? markerDate.getHours() * 60 + markerDate.getMinutes() + markerDate.getSeconds() / 60
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
  }, [canvasHeight, items, kmMarkerStep, maxDistanceKm, pixelsPerMinute, prediction, reference, selectedDayKey, startMinutes]);

  const hourMarks = useMemo(
    () => Array.from({ length: totalHours + 1 }, (_, index) => startMinutes / 60 + index),
    [startMinutes, totalHours],
  );

  const currentTimeLineTopPx = useMemo(() => {
    if (!reference.hasRealDate) return null;
    if (selectedDayKey !== toDayKey(now)) return null;
    const minuteOfDay = now.getHours() * 60 + now.getMinutes();
    if (minuteOfDay < startMinutes || minuteOfDay > endMinutes) return null;
    return (minuteOfDay - startMinutes) * pixelsPerMinute + TIMELINE_VIEWPORT_TOP_INSET_PX;
  }, [endMinutes, now, pixelsPerMinute, reference.hasRealDate, selectedDayKey, startMinutes]);

  const autoScrollKey = useMemo(
    () =>
      [
        selectedDayKey,
        Math.round(hourRowHeightPx),
        Math.round(firstVisibleTopPx ?? -1),
        Math.round(canvasHeight),
      ].join(':'),
    [canvasHeight, firstVisibleTopPx, hourRowHeightPx, selectedDayKey],
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

  const selectedDayHasEvents = events.length > 0 || standalonePauses.length > 0;

  return (
    <div className="rvi-tl-schedule" aria-label="Timeline journalière">
      <div className="rvi-tl-schedule__days" role="tablist" aria-label="Jours de la timeline">
        {dayWindow.map((day) => {
          const dayKey = toDayKey(day);
          const isSelected = dayKey === selectedDayKey;
          return (
            <button
              key={dayKey}
              type="button"
              role="tab"
              aria-selected={isSelected}
              className={`rvi-tl-schedule__day${isSelected ? ' is-selected' : ''}`}
              onClick={() => setSelectedDayKey(dayKey)}
            >
              <span className="rvi-tl-schedule__day-label">{formatDayLabel(day)}</span>
              <span className="rvi-tl-schedule__day-number">{day.getDate()}</span>
            </button>
          );
        })}
      </div>

      <div className="rvi-tl-schedule__legend" aria-hidden>
        <span className="rvi-tl-schedule__legend-spacer" />
        <span className="rvi-tl-schedule__legend-grid">
          <span className="rvi-tl-schedule__legend-name">Name</span>
          <span className="rvi-tl-schedule__legend-pause" />
          <span className="rvi-tl-schedule__legend-metric">From Start</span>
          <span className="rvi-tl-schedule__legend-next">To next</span>
        </span>
      </div>

      <div ref={viewportRef} className="rvi-tl-schedule__viewport">
        <div className="rvi-tl-schedule__times" aria-hidden>
          {hourMarks.map((hour, index) => {
            const topPx = index * hourRowHeightPx;
            return (
              <div
                key={hour}
                className="rvi-tl-schedule__time"
                style={{ top: topPx }}
              >
                <span className="rvi-tl-schedule__time-label">
                  {formatHourLabel(hour, index === 0 || index === hourMarks.length - 1)}
                </span>
              </div>
            );
          })}

          {kmMarkers.map((marker) => (
            <span
              key={marker.id}
              className="rvi-tl-schedule__km-marker"
              style={{ top: marker.topPx }}
            >
              {marker.label}
            </span>
          ))}
        </div>

        <div className="rvi-tl-schedule__canvas" style={{ height: canvasHeight }}>
          <div className="rvi-tl-schedule__grid" aria-hidden>
            {Array.from({ length: totalHours }).map((_, index) => (
              <div key={index} className="rvi-tl-schedule__grid-row" />
            ))}
          </div>

          {currentTimeLineTopPx !== null ? (
            <div className="rvi-tl-schedule__now" style={{ top: currentTimeLineTopPx }}>
              <span className="rvi-tl-schedule__now-dot" />
              <span className="rvi-tl-schedule__now-label">
                {now.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })}
              </span>
            </div>
          ) : null}

          {!selectedDayHasEvents ? (
            <div className="rvi-tl-schedule__empty">
              Aucun checkpoint planifié pour cette journée.
            </div>
          ) : null}

          {events.map((event, index) => {
            const visible = event.item.visible !== false;
            const selected = selectedIds?.has(event.item.id) ?? false;
            const hasAttachedPauses = event.attachedPauses.length > 0;
            const title =
              event.item.kind === 'pause' && event.item.durationMin
                ? formatPauseDuration(event.item.durationMin)
                : event.item.label || 'Point sans nom';
            const eventStyle = {
              top: event.topPx,
              minHeight: event.heightPx,
              '--rvi-tl-card-height': `${event.cardHeightPx}px`,
              animationDelay: `${Math.min(index * 18, 240)}ms`,
            } as CSSProperties;

            return (
              <article
                key={event.item.id}
                className={`rvi-tl-schedule__event${selected ? ' is-selected' : ''}`}
                style={eventStyle}
                data-kind={event.item.kind}
              >
                <button
                  type="button"
                  className="rvi-tl-schedule__event-card"
                  aria-pressed={selected}
                  onClick={() => onToggleSelect?.(event.item.id, !selected)}
                >
                  <span
                    className={`rvi-tl-schedule__event-main${hasAttachedPauses ? ' has-pause' : ''}`}
                  >
                    <span className="rvi-tl-schedule__event-icon" aria-hidden>
                      <KindBadge kind={event.item.kind} poiCategory={event.item.poiCategory} />
                    </span>
                    <span className="rvi-tl-schedule__event-name" title={title}>
                      {title}
                    </span>
                    {hasAttachedPauses ? (
                      <span className="rvi-tl-schedule__event-pauses">
                        {event.attachedPauses.map((pause) => (
                          <span
                            key={pause.id}
                            className={`rvi-tl-schedule__pause-chip${pause.visible ? ' is-visible' : ''}`}
                          >
                            <span className="rvi-tl-schedule__pause-chip-icon" aria-hidden>
                              <IconPauseCircle size={14} />
                            </span>
                            <span>{formatPauseDuration(pause.durationMin)}</span>
                          </span>
                        ))}
                      </span>
                    ) : null}
                    <span className="rvi-tl-schedule__event-metric rvi-tl-schedule__event-metric--from-start">
                      {formatDistanceLabel(event.distanceKm)}
                    </span>
                    <span className="rvi-tl-schedule__event-metric rvi-tl-schedule__event-metric--next">
                      {formatLegDuration(event.toNextSeconds)}
                    </span>
                    <span
                      className={`rvi-tl-schedule__event-favorite${event.item.favorite ? ' is-active' : ''}`}
                      aria-hidden
                    >
                      <IconStar size={12} />
                    </span>
                  </span>
                </button>

                <span className="rvi-tl-schedule__actions">
                  <button
                    type="button"
                    className={`rvi-tl-schedule__action rvi-tl-schedule__action--visibility${visible ? ' is-on' : ''}`}
                    onClick={(actionEvent) => {
                      stopEventPropagation(actionEvent);
                      onToggleVisibility?.(event.item.id, !visible);
                    }}
                    aria-label={visible ? 'Masquer' : 'Afficher'}
                    aria-pressed={visible}
                  >
                    <IconEye size={12} />
                  </button>
                  <button
                    type="button"
                    className={`rvi-tl-schedule__action rvi-tl-schedule__action--favorite${event.item.favorite ? ' is-on is-fav' : ''}`}
                    onClick={(actionEvent) => {
                      stopEventPropagation(actionEvent);
                      onToggleFavorite?.(event.item.id, !event.item.favorite);
                    }}
                    aria-label="Favori"
                    aria-pressed={!!event.item.favorite}
                  >
                    <IconStar size={12} />
                  </button>
                  <button
                    type="button"
                    className="rvi-tl-schedule__action rvi-tl-schedule__action--danger rvi-tl-schedule__action--remove"
                    onClick={(actionEvent) => {
                      stopEventPropagation(actionEvent);
                      onRemove?.(event.item.id);
                    }}
                    aria-label="Supprimer"
                  >
                    <IconTrash size={12} />
                  </button>
                </span>
              </article>
            );
          })}

          {standalonePauses.map((pause, index) => (
            <div
              key={pause.id}
              className="rvi-tl-schedule__pause rvi-tl-schedule__pause--standalone"
              style={{
                top: pause.topPx,
                '--rvi-tl-pause-height': `${pause.heightPx}px`,
                animationDelay: `${Math.min((events.length + index) * 18, 240)}ms`,
              } as CSSProperties}
            >
              <IconPauseCircle size={14} />
              <span>{formatPauseDuration(pause.durationMin)}</span>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}

// Re-export helpful constants for tests / consumers.
export { RAIL_HEADER_HEIGHT_PX, RAIL_ITEM_HEIGHT_PX };
