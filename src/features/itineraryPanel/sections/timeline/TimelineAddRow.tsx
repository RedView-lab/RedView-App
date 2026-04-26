import type { MouseEventHandler } from 'react';

/**
 * "Ajouter un élément" split-button row — ends the sheet view.
 *
 * Both hit targets open the kind picker; the component stays stateless so the
 * parent can decide how the anchored menu is presented.
 */
import { IconChevronDown, IconPlusCircle } from '../../components/icons';

interface TimelineAddRowProps {
  onAdd?: MouseEventHandler<HTMLButtonElement>;
  onOpenKindMenu?: MouseEventHandler<HTMLButtonElement>;
}

export function TimelineAddRow({ onAdd, onOpenKindMenu }: TimelineAddRowProps) {
  const openKindMenu = onOpenKindMenu ?? onAdd;

  return (
    <div className="rvi-tl-add">
      <button
        type="button"
        className="rvi-tl-add__main"
        onClick={openKindMenu}
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
        onClick={openKindMenu}
        aria-label="Choisir le type d'élément"
      >
        <IconChevronDown size={14} />
      </button>
    </div>
  );
}
