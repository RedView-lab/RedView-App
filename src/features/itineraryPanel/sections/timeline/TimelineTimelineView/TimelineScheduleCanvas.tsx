import {
  useEffect,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
  type MouseEvent as ReactMouseEvent,
  type PointerEvent as ReactPointerEvent,
  type RefObject,
} from 'react';
import {
  IconEye,
  IconStar,
  IconTrash,
} from '../../../components/icons';
import { KindBadge } from '../KindBadge';
import {
  MINUTES_PER_DAY,
  TIMELINE_VIEWPORT_BOTTOM_INSET_PX,
  TIMELINE_VIEWPORT_TOP_INSET_PX,
} from './constants';
import type {
  KmMarker,
  StartReference,
  TimelineEvent,
  TimelineStandalonePause,
} from './types';
import {
  formatDistanceLabel,
  formatHourLabel,
  formatLegDuration,
  formatPauseDuration,
} from './utils';

interface TimelineScheduleCanvasProps {
  viewportRef: RefObject<HTMLDivElement | null>;
  hourMarks: number[];
  hourRowHeightPx: number;
  kmMarkers: KmMarker[];
  canvasStyle: CSSProperties;
  displayDays: Date[];
  selectedDayKey: string;
  currentTimeLineTopPx: number | null;
  now: Date;
  visibleWindowHasEvents: boolean;
  events: TimelineEvent[];
  standalonePauses: TimelineStandalonePause[];
  standalonePauseDayKeyById: ReadonlyMap<string, string | null>;
  reference: StartReference;
  startMinutes: number;
  pixelsPerMinute: number;
  canvasHeight: number;
  selectedIds?: ReadonlySet<string>;
  onToggleSelect?: (id: string, selected: boolean) => void;
  onToggleVisibility?: (id: string, visible: boolean) => void;
  onMovePauseScheduled?: (id: string, scheduledElapsedSeconds: number) => void;
  onToggleFavorite?: (id: string, favorite: boolean) => void;
  onRemove?: (id: string) => void;
  resolveColumnPlacement: (dayKey: string | null) => CSSProperties;
  resolveNowLinePlacement: () => CSSProperties;
}

interface PauseDragState {
  id: string;
  offsetY: number;
  heightPx: number;
  topPx: number;
  dayKey: string | null;
  scheduledElapsedSeconds: number;
}

export function TimelineScheduleCanvas({
  viewportRef,
  hourMarks,
  kmMarkers,
  canvasStyle,
  displayDays,
  selectedDayKey,
  currentTimeLineTopPx,
  now,
  visibleWindowHasEvents,
  events,
  standalonePauses,
  standalonePauseDayKeyById,
  reference,
  startMinutes,
  pixelsPerMinute,
  canvasHeight,
  selectedIds,
  onToggleSelect,
  onToggleVisibility,
  onMovePauseScheduled,
  onToggleFavorite,
  onRemove,
  resolveColumnPlacement,
  resolveNowLinePlacement,
}: TimelineScheduleCanvasProps) {
  const canvasRef = useRef<HTMLDivElement | null>(null);
  const [dragState, setDragState] = useState<PauseDragState | null>(null);
  const hourMarkSegments = useMemo(
    () => hourMarks.slice(0, -1).map((markMinute, index) => ({
      key: `${markMinute}-${hourMarks[index + 1]}`,
      topPx: (markMinute - startMinutes) * pixelsPerMinute,
      heightPx: (hourMarks[index + 1] - markMinute) * pixelsPerMinute,
    })),
    [hourMarks, pixelsPerMinute, startMinutes],
  );

  useEffect(() => {
    if (!dragState) return;

    const previousUserSelect = document.body.style.userSelect;
    document.body.style.userSelect = 'none';

    const handlePointerMove = (event: PointerEvent) => {
      const target = resolvePauseDragTarget(
        event.clientX,
        event.clientY,
        dragState,
        canvasRef.current,
        canvasHeight,
        displayDays,
        reference,
        startMinutes,
        pixelsPerMinute,
      );
      if (!target) return;
      setDragState((current) => (current
        ? {
            ...current,
            topPx: target.topPx,
            dayKey: target.dayKey,
            scheduledElapsedSeconds: target.scheduledElapsedSeconds,
          }
        : current));
    };

    const handlePointerUp = (event: PointerEvent) => {
      const target = resolvePauseDragTarget(
        event.clientX,
        event.clientY,
        dragState,
        canvasRef.current,
        canvasHeight,
        displayDays,
        reference,
        startMinutes,
        pixelsPerMinute,
      );
      if (target) {
        onMovePauseScheduled?.(dragState.id, target.scheduledElapsedSeconds);
      }
      setDragState(null);
    };

    const handlePointerCancel = () => {
      setDragState(null);
    };

    window.addEventListener('pointermove', handlePointerMove);
    window.addEventListener('pointerup', handlePointerUp);
    window.addEventListener('pointercancel', handlePointerCancel);

    return () => {
      document.body.style.userSelect = previousUserSelect;
      window.removeEventListener('pointermove', handlePointerMove);
      window.removeEventListener('pointerup', handlePointerUp);
      window.removeEventListener('pointercancel', handlePointerCancel);
    };
  }, [
    canvasHeight,
    displayDays,
    dragState,
    onMovePauseScheduled,
    pixelsPerMinute,
    reference,
    startMinutes,
  ]);

  const handlePausePointerDown = (
    event: ReactPointerEvent<HTMLDivElement>,
    pause: TimelineStandalonePause,
  ) => {
    if (pause.source !== 'manual' || !onMovePauseScheduled) return;

    event.preventDefault();
    event.stopPropagation();

    const blockRect = event.currentTarget.getBoundingClientRect();
    setDragState({
      id: pause.id,
      offsetY: event.clientY - blockRect.top,
      heightPx: pause.heightPx,
      topPx: pause.topPx,
      dayKey: pause.dayKey ?? standalonePauseDayKeyById.get(pause.id) ?? null,
      scheduledElapsedSeconds: 0,
    });
  };

  return (
    <div ref={viewportRef} className="rvi-tl-schedule__viewport">
      <div className="rvi-tl-schedule__times" aria-hidden>
        {hourMarks.map((markMinute, index) => {
          const topPx = (markMinute - startMinutes) * pixelsPerMinute + TIMELINE_VIEWPORT_TOP_INSET_PX;
          return (
            <div key={markMinute} className="rvi-tl-schedule__time" style={{ top: topPx }}>
              <span className="rvi-tl-schedule__time-label">
                {formatHourLabel(markMinute, index === 0 || index === hourMarks.length - 1)}
              </span>
            </div>
          );
        })}

        {kmMarkers.map((marker) => (
          <span key={marker.id} className="rvi-tl-schedule__km-marker" style={{ top: marker.topPx }}>
            {marker.label}
          </span>
        ))}
      </div>

      <div ref={canvasRef} className="rvi-tl-schedule__canvas" style={canvasStyle}>
        <div className="rvi-tl-schedule__grid" aria-hidden>
          {displayDays.map((day) => {
            const dayKey = [
              day.getFullYear(),
              String(day.getMonth() + 1).padStart(2, '0'),
              String(day.getDate()).padStart(2, '0'),
            ].join('-');
            const isSelected = dayKey === selectedDayKey;
            return (
              <div key={dayKey} className={`rvi-tl-schedule__grid-day${isSelected ? ' is-selected' : ''}`}>
                {hourMarkSegments.map((segment) => (
                  <div
                    key={`${dayKey}-${segment.key}`}
                    className="rvi-tl-schedule__grid-row"
                    style={{
                      height: segment.heightPx,
                      minHeight: segment.heightPx,
                    }}
                  />
                ))}
              </div>
            );
          })}
        </div>

        {currentTimeLineTopPx !== null ? (
          <div className="rvi-tl-schedule__now" style={{ top: currentTimeLineTopPx, ...resolveNowLinePlacement() }}>
            <span className="rvi-tl-schedule__now-dot" />
            <span className="rvi-tl-schedule__now-label">
              {now.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })}
            </span>
          </div>
        ) : null}

        {!visibleWindowHasEvents ? (
          <div className="rvi-tl-schedule__empty">
            Aucun checkpoint planifie sur la plage affichee.
          </div>
        ) : null}

        {events.flatMap((event, eventIndex) => {
          const selected = selectedIds?.has(event.item.id) ?? false;
          return event.spanSegments.slice(1).map((segment, segmentIndex) => (
            <div
              key={`${event.item.id}-span-${segment.dayKey ?? 'single'}-${segmentIndex}`}
              className={`rvi-tl-schedule__event-span${selected ? ' is-selected' : ''}`}
              style={{
                top: segment.topPx,
                minHeight: segment.heightPx,
                height: segment.heightPx,
                animationDelay: `${Math.min((eventIndex + segmentIndex + 1) * 18, 240)}ms`,
                ...resolveColumnPlacement(segment.dayKey),
              } as CSSProperties}
              data-kind={event.item.kind}
              aria-hidden
            />
          ));
        })}

        {events.map((event, index) => {
          const visible = event.item.visible !== false;
          const selected = selectedIds?.has(event.item.id) ?? false;
          const hasAttachedPauses = event.attachedPauses.length > 0;
          const isFavoriteLocked = event.item.kind === 'poi' && hasAttachedPauses && event.item.favorite;
          const title =
            event.item.kind === 'pause' && event.item.durationMin
              ? formatPauseDuration(event.item.durationMin)
              : event.item.label || 'Point sans nom';
          const eventStyle = {
            top: event.topPx,
            minHeight: event.heightPx,
            '--rvi-tl-card-height': `${event.cardHeightPx}px`,
            animationDelay: `${Math.min(index * 18, 240)}ms`,
            ...resolveColumnPlacement(event.spanSegments[0]?.dayKey ?? event.dayKey),
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
                <span className={`rvi-tl-schedule__event-main${hasAttachedPauses ? ' has-pause' : ''}`}>
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
                            <KindBadge kind="pause" size={24} />
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
                    if (isFavoriteLocked) return;
                    onToggleFavorite?.(event.item.id, !event.item.favorite);
                  }}
                  aria-label={isFavoriteLocked ? 'Favori verrouille par pause automatique' : 'Favori'}
                  aria-pressed={!!event.item.favorite}
                  disabled={isFavoriteLocked}
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

        {standalonePauses.map((pause, index) => {
          const dragging = dragState?.id === pause.id;
          const pauseDayKey = dragging
            ? dragState.dayKey
            : standalonePauseDayKeyById.get(pause.id) ?? pause.dayKey ?? null;
          const pauseTopPx = dragging ? dragState.topPx : pause.topPx;

          return (
            <div
              key={pause.id}
              className={[
                'rvi-tl-schedule__pause',
                'rvi-tl-schedule__pause--standalone',
                pause.visible ? 'is-visible' : '',
                pause.source === 'manual' && onMovePauseScheduled ? 'is-draggable' : '',
                dragging ? 'is-dragging' : '',
              ].filter(Boolean).join(' ')}
              data-source={pause.source}
              onPointerDown={(event) => handlePausePointerDown(event, pause)}
              style={{
                top: pauseTopPx,
                '--rvi-tl-pause-height': `${pause.heightPx}px`,
                animationDelay: `${Math.min((events.length + index) * 18, 240)}ms`,
                ...resolveColumnPlacement(pauseDayKey),
              } as CSSProperties}
            >
              <div
                className="rvi-tl-schedule__pause-card"
                onPointerDown={(event) => handlePausePointerDown(event, pause)}
              >
                <div className="rvi-tl-schedule__pause-main">
                  <span
                    className="rvi-tl-schedule__pause-chip rvi-tl-schedule__pause-chip--standalone"
                    title={formatPauseDuration(pause.durationMin)}
                  >
                    <span className="rvi-tl-schedule__pause-chip-icon" aria-hidden>
                      <KindBadge kind="pause" size={24} />
                    </span>
                    <span>{formatPauseDuration(pause.durationMin)}</span>
                  </span>
                  <span className="rvi-tl-schedule__event-metric rvi-tl-schedule__pause-metric--from-start">
                    {formatDistanceLabel(pause.distanceKm)}
                  </span>
                  <span className="rvi-tl-schedule__event-metric rvi-tl-schedule__pause-metric--next">
                    {formatLegDuration(pause.toNextSeconds)}
                  </span>
                  <span className="rvi-tl-schedule__event-favorite rvi-tl-schedule__pause-favorite" aria-hidden>
                    <IconStar size={12} />
                  </span>
                </div>
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}

function resolvePauseDragTarget(
  clientX: number,
  clientY: number,
  dragState: PauseDragState,
  canvas: HTMLDivElement | null,
  canvasHeight: number,
  displayDays: Date[],
  reference: StartReference,
  startMinutes: number,
  pixelsPerMinute: number,
): { topPx: number; dayKey: string | null; scheduledElapsedSeconds: number } | null {
  if (!canvas) return null;

  const rect = canvas.getBoundingClientRect();
  const minTopPx = TIMELINE_VIEWPORT_TOP_INSET_PX;
  const maxTopPx = Math.max(
    minTopPx,
    canvasHeight - dragState.heightPx - TIMELINE_VIEWPORT_BOTTOM_INSET_PX,
  );
  const topPx = clamp(clientY - rect.top - dragState.offsetY, minTopPx, maxTopPx);

  let dayKey = dragState.dayKey;
  if (reference.hasRealDate && displayDays.length > 0) {
    const relativeX = clamp(clientX - rect.left, 0, Math.max(0, rect.width - 1));
    const columnWidth = rect.width / Math.max(1, displayDays.length);
    const dayIndex = Math.min(displayDays.length - 1, Math.floor(relativeX / Math.max(columnWidth, 1)));
    dayKey = toDayKey(displayDays[dayIndex] ?? displayDays[0]!);
  }

  const minuteOfDay = clamp(
    startMinutes + (topPx - TIMELINE_VIEWPORT_TOP_INSET_PX) / Math.max(pixelsPerMinute, 0.001),
    0,
    MINUTES_PER_DAY,
  );

  if (reference.reference && reference.hasRealDate && dayKey) {
    const day = displayDays.find((entry) => toDayKey(entry) === dayKey) ?? displayDays[0];
    if (!day) {
      return {
        topPx,
        dayKey,
        scheduledElapsedSeconds: Math.max(0, (minuteOfDay - startMinutes) * 60),
      };
    }

    const scheduledDate = new Date(
      day.getFullYear(),
      day.getMonth(),
      day.getDate(),
      0,
      0,
      0,
      0,
    );
    scheduledDate.setMinutes(minuteOfDay, 0, 0);

    return {
      topPx,
      dayKey,
      scheduledElapsedSeconds: Math.max(
        0,
        (scheduledDate.getTime() - reference.reference.getTime()) / 1000,
      ),
    };
  }

  return {
    topPx,
    dayKey,
    scheduledElapsedSeconds: Math.max(0, (minuteOfDay - startMinutes) * 60),
  };
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

function toDayKey(date: Date): string {
  return [
    date.getFullYear(),
    String(date.getMonth() + 1).padStart(2, '0'),
    String(date.getDate()).padStart(2, '0'),
  ].join('-');
}

function stopEventPropagation(event: ReactMouseEvent<HTMLButtonElement>) {
  event.stopPropagation();
}