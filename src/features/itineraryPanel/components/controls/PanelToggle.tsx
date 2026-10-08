import type { ReactNode } from 'react';
import { useAppI18n } from '@/shared/i18n';

interface ToggleProps {
  checked: boolean;
  onChange?: (next: boolean) => void;
  ariaLabel?: string;
}

export function PanelToggle({ checked, onChange, ariaLabel }: ToggleProps) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      aria-label={ariaLabel}
      className={`rvi-toggle${checked ? ' is-on' : ''}`}
      onClick={() => onChange?.(!checked)}
    >
      <span className="rvi-toggle__knob" />
    </button>
  );
}

interface ToggleRowProps {
  checked: boolean;
  onChange?: (v: boolean) => void;
  label: string;
  trailing?: ReactNode;
  trailingMuted?: boolean;
  /**
   * À true, l'élément de fin se colle au libellé avec un écart de 4 px au lieu
   * de l'écart de 12 px par défaut de la ligne. Conforme à Figma 855:19587 (ligne
   * de bascule POI favori, où l'icône d'info vit dans le même conteneur
   * flex-[1_0_0] gap-4 que le libellé). Laisser à false pour les lignes où
   * l'emplacement de fin est un vrai frère du libellé à l'écart de la ligne (par
   * ex. le bouton « + » de la bascule Intervalle, Figma 855:19785).
   */
  trailingTight?: boolean;
}

/** Full-width toggle row with trailing info/plus icon slot. */
export function ToggleRow({
  checked,
  onChange,
  label,
  trailing,
  trailingMuted = false,
  trailingTight = false,
}: ToggleRowProps) {
  const { t } = useAppI18n();

  return (
    <div
      className={`rvi-toggle-row${trailingTight ? ' rvi-toggle-row--tighttrail' : ''}`}
    >
      <PanelToggle checked={checked} onChange={onChange} ariaLabel={t(label)} />
      <button
        type="button"
        className="rvi-toggle-row__text"
        onClick={() => onChange?.(!checked)}
      >
        {t(label)}
      </button>
      {trailing ? (
        <span
          className={`rvi-toggle-row__trailing${trailingMuted ? ' rvi-toggle-row__trailing--muted' : ''}`}
        >
          {trailing}
        </span>
      ) : null}
    </div>
  );
}
