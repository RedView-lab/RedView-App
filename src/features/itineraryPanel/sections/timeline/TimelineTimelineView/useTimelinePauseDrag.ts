import { useEffect, useState, type PointerEvent as ReactPointerEvent } from 'react';
import type { PoiCategory } from '../../../types';
import type {
  StartReference,
  TimelineStandalonePause,
} from './types';
import {
  MINUTES_PER_DAY,
  TIMELINE_VIEWPORT_BOTTOM_INSET_PX,
  TIMELINE_VIEWPORT_TOP_INSET_PX,
} from './constants';

export interface PauseDragState {
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

interface UseTimelinePauseDragArgs {
  canvasRef: React.RefObject<HTMLDivElement | null>;
  canvasHeight: number;
  displayDays: Date[];
  reference: StartReference;
  startMinutes: number;
  pixelsPerMinute: number;
  standalonePauseDayKeyById: ReadonlyMap<string, string | null>;
  onMovePauseScheduled?: (id: string, scheduledElapsedSeconds: number) => void;
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

export function resolvePauseDragTarget(
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

/**
 * Gère le déplacement par glisser-déposer (drag-and-drop) d'une pause sur le canvas d'horaires.
 */
export function useTimelinePauseDrag({
  canvasRef,
  canvasHeight,
  displayDays,
  reference,
  startMinutes,
  pixelsPerMinute,
  standalonePauseDayKeyById,
  onMovePauseScheduled,
}: UseTimelinePauseDragArgs) {
  const [dragState, setDragState] = useState<PauseDragState | null>(null);

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
    canvasRef,
    displayDays,
    dragState,
    onMovePauseScheduled,
    pixelsPerMinute,
    reference,
    startMinutes,
  ]);

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

  return {
    dragState,
    setDragState,
    handlePausePointerDown,
  };
}
