import {
  type CSSProperties,
  type MouseEvent as ReactMouseEvent,
  type RefObject,
} from 'react';
import { useAppI18n } from '@/shared/i18n';
import {
  IconNiceManYellow,
  IconStar,
  IconTrash,
} from '../../../components/icons';
import { KindBadge } from '../KindBadge';
import type { PoiCategory } from '../../../types';
import type { TimelineEvent } from './types';
import { formatDistanceLabel, formatLegDuration, formatPauseDuration } from './utils';

interface PauseDurationEditState {
  kind: 'manual' | 'interval' | 'favorite-poi';
  targetId: string;
  draft: string;
  previousDurationMin: number;
  poiCategory?: PoiCategory;
}

interface TimelineEventCardProps {
  event: TimelineEvent;
  previewEvent: TimelineEvent;
  index: number;
  selected: boolean;
  canEditFavoritePoiPause: boolean;
  isEditingFavoritePoiPause: boolean;
  editingPauseDuration: PauseDurationEditState | null;
  pauseDurationInputRef: RefObject<HTMLInputElement | null>;
  dragStateId?: string;
  onToggleSelect?: (id: string, selected: boolean) => void;
  onToggleVisibility?: (id: string, visible: boolean) => void;
  onToggleFavorite?: (id: string, favorite: boolean) => void;
  onRemove?: (id: string) => void;
  onFavoritePoiPauseDurationClick: (
    poiCategory: PoiCategory | undefined,
    currentDurationMin: number,
    event: ReactMouseEvent<HTMLSpanElement>,
  ) => void;
  onPauseDurationDraftChange: (draft: string) => void;
  onCommitPauseDurationEdit: () => void;
  onCancelPauseDurationEdit: () => void;
  resolveColumnPlacement: (dayKey: string | null) => CSSProperties;
}

function stopEventPropagation(event: ReactMouseEvent<HTMLButtonElement>) {
  event.stopPropagation();
}

/**
 * Carte d'événement unitaire dans la vue de planning / feuille de route.
 */
export function TimelineEventCard({
  event,
  previewEvent,
  index,
  selected,
  canEditFavoritePoiPause,
  isEditingFavoritePoiPause,
  editingPauseDuration,
  pauseDurationInputRef,
  dragStateId,
  onToggleSelect,
  onToggleVisibility,
  onToggleFavorite,
  onRemove,
  onFavoritePoiPauseDurationClick,
  onPauseDurationDraftChange,
  onCommitPauseDurationEdit,
  onCancelPauseDurationEdit,
  resolveColumnPlacement,
}: TimelineEventCardProps) {
  const { t } = useAppI18n();
  const visible = event.item.visible !== false;
  const hasAttachedPauses = previewEvent.attachedPauses.length > 0;
  const hasNextMetric = event.toNextSeconds !== null && Number.isFinite(event.toNextSeconds);
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
        <span className="rvi-tl-schedule__event-main">
          <span className="rvi-tl-schedule__event-icon" aria-hidden>
            <KindBadge kind={event.item.kind} poiCategory={event.item.poiCategory} size={24} />
          </span>
          <span className="rvi-tl-schedule__event-name" title={title}>
            {title}
          </span>
          <span className="rvi-tl-schedule__event-pauses">
            {hasAttachedPauses ? (
              previewEvent.attachedPauses.map((pause) => (
                <span
                  key={pause.id}
                  className={[
                    'rvi-tl-schedule__pause-chip',
                    pause.visible ? 'is-visible' : '',
                    canEditFavoritePoiPause ? 'is-editable' : '',
                    dragStateId === pause.id ? 'is-dragging' : '',
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
                  >
                    <KindBadge kind="pause" size={24} />
                  </span>
                  {isEditingFavoritePoiPause ? (
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
                    <span
                      onClick={canEditFavoritePoiPause ? (clickEvent) => onFavoritePoiPauseDurationClick(
                        event.item.poiCategory,
                        pause.durationMin,
                        clickEvent,
                      ) : undefined}
                    >
                      {formatPauseDuration(pause.durationMin)}
                    </span>
                  )}
                </span>
              ))
            ) : null}
          </span>
          <span className="rvi-tl-schedule__event-metric rvi-tl-schedule__event-metric--from-start">
            {formatDistanceLabel(event.distanceKm)}
          </span>
          <span className="rvi-tl-schedule__event-metric rvi-tl-schedule__event-metric--next">
            {hasNextMetric ? formatLegDuration(event.toNextSeconds) : ''}
          </span>
          <span
            className={`rvi-tl-schedule__event-favorite${event.item.favorite ? ' is-active' : ''}`}
            role="button"
            tabIndex={0}
            onClick={(clickEvent) => {
              clickEvent.stopPropagation();
              if (isFavoriteLocked) return;
              onToggleFavorite?.(event.item.id, !event.item.favorite);
            }}
            aria-label={isFavoriteLocked ? t('Favori verrouille par pause automatique') : t('Favori')}
            aria-pressed={!!event.item.favorite}
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
          aria-label={visible ? t('Masquer') : t('Afficher')}
          aria-pressed={visible}
        >
          <IconNiceManYellow size={15} style={!visible ? { opacity: 0.35, filter: 'grayscale(1)' } : undefined} />
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
          <IconStar size={12} />
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
}
