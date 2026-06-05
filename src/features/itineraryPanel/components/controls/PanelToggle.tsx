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
   * When true the trailing element hugs the label at a 4-px gap instead
   * of the row's default 12-px gap. Matches Figma 855:19587 (POI favori
   * toggle row, where the info icon lives inside the same flex-[1_0_0]
   * gap-4 wrapper as the label). Leave false for rows where the trailing
   * slot is a true sibling of the label at the row-level gap (e.g. the
   * "+" button on the Interval toggle, Figma 855:19785).
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
