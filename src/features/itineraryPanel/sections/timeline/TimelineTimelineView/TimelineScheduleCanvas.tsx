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
import { useAppI18n } from '@/shared/i18n';
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
import { formatPauseDurationInput, parsePauseDurationInput } from '../../../lib/schedule';
import type { PoiCategory } from '../../../types';
import type {
  KmMarker,
  StartReference,
  TimelineEvent,
  TimelineStandalonePause,
} from './types';
import { positionTimelineBlocks } from './utils';
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
  onChangePauseDuration?: (id: string, durationMin: number) => void;
  onChangeIntervalPauseDuration?: (pauseIntervalId: string, durationMin: number) => void;
  onChangeFavoritePoiPauseDuration?: (category: PoiCategory, durationMin: number) => void;
  onToggleFavorite?: (id: string, favorite: boolean) => void;
  onRemove?: (id: string) => void;
  resolveColumnPlacement: (dayKey: string | null) => CSSProperties;
  resolveNowLinePlacement: () => CSSProperties;
}

interface PauseDragState {
  id: string;
  source: TimelineStandalonePause['source'];
  poiCategory?: PoiCategory;
  durationMin: number;
  distanceKm: number;
  toNextSeconds: number | null;
  offsetY: number;
  heightPx: number;
  topPx: number;
  dayKey: string | null;
  scheduledElapsedSeconds: number;
}

interface PauseDurationEditState {
  kind: 'manual' | 'interval' | 'favorite-poi';
  targetId: string;
  draft: string;
  previousDurationMin: number;
  poiCategory?: PoiCategory;
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
  onChangePauseDuration,
  onChangeIntervalPauseDuration,
  onChangeFavoritePoiPauseDuration,
  onToggleFavorite,
  onRemove,
  resolveColumnPlacement,
  resolveNowLinePlacement,
}: TimelineScheduleCanvasProps) {
  const { t } = useAppI18n();
  const canvasRef = useRef<HTMLDivElement | null>(null);
  const pauseDurationInputRef = useRef<HTMLInputElement | null>(null);
  const [dragState, setDragState] = useState<PauseDragState | null>(null);
  const [editingPauseDuration, setEditingPauseDuration] = useState<PauseDurationEditState | null>(null);
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

  useEffect(() => {
    if (!editingPauseDuration) return;
    const input = pauseDurationInputRef.current;
    if (!input) return;
    input.focus();
    input.select();
  }, [editingPauseDuration]);

  const handlePausePointerDown = (
    event: ReactPointerEvent<HTMLElement>,
    pause: Pick<
      TimelineStandalonePause,
      'id' | 'source' | 'poiCategory' | 'durationMin' | 'distanceKm' | 'toNextSeconds' | 'heightPx' | 'topPx' | 'dayKey'
    >,
  ) => {
    if (!onMovePauseScheduled) return;
    if (pause.source === 'favorite-poi') return;

    event.preventDefault();
    event.stopPropagation();

    const blockRect = event.currentTarget.getBoundingClientRect();
    const canvasRect = canvasRef.current?.getBoundingClientRect();
    const minTopPx = TIMELINE_VIEWPORT_TOP_INSET_PX;
    const maxTopPx = Math.max(
      minTopPx,
      canvasHeight - pause.heightPx - TIMELINE_VIEWPORT_BOTTOM_INSET_PX,
    );
    const initialTopPx = canvasRect
      ? clamp(blockRect.top - canvasRect.top, minTopPx, maxTopPx)
      : clamp(pause.topPx, minTopPx, maxTopPx);

    setDragState({
      id: pause.id,
      source: pause.source,
      poiCategory: pause.poiCategory,
      durationMin: pause.durationMin,
      distanceKm: pause.distanceKm,
      toNextSeconds: pause.toNextSeconds,
      offsetY: event.clientY - blockRect.top,
      heightPx: pause.heightPx,
      topPx: initialTopPx,
      dayKey: pause.dayKey ?? standalonePauseDayKeyById.get(pause.id) ?? null,
      scheduledElapsedSeconds: 0,
    });
  };

  const handleFavoritePoiPauseDurationClick = (
    poiCategory: PoiCategory | undefined,
    currentDurationMin: number,
    event: ReactMouseEvent<HTMLSpanElement>,
  ) => {
    event.preventDefault();
    event.stopPropagation();
    if (!poiCategory || !onChangeFavoritePoiPauseDuration) return;
    setEditingPauseDuration({
      kind: 'favorite-poi',
      targetId: `poi:${poiCategory}`,
      draft: formatPauseDurationInput(currentDurationMin),
      previousDurationMin: currentDurationMin,
      poiCategory,
    });
  };

  const handleStandalonePauseDurationClick = (
    pause: TimelineStandalonePause,
    event: ReactMouseEvent<HTMLSpanElement>,
  ) => {
    event.preventDefault();
    event.stopPropagation();
    if (pause.source === 'manual' && onChangePauseDuration) {
      setEditingPauseDuration({
        kind: 'manual',
        targetId: pause.id,
        draft: formatPauseDurationInput(pause.durationMin),
        previousDurationMin: pause.durationMin,
      });
      return;
    }

    if (pause.source === 'favorite-poi' && pause.poiCategory && onChangeFavoritePoiPauseDuration) {
      setEditingPauseDuration({
        kind: 'favorite-poi',
        targetId: `poi:${pause.poiCategory}`,
        draft: formatPauseDurationInput(pause.durationMin),
        previousDurationMin: pause.durationMin,
        poiCategory: pause.poiCategory,
      });
      return;
    }

    const pauseIntervalId = resolveIntervalPauseId(pause.id);
    if (!pauseIntervalId || !onChangeIntervalPauseDuration) return;
    setEditingPauseDuration({
      kind: 'interval',
      targetId: pauseIntervalId,
      draft: formatPauseDurationInput(pause.durationMin),
      previousDurationMin: pause.durationMin,
    });
  };

  const handlePauseDurationDraftChange = (draft: string) => {
    setEditingPauseDuration((current) => (current ? { ...current, draft } : current));
  };

  const commitPauseDurationEdit = () => {
    setEditingPauseDuration((current) => {
      if (!current) return current;
      const nextDurationMin = parsePauseDurationInput(current.draft, current.previousDurationMin);
      if (current.kind === 'favorite-poi') {
        if (current.poiCategory) {
          onChangeFavoritePoiPauseDuration?.(current.poiCategory, nextDurationMin);
        }
        return null;
      }
      if (current.kind === 'manual') {
        onChangePauseDuration?.(current.targetId, nextDurationMin);
        return null;
      }
      onChangeIntervalPauseDuration?.(current.targetId, nextDurationMin);
      return null;
    });
  };

  const cancelPauseDurationEdit = () => {
    setEditingPauseDuration(null);
  };

  const isAttachedPauseDragging = useMemo(
    () => dragState !== null && !standalonePauses.some((pause) => pause.id === dragState.id),
    [dragState, standalonePauses],
  );

  const dragOverlayStyle = useMemo(() => {
    if (!dragState) return null;
    return {
      top: dragState.topPx,
      '--rvi-tl-pause-height': `${dragState.heightPx}px`,
      ...resolveColumnPlacement(dragState.dayKey),
    } as CSSProperties;
  }, [dragState, resolveColumnPlacement]);

  const previewPositioning = useMemo(() => {
    if (!dragState) {
      return {
        events,
        standalonePauses,
      };
    }

    const previewPauseDayKeyById = new Map(standalonePauseDayKeyById);
    previewPauseDayKeyById.set(dragState.id, dragState.dayKey);

    const draggedStandalonePause = standalonePauses.find((pause) => pause.id === dragState.id);
    const previewStandalonePauses = draggedStandalonePause
      ? standalonePauses.map((pause) => (pause.id === dragState.id
        ? {
            ...pause,
            scheduledTopPx: dragState.topPx,
            topPx: dragState.topPx,
            dayKey: dragState.dayKey,
          }
        : pause))
      : [
          ...standalonePauses,
          {
            id: dragState.id,
            label: '',
            source: dragState.source,
            poiCategory: dragState.poiCategory,
            distanceKm: dragState.distanceKm,
            elapsedSeconds: dragState.scheduledElapsedSeconds,
            scheduledTopPx: dragState.topPx,
            topPx: dragState.topPx,
            durationMin: dragState.durationMin,
            toNextSeconds: dragState.toNextSeconds,
            visible: true,
            heightPx: dragState.heightPx,
            sortIndex: Number.MAX_SAFE_INTEGER,
            dayKey: dragState.dayKey,
          },
        ];

    return positionTimelineBlocks(events, previewStandalonePauses, previewPauseDayKeyById, 0);
  }, [dragState, events, standalonePauseDayKeyById, standalonePauses]);

  const previewEventMap = useMemo(
    () => new Map(previewPositioning.events.map((event) => [event.item.id, event] as const)),
    [previewPositioning.events],
  );

  const previewStandalonePauseMap = useMemo(
    () => new Map(previewPositioning.standalonePauses.map((pause) => [pause.id, pause] as const)),
    [previewPositioning.standalonePauses],
  );

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
          const previewEvent = previewEventMap.get(event.item.id) ?? event;
          const visible = event.item.visible !== false;
          const selected = selectedIds?.has(event.item.id) ?? false;
          const hasAttachedPauses = previewEvent.attachedPauses.length > 0;
          const hasNextMetric = event.toNextSeconds !== null && Number.isFinite(event.toNextSeconds);
          const canEditFavoritePoiPause = Boolean(
            event.item.poiCategory && onChangeFavoritePoiPauseDuration,
          );
          const favoritePoiPauseEditTargetId = event.item.poiCategory ? `poi:${event.item.poiCategory}` : null;
          const isEditingFavoritePoiPause = favoritePoiPauseEditTargetId !== null
            && editingPauseDuration?.targetId === favoritePoiPauseEditTargetId;
          const isFavoriteLocked = event.item.kind === 'poi' && hasAttachedPauses && event.item.favorite;
          const title =
            event.item.kind === 'pause' && event.item.durationMin
              ? formatPauseDuration(event.item.durationMin)
              : event.item.label || 'Point sans nom';
          const eventStyle = {
            top: previewEvent.topPx,
            minHeight: previewEvent.heightPx,
            '--rvi-tl-card-height': `${previewEvent.cardHeightPx}px`,
            animationDelay: `${Math.min(index * 18, 240)}ms`,
            ...resolveColumnPlacement(previewEvent.spanSegments[0]?.dayKey ?? previewEvent.dayKey),
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
                  className={[
                    'rvi-tl-schedule__event-main',
                    hasAttachedPauses ? 'has-pause' : 'has-no-pause',
                    hasNextMetric ? 'has-next' : 'has-no-next',
                    event.item.favorite ? 'has-favorite' : 'has-no-favorite',
                  ].join(' ')}
                >
                  <span className="rvi-tl-schedule__event-icon" aria-hidden>
                    <KindBadge kind={event.item.kind} poiCategory={event.item.poiCategory} size={24} />
                  </span>
                  <span className="rvi-tl-schedule__event-name" title={title}>
                    {title}
                  </span>
                  {hasAttachedPauses ? (
                    <span className="rvi-tl-schedule__event-pauses">
                      {previewEvent.attachedPauses.map((pause) => (
                        <span
                          key={pause.id}
                          className={[
                            'rvi-tl-schedule__pause-chip',
                            pause.visible ? 'is-visible' : '',
                            canEditFavoritePoiPause ? 'is-editable' : '',
                            dragState?.id === pause.id ? 'is-dragging' : '',
                          ].filter(Boolean).join(' ')}
                          style={{
                            minHeight: pause.heightPx,
                            height: pause.heightPx,
                          }}
                          title={canEditFavoritePoiPause
                            ? t('{{duration}} · cliquer pour modifier', { duration: formatPauseDuration(pause.durationMin) })
                            : formatPauseDuration(pause.durationMin)}
                        >
                          <span
                            className="rvi-tl-schedule__pause-chip-icon"
                            aria-hidden
                            onPointerDown={undefined}
                          >
                            <KindBadge kind="pause" size={24} />
                          </span>
                          {isEditingFavoritePoiPause ? (
                            <input
                              ref={pauseDurationInputRef}
                              className="rvi-tl-schedule__pause-chip-input"
                              value={editingPauseDuration?.draft ?? ''}
                              onChange={(changeEvent) => {
                                handlePauseDurationDraftChange(changeEvent.target.value);
                              }}
                              onPointerDown={(pointerEvent) => {
                                pointerEvent.stopPropagation();
                              }}
                              onClick={(clickEvent) => {
                                clickEvent.stopPropagation();
                              }}
                              onBlur={commitPauseDurationEdit}
                              onKeyDown={(keyEvent) => {
                                if (keyEvent.key === 'Enter') {
                                  keyEvent.preventDefault();
                                  commitPauseDurationEdit();
                                } else if (keyEvent.key === 'Escape') {
                                  keyEvent.preventDefault();
                                  cancelPauseDurationEdit();
                                }
                              }}
                              aria-label={t('Modifier la durée de la pause')}
                            />
                          ) : (
                            <span
                              onClick={canEditFavoritePoiPause ? (clickEvent) => handleFavoritePoiPauseDurationClick(
                                event.item.poiCategory,
                                pause.durationMin,
                                clickEvent,
                              ) : undefined}
                            >
                              {formatPauseDuration(pause.durationMin)}
                            </span>
                          )}
                        </span>
                      ))}
                    </span>
                  ) : null}
                  <span className="rvi-tl-schedule__event-metric rvi-tl-schedule__event-metric--from-start">
                    {formatDistanceLabel(event.distanceKm)}
                  </span>
                  {hasNextMetric ? (
                    <span className="rvi-tl-schedule__event-metric rvi-tl-schedule__event-metric--next">
                      {formatLegDuration(event.toNextSeconds)}
                    </span>
                  ) : null}
                  {event.item.favorite ? (
                    <span
                      className="rvi-tl-schedule__event-favorite is-active"
                      aria-hidden
                    >
                      <IconStar size={24} />
                    </span>
                  ) : null}
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
                  aria-label={visible ? t('Masquer') : t('Afficher')}
                  aria-pressed={visible}
                >
                  <IconEye size={15} />
                </button>
                <button
                  type="button"
                  className={`rvi-tl-schedule__action rvi-tl-schedule__action--favorite${event.item.favorite ? ' is-on is-fav' : ''}`}
                  onClick={(actionEvent) => {
                    stopEventPropagation(actionEvent);
                    if (isFavoriteLocked) return;
                    onToggleFavorite?.(event.item.id, !event.item.favorite);
                  }}
                  aria-label={isFavoriteLocked ? t('Favori verrouille par pause automatique') : t('Favori')}
                  aria-pressed={!!event.item.favorite}
                  disabled={isFavoriteLocked}
                >
                  <IconStar size={24} />
                </button>
                <button
                  type="button"
                  className="rvi-tl-schedule__action rvi-tl-schedule__action--danger rvi-tl-schedule__action--remove"
                  onClick={(actionEvent) => {
                    stopEventPropagation(actionEvent);
                    onRemove?.(event.item.id);
                  }}
                  aria-label={t('Supprimer')}
                >
                  <IconTrash size={15} />
                </button>
              </span>
            </article>
          );
        })}

        {standalonePauses.map((pause, index) => {
          const previewPause = previewStandalonePauseMap.get(pause.id) ?? pause;
          const dragging = dragState?.id === pause.id;
          const pauseDayKey = dragging
            ? dragState.dayKey
            : standalonePauseDayKeyById.get(pause.id) ?? previewPause.dayKey ?? null;
          const pauseTopPx = dragging ? dragState.topPx : previewPause.topPx;
          const canEditStandalonePause = (
            (pause.source === 'manual' && onChangePauseDuration)
            || (pause.source === 'interval' && onChangeIntervalPauseDuration)
            || (pause.source === 'favorite-poi' && pause.poiCategory && onChangeFavoritePoiPauseDuration)
          );
          const canDragStandalonePause = pause.source !== 'favorite-poi' && Boolean(onMovePauseScheduled);
          const standalonePauseEditTargetId = pause.source === 'interval'
            ? resolveIntervalPauseId(pause.id)
            : pause.source === 'favorite-poi' && pause.poiCategory
              ? `poi:${pause.poiCategory}`
              : pause.id;
          const isEditingStandalonePause = Boolean(
            standalonePauseEditTargetId
            && editingPauseDuration?.targetId === standalonePauseEditTargetId,
          );

          return (
            <div
              key={pause.id}
              className={[
                'rvi-tl-schedule__pause',
                'rvi-tl-schedule__pause--standalone',
                pause.visible ? 'is-visible' : '',
                canDragStandalonePause ? 'is-draggable' : '',
                dragging ? 'is-dragging' : '',
              ].filter(Boolean).join(' ')}
              data-source={pause.source}
              onPointerDown={canDragStandalonePause ? (event) => handlePausePointerDown(event, pause) : undefined}
              style={{
                top: pauseTopPx,
                '--rvi-tl-pause-height': `${previewPause.heightPx}px`,
                animationDelay: `${Math.min((events.length + index) * 18, 240)}ms`,
                ...resolveColumnPlacement(pauseDayKey),
              } as CSSProperties}
            >
              <div
                className="rvi-tl-schedule__pause-card"
                onPointerDown={canDragStandalonePause ? (event) => handlePausePointerDown(event, pause) : undefined}
              >
                <div className="rvi-tl-schedule__pause-main">
                  <span className="rvi-tl-schedule__event-icon" aria-hidden>
                    <KindBadge kind="pause" size={24} />
                  </span>
                  <span
                    className={[
                      'rvi-tl-schedule__pause-chip',
                      'rvi-tl-schedule__pause-chip--standalone',
                      canEditStandalonePause ? 'is-editable' : '',
                    ].filter(Boolean).join(' ')}
                    title={canEditStandalonePause
                      ? t('{{duration}} · cliquer pour modifier', { duration: formatPauseDuration(pause.durationMin) })
                      : formatPauseDuration(pause.durationMin)}
                    onPointerDown={canEditStandalonePause ? (pointerEvent) => {
                      pointerEvent.stopPropagation();
                    } : undefined}
                    onClick={canEditStandalonePause ? (clickEvent) => handleStandalonePauseDurationClick(pause, clickEvent) : undefined}
                  >
                    {isEditingStandalonePause ? (
                      <input
                        ref={pauseDurationInputRef}
                        className="rvi-tl-schedule__pause-chip-input"
                        value={editingPauseDuration?.draft ?? ''}
                        onChange={(changeEvent) => {
                          handlePauseDurationDraftChange(changeEvent.target.value);
                        }}
                        onPointerDown={(pointerEvent) => {
                          pointerEvent.stopPropagation();
                        }}
                        onClick={(clickEvent) => {
                          clickEvent.stopPropagation();
                        }}
                        onBlur={commitPauseDurationEdit}
                        onKeyDown={(keyEvent) => {
                          if (keyEvent.key === 'Enter') {
                            keyEvent.preventDefault();
                            commitPauseDurationEdit();
                          } else if (keyEvent.key === 'Escape') {
                            keyEvent.preventDefault();
                            cancelPauseDurationEdit();
                          }
                        }}
                          aria-label={t('Modifier la durée de la pause')}
                      />
                    ) : (
                      <span>{formatPauseDuration(pause.durationMin)}</span>
                    )}
                  </span>
                  <span className="rvi-tl-schedule__event-metric rvi-tl-schedule__pause-metric--from-start">
                    {formatDistanceLabel(pause.distanceKm)}
                  </span>
                  <span className="rvi-tl-schedule__event-metric rvi-tl-schedule__pause-metric--next">
                    {formatLegDuration(pause.toNextSeconds)}
                  </span>
                  <span
                    className={`rvi-tl-schedule__event-favorite rvi-tl-schedule__pause-favorite${pause.source !== 'manual' ? ' is-active' : ''}`}
                    aria-hidden
                  >
                    <IconStar size={24} />
                  </span>
                </div>
              </div>
            </div>
          );
        })}

        {dragState && isAttachedPauseDragging && dragOverlayStyle ? (
          <div
            className={[
              'rvi-tl-schedule__pause',
              'rvi-tl-schedule__pause--standalone',
              'is-visible',
              'is-draggable',
              'is-dragging',
            ].join(' ')}
            data-source={dragState.source}
            style={dragOverlayStyle}
          >
            <div className="rvi-tl-schedule__pause-card">
              <div className="rvi-tl-schedule__pause-main">
                <span className="rvi-tl-schedule__event-icon" aria-hidden>
                  <KindBadge kind="pause" size={24} />
                </span>
                <span className="rvi-tl-schedule__pause-chip rvi-tl-schedule__pause-chip--standalone">
                  <span>{formatPauseDuration(dragState.durationMin)}</span>
                </span>
                <span className="rvi-tl-schedule__event-metric rvi-tl-schedule__pause-metric--from-start">
                  {formatDistanceLabel(dragState.distanceKm)}
                </span>
                <span className="rvi-tl-schedule__event-metric rvi-tl-schedule__pause-metric--next">
                  {formatLegDuration(dragState.toNextSeconds)}
                </span>
                <span
                  className={`rvi-tl-schedule__event-favorite rvi-tl-schedule__pause-favorite${dragState.source !== 'manual' ? ' is-active' : ''}`}
                  aria-hidden
                >
                  <IconStar size={24} />
                </span>
              </div>
            </div>
          </div>
        ) : null}
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

function resolveIntervalPauseId(pauseId: string): string | null {
  const separatorIndex = pauseId.indexOf('::');
  if (separatorIndex <= 0) return null;
  return pauseId.slice(0, separatorIndex);
}