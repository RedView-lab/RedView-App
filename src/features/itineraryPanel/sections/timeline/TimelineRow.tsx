/**
 * A single timeline item card — used in both Sheet and Timeline views.
 *
 * Layout (reading left → right, all driven by flexbox auto-layout):
 *   [✓] [KindBadge] [Kind label]  [Name (flex)]  [Distance]  [Actions]
 *
 * Actions are three utility buttons: visibility toggle (eye), favorite
 * (star), delete (trash). Their state is controlled by the parent via
 * callbacks, never inferred locally — so the component stays stateless and
 * ready to wire to any backend.
 */
import { useEffect, useRef, useState } from 'react';
import { IconNiceManYellow, IconStar, IconTrash } from '../../components/icons';
import { useAppI18n } from '@/shared/i18n';
import { PlaceSearchInput } from './components';
import type { TimelineItem } from '../../types';
import { KindBadge, kindLabel } from './KindBadge';

interface TimelineRowProps {
  item: TimelineItem;
  /** When true, the row is rendered in "compact" mode (Timeline rail). */
  compact?: boolean;
  /** Optional inline style — used by the Timeline view to absolutely-position. */
  style?: React.CSSProperties;
  selected?: boolean;
  onToggleSelect?: (id: string, selected: boolean) => void;
  onToggleVisibility?: (id: string, visible: boolean) => void;
  onToggleFavorite?: (id: string, favorite: boolean) => void;
  onRemove?: (id: string) => void;
  /** When provided, start/end placeholder rows render an inline place search. */
  onSelectPlace?: (
    id: string,
    place: { name: string; fullName: string; lat: number; lon: number },
  ) => void;
  onMovePause?: (id: string, distanceKm: number) => void;
  onChangePauseDuration?: (id: string, durationMin: number) => void;
  onChangeIntervalPauseDuration?: (pauseIntervalId: string, durationMin: number) => void;
  maxDistanceKm?: number;
}

function formatDistance(km: number | null): string {
  if (km === null) return '—';
  if (km === 0) return '0';
  if (km < 1) return `${Math.round(km * 1000)} m`;
  return km.toFixed(1);
}

function resolveIntervalPauseId(pauseId: string): string | null {
  const separatorIndex = pauseId.indexOf('::');
  if (separatorIndex <= 0) return null;
  return pauseId.slice(0, separatorIndex);
}

function resolveTimelineRowKindLabel(item: TimelineItem, t: (key: string) => string): string {
  if (item.kind === 'end') return t('Fin');
  return kindLabel(item.kind, item.poiCategory);
}

interface TimelineRowDistanceProps {
  id: string;
  distanceKm: number | null;
  canEdit: boolean;
  onMovePause?: (id: string, distanceKm: number) => void;
  maxDistanceKm?: number;
}

function TimelineRowDistance({
  id,
  distanceKm,
  canEdit,
  onMovePause,
  maxDistanceKm,
}: TimelineRowDistanceProps) {
  const { t } = useAppI18n();
  const [isEditing, setIsEditing] = useState(false);
  const [draft, setDraft] = useState('');
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (isEditing) {
      inputRef.current?.focus();
      inputRef.current?.select();
    }
  }, [isEditing]);

  const handleStartEdit = (e: React.MouseEvent) => {
    e.stopPropagation();
    if (!canEdit) return;
    setIsEditing(true);
    setDraft(distanceKm != null ? String(distanceKm) : '');
  };

  const handleCommit = () => {
    if (!isEditing) return;
    const clean = draft.trim().replace(',', '.');
    const parsed = parseFloat(clean);
    if (!Number.isNaN(parsed) && parsed >= 0) {
      let finalKm = parsed;
      if (maxDistanceKm != null && maxDistanceKm > 0) {
        finalKm = Math.min(finalKm, maxDistanceKm);
      }
      finalKm = Number(finalKm.toFixed(3));
      if (finalKm !== distanceKm) {
        onMovePause?.(id, finalKm);
      }
    }
    setIsEditing(false);
  };

  const handleCancel = () => {
    setIsEditing(false);
  };

  if (isEditing) {
    return (
      <span className="rvi-tl-row__distance" onClick={(e) => e.stopPropagation()}>
        <input
          ref={inputRef}
          type="text"
          className="rvi-tl-row__distance-input"
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          onBlur={handleCommit}
          onKeyDown={(e) => {
            if (e.key === 'Enter') {
              e.preventDefault();
              handleCommit();
            } else if (e.key === 'Escape') {
              e.preventDefault();
              handleCancel();
            }
          }}
          aria-label={t('Modifier la distance en kilomètres')}
        />
      </span>
    );
  }

  return (
    <span
      className={`rvi-tl-row__distance${canEdit ? ' rvi-tl-row__distance--editable' : ''}`}
      onClick={canEdit ? handleStartEdit : undefined}
      title={canEdit ? t('Modifier la distance (km)') : undefined}
      role={canEdit ? 'button' : undefined}
      tabIndex={canEdit ? 0 : undefined}
      onKeyDown={
        canEdit
          ? (e) => {
              if (e.key === 'Enter' || e.key === ' ') {
                e.preventDefault();
                handleStartEdit(e as unknown as React.MouseEvent);
              }
            }
          : undefined
      }
    >
      {formatDistance(distanceKm)}
    </span>
  );
}

interface TimelineRowDurationProps {
  id: string;
  item: TimelineItem;
  canEdit: boolean;
  onChangePauseDuration?: (id: string, durationMin: number) => void;
  onChangeIntervalPauseDuration?: (pauseIntervalId: string, durationMin: number) => void;
  isAutoGeneratedIntervalPause?: boolean;
}

function TimelineRowDuration({
  id,
  item,
  canEdit,
  onChangePauseDuration,
  onChangeIntervalPauseDuration,
  isAutoGeneratedIntervalPause,
}: TimelineRowDurationProps) {
  const { t } = useAppI18n();
  const [isEditing, setIsEditing] = useState(false);
  const [draft, setDraft] = useState('');
  const inputRef = useRef<HTMLInputElement>(null);

  const primaryLabel = item.durationMin
    ? (isAutoGeneratedIntervalPause ? `${item.label} · ${item.durationMin}min` : `${item.durationMin}min`)
    : item.label;

  useEffect(() => {
    if (isEditing) {
      inputRef.current?.focus();
      inputRef.current?.select();
    }
  }, [isEditing]);

  const handleStartEdit = (e: React.MouseEvent) => {
    e.stopPropagation();
    if (!canEdit) return;
    setIsEditing(true);
    setDraft(item.durationMin != null ? String(item.durationMin) : '15');
  };

  const handleCommit = () => {
    if (!isEditing) return;
    const clean = draft.trim().replace(/\D/g, '');
    const parsed = parseInt(clean, 10);
    if (!Number.isNaN(parsed) && parsed > 0) {
      if (isAutoGeneratedIntervalPause) {
        const intervalId = resolveIntervalPauseId(id);
        if (intervalId) {
          onChangeIntervalPauseDuration?.(intervalId, parsed);
        }
      } else {
        onChangePauseDuration?.(id, parsed);
      }
    }
    setIsEditing(false);
  };

  const handleCancel = () => {
    setIsEditing(false);
  };

  if (isEditing) {
    return (
      <span className="rvi-tl-row__title" onClick={(e) => e.stopPropagation()}>
        <input
          ref={inputRef}
          type="text"
          className="rvi-tl-row__duration-input"
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          onBlur={handleCommit}
          onKeyDown={(e) => {
            if (e.key === 'Enter') {
              e.preventDefault();
              handleCommit();
            } else if (e.key === 'Escape') {
              e.preventDefault();
              handleCancel();
            }
          }}
          aria-label={t('Modifier la durée de la pause')}
        />
      </span>
    );
  }

  return (
    <span
      className={`rvi-tl-row__title${canEdit ? ' rvi-tl-row__title--editable' : ''}`}
      title={canEdit ? t('Modifier la durée de la pause') : primaryLabel}
      onClick={canEdit ? handleStartEdit : undefined}
      role={canEdit ? 'button' : undefined}
      tabIndex={canEdit ? 0 : undefined}
      onKeyDown={
        canEdit
          ? (e) => {
              if (e.key === 'Enter' || e.key === ' ') {
                e.preventDefault();
                handleStartEdit(e as unknown as React.MouseEvent);
              }
            }
          : undefined
      }
    >
      {primaryLabel}
    </span>
  );
}

export function TimelineRow({
  item,
  compact = false,
  style,
  selected = false,
  onToggleSelect,
  onToggleVisibility,
  onToggleFavorite,
  onRemove,
  onSelectPlace,
  onMovePause,
  onChangePauseDuration,
  onChangeIntervalPauseDuration,
  maxDistanceKm,
}: TimelineRowProps) {
  const { t } = useAppI18n();
  const searchPlaceholder = t('Rechercher un lieu');
  const isPlaceholder =
    item.label === searchPlaceholder || item.label === 'Rechercher un lieu' || item.label.trim() === '';
  const visible = item.visible !== false;
  const isAutoGeneratedIntervalPause = item.autoGenerated === 'intervalPause';
  const isLocationRow =
    item.kind === 'start' || item.kind === 'end' || item.kind === 'waypoint';
  const useSearchInput = !!onSelectPlace && isLocationRow;
  const rowKindLabel = resolveTimelineRowKindLabel(item, t);

  const isPause = item.kind === 'pause';
  const canEditDistance = isPause && Boolean(onMovePause);
  const canEditDuration =
    isPause && Boolean(isAutoGeneratedIntervalPause ? onChangeIntervalPauseDuration : onChangePauseDuration);

  return (
    <div
      className={`rvi-tl-row${isPlaceholder ? ' rvi-tl-row--placeholder' : ''}${
        compact ? ' rvi-tl-row--compact' : ''
      }${selected ? ' is-selected' : ''}`}
      style={style}
      data-kind={item.kind}
    >
      <label className="rvi-tl-row__check" aria-label={t('Sélectionner')}>
        <input
          type="checkbox"
          checked={selected}
          onChange={(e) => onToggleSelect?.(item.id, e.target.checked)}
        />
        <span className="rvi-tl-row__check-box" aria-hidden />
      </label>

      <KindBadge kind={item.kind} poiCategory={item.poiCategory} size={24} />

      <span className="rvi-tl-row__kind-text" title={rowKindLabel}>
        {rowKindLabel}
      </span>

      {useSearchInput ? (
        <PlaceSearchInput
          value={isPlaceholder ? '' : item.label}
          onPick={(s) =>
            onSelectPlace?.(item.id, {
              name: s.name,
              fullName: s.fullName,
              lat: s.lat,
              lon: s.lon,
            })
          }
          placeholder={searchPlaceholder}
        />
      ) : isPause ? (
        <TimelineRowDuration
          id={item.id}
          item={item}
          canEdit={canEditDuration}
          onChangePauseDuration={onChangePauseDuration}
          onChangeIntervalPauseDuration={onChangeIntervalPauseDuration}
          isAutoGeneratedIntervalPause={isAutoGeneratedIntervalPause}
        />
      ) : (
        <span
          className={`rvi-tl-row__title${
            isPlaceholder ? ' rvi-tl-row__title--placeholder' : ''
          }`}
          title={item.label}
        >
          {item.label}
        </span>
      )}

      <TimelineRowDistance
        id={item.id}
        distanceKm={item.distanceKm}
        canEdit={canEditDistance}
        onMovePause={onMovePause}
        maxDistanceKm={maxDistanceKm}
      />

      <span className="rvi-tl-row__actions">
        <button
          type="button"
          className={`rvi-tl-row__action${visible ? ' is-on' : ''}`}
          onClick={() => {
            if (isAutoGeneratedIntervalPause) return;
            onToggleVisibility?.(item.id, !visible);
          }}
          aria-label={visible ? t('Masquer') : t('Afficher')}
          aria-pressed={visible}
          disabled={isAutoGeneratedIntervalPause}
        >
          <IconNiceManYellow size={15} style={!visible ? { opacity: 0.35, filter: 'grayscale(1)' } : undefined} />
        </button>
        <button
          type="button"
          className="rvi-tl-row__action rvi-tl-row__action--danger"
          onClick={() => {
            if (isAutoGeneratedIntervalPause) return;
            onRemove?.(item.id);
          }}
          aria-label={t('Supprimer')}
          disabled={isAutoGeneratedIntervalPause}
        >
          <IconTrash size={15} />
        </button>
        <button
          type="button"
          className={`rvi-tl-row__action rvi-tl-row__action--star${item.favorite ? ' is-on is-fav' : ''}`}
          onClick={() => {
            if (isAutoGeneratedIntervalPause) return;
            onToggleFavorite?.(item.id, !item.favorite);
          }}
          aria-label={t('Favori')}
          aria-pressed={!!item.favorite}
          disabled={isAutoGeneratedIntervalPause}
        >
          <IconStar size={12} />
        </button>
      </span>
    </div>
  );
}
