/**
 * "Ajouter un élément" split-button row — ends the sheet view.
 *
 * Left: a plus badge (matches the Départ-checkpoint styling from Figma).
 * Right: chevron-down hinting a kind picker (Waypoint / Pause / Eau / …).
 *
 * The chevron's menu is intentionally left to the container: the component
 * is stateless and only emits `onAdd` / `onOpenKindMenu` callbacks so the
 * back-end wiring can decide how to present the list of kinds.
 */
import { IconChevronDown, IconPlusCircle } from '../../components/icons';

interface TimelineAddRowProps {
  onAdd?: () => void;
  onOpenKindMenu?: () => void;
}

export function TimelineAddRow({ onAdd, onOpenKindMenu }: TimelineAddRowProps) {
  return (
    <div className="rvi-tl-add">
      <button
        type="button"
        className="rvi-tl-add__main"
        onClick={onAdd}
        aria-label="Ajouter un élément"
      >
        <span className="rvi-tl-add__badge" aria-hidden>
          <IconPlusCircle size={16} />
        </span>
        <span className="rvi-tl-add__label">Ajouter un élément</span>
      </button>
      <button
        type="button"
        className="rvi-tl-add__chevron"
        onClick={onOpenKindMenu}
        aria-label="Choisir le type d'élément"
      >
        <IconChevronDown size={14} />
      </button>
    </div>
  );
}
