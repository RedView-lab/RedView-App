import type { CSSProperties, MouseEvent as ReactMouseEvent, RefObject } from 'react';
import {
  IconEye,
  IconPauseCircle,
  IconStar,
  IconTrash,
} from '../../../components/icons';
import { KindBadge } from '../KindBadge';
import { TIMELINE_VIEWPORT_TOP_INSET_PX } from './constants';
import type { KmMarker, TimelineEvent, TimelineStandalonePause } from './types';
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
  totalHours: number;
  currentTimeLineTopPx: number | null;
  now: Date;
  visibleWindowHasEvents: boolean;
  events: TimelineEvent[];
  standalonePauses: TimelineStandalonePause[];
  standalonePauseDayKeyById: ReadonlyMap<string, string | null>;
  selectedIds?: ReadonlySet<string>;
  onToggleSelect?: (id: string, selected: boolean) => void;
  onToggleVisibility?: (id: string, visible: boolean) => void;
  onToggleFavorite?: (id: string, favorite: boolean) => void;
  onRemove?: (id: string) => void;
  resolveColumnPlacement: (dayKey: string | null) => CSSProperties;
  resolveNowLinePlacement: () => CSSProperties;
}

export function TimelineScheduleCanvas({
  viewportRef,
  hourMarks,
  hourRowHeightPx,
  kmMarkers,
  canvasStyle,
  displayDays,
  selectedDayKey,
  totalHours,
  currentTimeLineTopPx,
  now,
  visibleWindowHasEvents,
  events,
  standalonePauses,
  standalonePauseDayKeyById,
  selectedIds,
  onToggleSelect,
  onToggleVisibility,
  onToggleFavorite,
  onRemove,
  resolveColumnPlacement,
  resolveNowLinePlacement,
}: TimelineScheduleCanvasProps) {
  return (
    <div ref={viewportRef} className="rvi-tl-schedule__viewport">
      <div className="rvi-tl-schedule__times" aria-hidden>
        {hourMarks.map((hour, index) => {
          const topPx = index * hourRowHeightPx + TIMELINE_VIEWPORT_TOP_INSET_PX;
          return (
            <div key={hour} className="rvi-tl-schedule__time" style={{ top: topPx }}>
              <span className="rvi-tl-schedule__time-label">
                {formatHourLabel(hour, index === 0 || index === hourMarks.length - 1)}
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

      <div className="rvi-tl-schedule__canvas" style={canvasStyle}>
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
                {Array.from({ length: totalHours }).map((_, index) => (
                  <div key={`${dayKey}-${index}`} className="rvi-tl-schedule__grid-row" />
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
              ...resolveColumnPlacement(standalonePauseDayKeyById.get(pause.id) ?? null),
            } as CSSProperties}
          >
            <IconPauseCircle size={14} />
            <span>{formatPauseDuration(pause.durationMin)}</span>
          </div>
        ))}
      </div>
    </div>
  );
}

function stopEventPropagation(event: ReactMouseEvent<HTMLButtonElement>) {
  event.stopPropagation();
}