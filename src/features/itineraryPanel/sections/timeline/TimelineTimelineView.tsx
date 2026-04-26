/**
 * "Timeline" — day schedule view rebuilt from the Figma timeline design.
 *
 * Instead of a pure kilometre rail, the view projects itinerary checkpoints
 * onto a day/hour canvas using the FIT prediction when available. Distances
 * still drive placement fallback and km markers, but the user now navigates a
 * date strip and reads the route as scheduled checkpoints.
 */
import { useEffect, useMemo, useState } from 'react';
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
}

interface TimelineEvent extends TimedTimelineItem {
  topPx: number;
  attachedPauses: AttachedPause[];
  toNextSeconds: number | null;
}

const RAIL_HEADER_HEIGHT_PX = 30;
const RAIL_ITEM_HEIGHT_PX = 32;
const PAUSE_ITEM_HEIGHT_PX = 28;
const HOUR_ROW_HEIGHT_PX = 96;
const CARD_VERTICAL_GAP_PX = 4;
const DEFAULT_START_MINUTES = 8 * 60;
const MIN_TIMELINE_HOURS = 1;
const DAY_WINDOW_DAYS = 6;
const KM_MARKER_MIN_STEP = 25;

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

function resolveMarkerKmStep(config?: Partial<TimelineRailConfig>): number {
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
  selectedIds,
  onToggleSelect,
  onToggleVisibility,
  onToggleFavorite,
  onRemove,
}: TimelineTimelineViewProps) {
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
  const canvasHeight = totalHours * HOUR_ROW_HEIGHT_PX;

  const events = useMemo(() => {
    const usedPauseIds = new Set<string>();
    let previousBottom = -Infinity;

    return filteredPrimaryItems.map((entry, index): TimelineEvent => {
      const nextEntry = filteredPrimaryItems[index + 1] ?? null;
      const attachedPauses = filteredPauseItems
        .filter((pause) => {
          if (usedPauseIds.has(pause.item.id)) return false;
          return Math.abs(pause.distanceKm - entry.distanceKm) <= 0.15;
        })
        .map((pause) => {
          usedPauseIds.add(pause.item.id);
          return {
            id: pause.item.id,
            durationMin: pause.item.durationMin ?? 0,
            visible: pause.item.visible !== false,
          };
        });

      const naturalTopPx = ((entry.minuteOfDay - startMinutes) / 60) * HOUR_ROW_HEIGHT_PX;
      const topPx = Math.max(naturalTopPx, previousBottom + CARD_VERTICAL_GAP_PX);
      previousBottom = topPx + RAIL_ITEM_HEIGHT_PX;

      return {
        ...entry,
        topPx,
        attachedPauses,
        toNextSeconds:
          nextEntry && Number.isFinite(nextEntry.elapsedSeconds)
            ? Math.max(0, nextEntry.elapsedSeconds - entry.elapsedSeconds)
            : null,
      };
    });
  }, [filteredPauseItems, filteredPrimaryItems, startMinutes]);

  const standalonePauses = useMemo(() => {
    const attachedIds = new Set(events.flatMap((event) => event.attachedPauses.map((pause) => pause.id)));
    let previousBottom = events.reduce(
      (maxBottom, event) => Math.max(maxBottom, event.topPx + RAIL_ITEM_HEIGHT_PX),
      -Infinity,
    );

    return filteredPauseItems
      .filter((pause) => !attachedIds.has(pause.item.id))
      .map((pause) => {
        const naturalTopPx = ((pause.minuteOfDay - startMinutes) / 60) * HOUR_ROW_HEIGHT_PX;
        const topPx = Math.max(naturalTopPx, previousBottom + CARD_VERTICAL_GAP_PX);
        previousBottom = topPx + PAUSE_ITEM_HEIGHT_PX;
        return {
          id: pause.item.id,
          topPx,
          durationMin: pause.item.durationMin ?? 0,
          visible: pause.item.visible !== false,
        };
      });
  }, [events, filteredPauseItems, startMinutes]);

  const kmMarkerStep = useMemo(() => resolveMarkerKmStep(config), [config]);
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
      const topPx = ((minuteOfDay - startMinutes) / 60) * HOUR_ROW_HEIGHT_PX;
      if (topPx < -20 || topPx > canvasHeight + 20) continue;
      markers.push({
        id: `km-${km}`,
        label: `km${Math.round(km)}`,
        topPx,
      });
    }
    return markers;
  }, [canvasHeight, items, kmMarkerStep, maxDistanceKm, prediction, reference, selectedDayKey, startMinutes]);

  const hourMarks = useMemo(
    () => Array.from({ length: totalHours + 1 }, (_, index) => startMinutes / 60 + index),
    [startMinutes, totalHours],
  );

  const currentTimeLineTopPx = useMemo(() => {
    if (!reference.hasRealDate) return null;
    if (selectedDayKey !== toDayKey(now)) return null;
    const minuteOfDay = now.getHours() * 60 + now.getMinutes();
    if (minuteOfDay < startMinutes || minuteOfDay > endMinutes) return null;
    return ((minuteOfDay - startMinutes) / 60) * HOUR_ROW_HEIGHT_PX;
  }, [endMinutes, now, reference.hasRealDate, selectedDayKey, startMinutes]);

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
        <span className="rvi-tl-schedule__legend-name">Name</span>
        <span className="rvi-tl-schedule__legend-metric">From Start</span>
        <span className="rvi-tl-schedule__legend-next">To next</span>
      </div>

      <div className="rvi-tl-schedule__viewport">
        <div className="rvi-tl-schedule__times" aria-hidden>
          {hourMarks.map((hour, index) => {
            const topPx = index * HOUR_ROW_HEIGHT_PX;
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
            const title =
              event.item.kind === 'pause' && event.item.durationMin
                ? formatPauseDuration(event.item.durationMin)
                : event.item.label || 'Point sans nom';

            return (
              <article
                key={event.item.id}
                className={`rvi-tl-schedule__event${selected ? ' is-selected' : ''}`}
                style={{
                  top: event.topPx,
                  animationDelay: `${Math.min(index * 18, 240)}ms`,
                }}
                data-kind={event.item.kind}
              >
                <button
                  type="button"
                  className="rvi-tl-schedule__event-card"
                  aria-pressed={selected}
                  onClick={() => onToggleSelect?.(event.item.id, !selected)}
                >
                  <span className="rvi-tl-schedule__event-main">
                    <span className="rvi-tl-schedule__event-icon" aria-hidden>
                      <KindBadge kind={event.item.kind} poiCategory={event.item.poiCategory} />
                    </span>
                    <span className="rvi-tl-schedule__event-name" title={title}>
                      {title}
                    </span>
                    <span className="rvi-tl-schedule__event-metric">
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

                <div className="rvi-tl-schedule__event-side">
                  {event.attachedPauses.map((pause) => (
                    <span
                      key={pause.id}
                      className={`rvi-tl-schedule__pause${pause.visible ? ' is-visible' : ''}`}
                    >
                      <IconPauseCircle size={14} />
                      <span>{formatPauseDuration(pause.durationMin)}</span>
                    </span>
                  ))}
                </div>

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
                animationDelay: `${Math.min((events.length + index) * 18, 240)}ms`,
              }}
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
