import {
  useState,
  type CSSProperties,
  type MouseEvent as ReactMouseEvent,
  type ReactNode,
  type RefObject,
} from 'react';
import { useAppI18n } from '@/shared/i18n';
import {
  IconNiceManYellow,
  IconStar,
  IconTrash,
} from '../../../components/icons';
import { TimelineNameInput } from '../EditableTimelineName';
import { isRenamableTimelineItem } from '../timelineNames';
import { KindBadge } from '../KindBadge';
import { CARD_NAME_LINE_HEIGHT_PX, CARD_NAME_MAX_LINES } from './constants';
import type { TimelineItem } from '../../../types';
import type { PauseDurationEditState, TimelineEvent } from './types';
import {
  formatDistanceLabel,
  formatHourLabel,
  formatLegDuration,
  formatPauseDuration,
} from './utils';

/** Ligne « Repart à … » sous le nom (rôle caption). */
const CARD_CAPTION_LINE_HEIGHT_PX = 14;
/** Marges haute et basse de la carte. */
const CARD_VERTICAL_PADDING_PX = 8;
/** Ligne d'en-tête de la carte (icône, nom, chiffres). */
const CARD_HEADER_HEIGHT_PX = 24;

interface TimelineEventCardProps {
  event: TimelineEvent;
  previewEvent: TimelineEvent;
  index: number;
  selected: boolean;
  canEditPoiPause: boolean;
  isEditingPoiPause: boolean;
  editingPauseDuration: PauseDurationEditState | null;
  pauseDurationInputRef: RefObject<HTMLInputElement | null>;
  dragStateId?: string;
  selectedIds?: ReadonlySet<string>;
  onSelectRow?: (id: string, item: TimelineItem) => void;
  onToggleSelect?: (id: string, selected: boolean) => void;
  onToggleVisibility?: (id: string, visible: boolean) => void;
  onToggleFavorite?: (id: string, favorite: boolean) => void;
  /** Nom saisi pour un POI (double-clic sur le nom, ou F2). */
  onRename?: (id: string, label: string) => void;
  onRemove?: (id: string) => void;
  /** Modifier la pause de ce POI (sa durée à lui seul). */
  onPoiPauseDurationClick: (
    itemId: string,
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
 * Bloc d'un point dans l'agenda. Son haut est l'heure d'arrivée ; la ligne
 * d'en-tête (icône, nom, pause, distance, temps jusqu'au suivant, actions,
 * favori) reste en haut, et la pastille de pause descend sur toute sa durée.
 */
export function TimelineEventCard({
  event,
  previewEvent,
  index,
  selected,
  canEditPoiPause,
  isEditingPoiPause,
  editingPauseDuration,
  pauseDurationInputRef,
  dragStateId,
  onSelectRow,
  onToggleSelect,
  onToggleVisibility,
  onToggleFavorite,
  onRename,
  onRemove,
  onPoiPauseDurationClick,
  onPauseDurationDraftChange,
  onCommitPauseDurationEdit,
  onCancelPauseDurationEdit,
  resolveColumnPlacement,
}: TimelineEventCardProps) {
  const { t } = useAppI18n();
  const [renaming, setRenaming] = useState(false);
  const canRename = Boolean(onRename) && isRenamableTimelineItem(event.item);
  const visible = event.item.visible !== false;
  const hasAttachedPauses = previewEvent.attachedPauses.length > 0;
  const hasNextMetric = event.toNextSeconds !== null && Number.isFinite(event.toNextSeconds);
  const title =
    event.item.kind === 'pause' && event.item.durationMin
      ? formatPauseDuration(event.item.durationMin)
      : event.item.label || t('Point sans nom');

  // Heure de départ de chaque pause : arrivée + pauses précédentes + la sienne.
  const pauseUntilLabels: string[] = [];
  let pauseEndMinute = event.minuteOfDay;
  for (const pause of previewEvent.attachedPauses) {
    pauseEndMinute += Math.max(0, pause.durationMin);
    pauseUntilLabels.push(formatHourLabel(pauseEndMinute));
  }
  const contentHeightPx = previewEvent.cardHeightPx - CARD_VERTICAL_PADDING_PX;
  // « Repart à … » sous le nom, dès que la pause allonge assez la carte.
  const departureLabel = hasAttachedPauses
    && contentHeightPx >= CARD_HEADER_HEIGHT_PX + CARD_CAPTION_LINE_HEIGHT_PX
    ? pauseUntilLabels[pauseUntilLabels.length - 1] ?? null
    : null;
  // Carte haute (longue pause attachée) : le nom peut passer sur 2–3 lignes.
  const nameLines = Math.max(1, Math.min(
    CARD_NAME_MAX_LINES,
    Math.floor((contentHeightPx - (departureLabel ? CARD_CAPTION_LINE_HEIGHT_PX : 0)) / CARD_NAME_LINE_HEIGHT_PX),
  ));

  const eventStyle = {
    top: previewEvent.topPx,
    minHeight: previewEvent.heightPx,
    '--rvi-tl-card-height': `${previewEvent.cardHeightPx}px`,
    '--rvi-tl-name-lines': String(nameLines),
    animationDelay: `${Math.min(index * 18, 240)}ms`,
    ...resolveColumnPlacement(previewEvent.spanSegments[0]?.dayKey ?? previewEvent.dayKey),
  } as CSSProperties;

  // Pendant la saisie du nom, la carte n'est plus un bouton : jamais de champ dans un bouton.
  const cardContent: ReactNode = (
    <span className="rvi-tl-schedule__event-main">
      <span className="rvi-tl-schedule__event-icon" aria-hidden>
        {/* La pause a sa colonne : pas de seconde pastille sur l'icône. */}
        <KindBadge
          kind={event.item.kind}
          poiCategory={event.item.poiCategory}
          favorite={event.item.favorite}
          size={24}
        />
      </span>
      <span className="rvi-tl-schedule__event-title">
        {renaming && onRename ? (
          <TimelineNameInput
            item={event.item}
            className="rvi-tl-schedule__event-name-input"
            onRename={onRename}
            onDone={() => setRenaming(false)}
          />
        ) : (
          <span
            className="rvi-tl-schedule__event-name"
            title={canRename
              ? t('{{name}} · double-cliquer pour modifier (horaires, nom court…), repris par l’export GPS', { name: title })
              : title}
            onDoubleClick={canRename
              ? (doubleClickEvent) => {
                  doubleClickEvent.stopPropagation();
                  setRenaming(true);
                }
              : undefined}
          >
            {title}
          </span>
        )}
        {departureLabel ? (
          <span className="rvi-tl-schedule__event-caption">
            {t('Repart à {{time}}', { time: departureLabel })}
          </span>
        ) : null}
      </span>
      <span className="rvi-tl-schedule__event-pauses">
        {hasAttachedPauses ? (
          previewEvent.attachedPauses.map((pause, pauseIndex) => (
            <span
              key={pause.id}
              className={[
                'rvi-tl-schedule__pause-chip',
                pause.visible ? 'is-visible' : '',
                canEditPoiPause ? 'is-editable' : '',
                dragStateId === pause.id ? 'is-dragging' : '',
              ].filter(Boolean).join(' ')}
              style={{
                minHeight: pause.heightPx,
                height: pause.heightPx,
              }}
              title={canEditPoiPause
                ? t('{{duration}} · départ {{time}} · cliquer pour modifier', {
                    duration: formatPauseDuration(pause.durationMin),
                    time: pauseUntilLabels[pauseIndex] ?? '',
                  })
                : t('{{duration}} · départ {{time}}', {
                    duration: formatPauseDuration(pause.durationMin),
                    time: pauseUntilLabels[pauseIndex] ?? '',
                  })}
            >
              <span
                className="rvi-tl-schedule__pause-chip-icon"
                aria-hidden
              >
                <KindBadge kind="pause" size={24} />
              </span>
              {isEditingPoiPause ? (
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
                  className="rvi-tl-schedule__pause-chip-text"
                  onClick={canEditPoiPause ? (clickEvent) => onPoiPauseDurationClick(
                    event.item.id,
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
          onToggleFavorite?.(event.item.id, !event.item.favorite);
        }}
        aria-label={t('Favori')}
        aria-pressed={!!event.item.favorite}
      >
        <IconStar size={12} />
      </span>
    </span>
  );

  return (
    <article
      className={`rvi-tl-schedule__event${selected ? ' is-selected' : ''}`}
      style={eventStyle}
      data-kind={event.item.kind}
      data-timeline-id={event.item.id}
      data-multiline-name={nameLines > 1 ? '' : undefined}
    >
      {renaming ? (
        <div className="rvi-tl-schedule__event-card">{cardContent}</div>
      ) : (
        <button
          type="button"
          className="rvi-tl-schedule__event-card"
          aria-pressed={selected}
          onClick={() => {
            onToggleSelect?.(event.item.id, !selected);
            onSelectRow?.(event.item.id, event.item);
          }}
          onKeyDown={canRename
            ? (keyEvent) => {
                if (keyEvent.key !== 'F2') return;
                keyEvent.preventDefault();
                setRenaming(true);
              }
            : undefined}
        >
          {cardContent}
        </button>
      )}

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
