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
import { IconEye, IconStar, IconTrash } from '../../components/icons';
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
}

function formatDistance(km: number | null): string {
  if (km === null) return '—';
  if (km === 0) return '0';
  if (km < 1) return `${Math.round(km * 1000)} m`;
  return km.toFixed(1);
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
}: TimelineRowProps) {
  const isPlaceholder =
    item.label === 'Rechercher un lieu' || item.label.trim() === '';
  const visible = item.visible !== false;

  // For "pause" items, the primary label is the duration.
  const primaryLabel =
    item.kind === 'pause' && item.durationMin
      ? `${item.durationMin}min`
      : item.label;

  return (
    <div
      className={`rvi-tl-row${isPlaceholder ? ' rvi-tl-row--placeholder' : ''}${
        compact ? ' rvi-tl-row--compact' : ''
      }${selected ? ' is-selected' : ''}`}
      style={style}
      data-kind={item.kind}
    >
      <label className="rvi-tl-row__check" aria-label="Sélectionner">
        <input
          type="checkbox"
          checked={selected}
          onChange={(e) => onToggleSelect?.(item.id, e.target.checked)}
        />
        <span className="rvi-tl-row__check-box" aria-hidden />
      </label>

      <KindBadge kind={item.kind} />

      <span className="rvi-tl-row__kind-text" title={kindLabel(item.kind)}>
        {kindLabel(item.kind)}
      </span>

      <span
        className={`rvi-tl-row__title${
          isPlaceholder ? ' rvi-tl-row__title--placeholder' : ''
        }`}
        title={primaryLabel}
      >
        {primaryLabel}
      </span>

      <span className="rvi-tl-row__distance">{formatDistance(item.distanceKm)}</span>

      <span className="rvi-tl-row__actions">
        <button
          type="button"
          className={`rvi-tl-row__action${visible ? ' is-on' : ''}`}
          onClick={() => onToggleVisibility?.(item.id, !visible)}
          aria-label={visible ? 'Masquer' : 'Afficher'}
          aria-pressed={visible}
        >
          <IconEye size={12} />
        </button>
        <button
          type="button"
          className={`rvi-tl-row__action${item.favorite ? ' is-on is-fav' : ''}`}
          onClick={() => onToggleFavorite?.(item.id, !item.favorite)}
          aria-label="Favori"
          aria-pressed={!!item.favorite}
        >
          <IconStar size={12} />
        </button>
        <button
          type="button"
          className="rvi-tl-row__action rvi-tl-row__action--danger"
          onClick={() => onRemove?.(item.id)}
          aria-label="Supprimer"
        >
          <IconTrash size={12} />
        </button>
      </span>
    </div>
  );
}
