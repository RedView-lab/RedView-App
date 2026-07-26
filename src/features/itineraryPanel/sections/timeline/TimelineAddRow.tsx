import type { MouseEventHandler } from 'react';
import { useAppI18n } from '@/shared/i18n';

/**
 * "Ajouter un élément" row — ends the sheet view.
 *
 * Matches Figma node 855:20479: a single rounded bar with a plain "+"
 * glyph + label on the left and a chevron on the right (no divider).
 * The whole row opens the kind picker.
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

