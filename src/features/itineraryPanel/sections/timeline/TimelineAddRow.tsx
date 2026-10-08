import type { MouseEventHandler } from 'react';
import { useAppI18n } from '@/shared/i18n';

/**
 * Ligne « Ajouter un élément » — termine la vue feuille.
 *
 * Conforme au nœud Figma 855:20479 : une seule barre arrondie avec un glyphe
 * « + » simple + un libellé à gauche et un chevron à droite (sans séparateur).
 * Toute la ligne ouvre le sélecteur de type.
 */
import { IconChevronDown, IconPlus } from '../../components/icons';

interface TimelineAddRowProps {
  onAdd?: MouseEventHandler<HTMLButtonElement>;
  onOpenKindMenu?: MouseEventHandler<HTMLButtonElement>;
}

export function TimelineAddRow({ onAdd, onOpenKindMenu }: TimelineAddRowProps) {
  const { t } = useAppI18n();
  const openKindMenu = onOpenKindMenu ?? onAdd;

  return (
    <div className="rvi-tl-add">
      <button
        type="button"
        className="rvi-tl-add__main"
        onClick={openKindMenu}
        aria-label={t('Ajouter un élément')}
      >
        <span className="rvi-tl-add__badge" aria-hidden>
          <IconPlus size={16} />
        </span>
        <span className="rvi-tl-add__chevron" aria-hidden>
          <IconChevronDown size={16} />
        </span>
        <span className="rvi-tl-add__label">{t('Ajouter un élément')}</span>
      </button>
    </div>
  );
}

