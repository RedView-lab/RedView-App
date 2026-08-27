import {
  type CSSProperties,
  type MouseEvent as ReactMouseEvent,
  type PointerEvent as ReactPointerEvent,
  type RefObject,
} from 'react';
import { useAppI18n } from '@/shared/i18n';
import { IconStar } from '../../../components/icons';
import { KindBadge } from '../KindBadge';
import type { PoiCategory } from '../../../types';
import type { TimelineStandalonePause } from './types';
import { formatDistanceLabel, formatLegDuration, formatPauseDuration } from './utils';

interface PauseDurationEditState {
  kind: 'manual' | 'interval' | 'favorite-poi';
  targetId: string;
  draft: string;
  previousDurationMin: number;
  poiCategory?: PoiCategory;
}

interface TimelineStandalonePauseCardProps {
  pause: TimelineStandalonePause;
  previewPause: TimelineStandalonePause;
  index: number;
  eventsCount: number;
  dragging: boolean;
  pauseDayKey: string | null;
  pauseTopPx: number;
  canEditStandalonePause: boolean;
  canDragStandalonePause: boolean;
  isEditingStandalonePause: boolean;
  editingPauseDuration: PauseDurationEditState | null;
  pauseDurationInputRef: RefObject<HTMLInputElement | null>;
  onPausePointerDown: (
    event: ReactPointerEvent<HTMLElement>,
    pause: Pick<
      TimelineStandalonePause,
      'id' | 'source' | 'poiCategory' | 'durationMin' | 'distanceKm' | 'toNextSeconds' | 'heightPx' | 'topPx' | 'dayKey'
    >,
  ) => void;
  onStandalonePauseDurationClick: (
    pause: TimelineStandalonePause,
    event: ReactMouseEvent<HTMLSpanElement>,
  ) => void;
  onPauseDurationDraftChange: (draft: string) => void;
  onCommitPauseDurationEdit: () => void;
  onCancelPauseDurationEdit: () => void;
  resolveColumnPlacement: (dayKey: string | null) => CSSProperties;
}

/**
 * Carte de pause autonome (manuelle, d'intervalle ou liée à un POI favori) dans le planning.
 */
export function TimelineStandalonePauseCard({
  pause,
  previewPause,
  index,
  eventsCount,
  dragging,
  pauseDayKey,
  pauseTopPx,
  canEditStandalonePause,
  canDragStandalonePause,
  isEditingStandalonePause,
  editingPauseDuration,
  pauseDurationInputRef,
  onPausePointerDown,
  onStandalonePauseDurationClick,
  onPauseDurationDraftChange,
  onCommitPauseDurationEdit,
  onCancelPauseDurationEdit,
  resolveColumnPlacement,
}: TimelineStandalonePauseCardProps) {
  const { t } = useAppI18n();

  return (
    <div
      className={[
        'rvi-tl-schedule__pause',
        'rvi-tl-schedule__pause--standalone',
        pause.visible ? 'is-visible' : '',
        canDragStandalonePause ? 'is-draggable' : '',
        dragging ? 'is-dragging' : '',
      ].filter(Boolean).join(' ')}
      data-source={pause.source}
      onPointerDown={canDragStandalonePause ? (event) => onPausePointerDown(event, pause) : undefined}
      style={{
        top: pauseTopPx,
        '--rvi-tl-pause-height': `${previewPause.heightPx}px`,
        animationDelay: `${Math.min((eventsCount + index) * 18, 240)}ms`,
        ...resolveColumnPlacement(pauseDayKey),
      } as CSSProperties}
    >
      <div
        className="rvi-tl-schedule__pause-card"
        onPointerDown={canDragStandalonePause ? (event) => onPausePointerDown(event, pause) : undefined}
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
            onClick={canEditStandalonePause ? (clickEvent) => onStandalonePauseDurationClick(pause, clickEvent) : undefined}
          >
            {isEditingStandalonePause ? (
              <input
                ref={pauseDurationInputRef}
                className="rvi-tl-schedule__pause-chip-input"
                value={editingPauseDuration?.draft ?? ''}
                onChange={(changeEvent) => {
                  onPauseDurationDraftChange(changeEvent.target.value);
                }}
                onPointerDown={(pointerEvent) => {
                  pointerEvent.stopPropagation();
                }}
                onClick={(clickEvent) => {
                  clickEvent.stopPropagation();
                }}
                onBlur={onCommitPauseDurationEdit}
                onKeyDown={(keyEvent) => {
                  if (keyEvent.key === 'Enter') {
                    keyEvent.preventDefault();
                    onCommitPauseDurationEdit();
                  } else if (keyEvent.key === 'Escape') {
                    keyEvent.preventDefault();
                    onCancelPauseDurationEdit();
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
            <IconStar size={12} />
          </span>
        </div>
      </div>
    </div>
  );
}
