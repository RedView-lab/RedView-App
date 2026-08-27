import {
  useEffect,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
  type MouseEvent as ReactMouseEvent,
  type RefObject,
} from 'react';
import { useAppI18n } from '@/shared/i18n';
import { KindBadge } from '../KindBadge';
import { IconStar } from '../../../components/icons';
import {
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
import { useTimelinePauseDrag } from './useTimelinePauseDrag';
import { TimelineEventCard } from './TimelineEventCard';
import { TimelineStandalonePauseCard } from './TimelineStandalonePauseCard';

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

interface PauseDurationEditState {
  kind: 'manual' | 'interval' | 'favorite-poi';
  targetId: string;
  draft: string;
  previousDurationMin: number;
  poiCategory?: PoiCategory;
}

function resolveIntervalPauseId(pauseId: string): string | null {
  const separatorIndex = pauseId.indexOf('::');
  if (separatorIndex <= 0) return null;
  return pauseId.slice(0, separatorIndex);
}

/**
 * Canvas de planification horaire (Schedule Canvas) affichant les étapes, pauses,
 * décalages jours et métriques au fil de la journée.
 */
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
  const [editingPauseDuration, setEditingPauseDuration] = useState<PauseDurationEditState | null>(null);

  const hourMarkSegments = useMemo(
    () => hourMarks.slice(0, -1).map((markMinute, index) => ({
      key: `${markMinute}-${hourMarks[index + 1]}`,
      topPx: (markMinute - startMinutes) * pixelsPerMinute,
      heightPx: (hourMarks[index + 1]! - markMinute) * pixelsPerMinute,
    })),
    [hourMarks, pixelsPerMinute, startMinutes],
  );

  const {
    dragState,
    handlePausePointerDown,
  } = useTimelinePauseDrag({
    canvasRef,
    canvasHeight,
    displayDays,
    reference,
    startMinutes,
    pixelsPerMinute,
    standalonePauseDayKeyById,
    onMovePauseScheduled,
  });

  useEffect(() => {
    if (!editingPauseDuration) return;
    const input = pauseDurationInputRef.current;
    if (!input) return;
    input.focus();
    input.select();
  }, [editingPauseDuration]);

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
            {t('Aucun checkpoint planifie sur la plage affichee.')}
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
          const selected = selectedIds?.has(event.item.id) ?? false;
          const canEditFavoritePoiPause = Boolean(
            event.item.poiCategory && onChangeFavoritePoiPauseDuration,
          );
          const favoritePoiPauseEditTargetId = event.item.poiCategory ? `poi:${event.item.poiCategory}` : null;
          const isEditingFavoritePoiPause = favoritePoiPauseEditTargetId !== null
            && editingPauseDuration?.targetId === favoritePoiPauseEditTargetId;

          return (
            <TimelineEventCard
              key={event.item.id}
              event={event}
              previewEvent={previewEvent}
              index={index}
              selected={selected}
              canEditFavoritePoiPause={canEditFavoritePoiPause}
              isEditingFavoritePoiPause={isEditingFavoritePoiPause}
              editingPauseDuration={editingPauseDuration}
              pauseDurationInputRef={pauseDurationInputRef}
              dragStateId={dragState?.id}
              onToggleSelect={onToggleSelect}
              onToggleVisibility={onToggleVisibility}
              onToggleFavorite={onToggleFavorite}
              onRemove={onRemove}
              onFavoritePoiPauseDurationClick={handleFavoritePoiPauseDurationClick}
              onPauseDurationDraftChange={(draft) => setEditingPauseDuration((curr) => curr ? { ...curr, draft } : curr)}
              onCommitPauseDurationEdit={commitPauseDurationEdit}
              onCancelPauseDurationEdit={() => setEditingPauseDuration(null)}
              resolveColumnPlacement={resolveColumnPlacement}
            />
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
            <TimelineStandalonePauseCard
              key={pause.id}
              pause={pause}
              previewPause={previewPause}
              index={index}
              eventsCount={events.length}
              dragging={dragging}
              pauseDayKey={pauseDayKey}
              pauseTopPx={pauseTopPx}
              canEditStandalonePause={Boolean(canEditStandalonePause)}
              canDragStandalonePause={canDragStandalonePause}
              isEditingStandalonePause={isEditingStandalonePause}
              editingPauseDuration={editingPauseDuration}
              pauseDurationInputRef={pauseDurationInputRef}
              onPausePointerDown={handlePausePointerDown}
              onStandalonePauseDurationClick={handleStandalonePauseDurationClick}
              onPauseDurationDraftChange={(draft) => setEditingPauseDuration((curr) => curr ? { ...curr, draft } : curr)}
              onCommitPauseDurationEdit={commitPauseDurationEdit}
              onCancelPauseDurationEdit={() => setEditingPauseDuration(null)}
              resolveColumnPlacement={resolveColumnPlacement}
            />
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
                  <IconStar size={12} />
                </span>
              </div>
            </div>
          </div>
        ) : null}
      </div>
    </div>
  );
}