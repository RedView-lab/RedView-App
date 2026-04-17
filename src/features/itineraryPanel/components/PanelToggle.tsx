import type { ReactNode } from 'react';

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
}

/** Full-width toggle row with trailing info/plus icon slot. */
export function ToggleRow({ checked, onChange, label, trailing }: ToggleRowProps) {
  return (
    <div className="rvi-toggle-row">
      <PanelToggle checked={checked} onChange={onChange} ariaLabel={label} />
      <button
        type="button"
        className="rvi-toggle-row__text"
        onClick={() => onChange?.(!checked)}
      >
        {label}
      </button>
      {trailing ? <span className="rvi-toggle-row__trailing">{trailing}</span> : null}
    </div>
  );
}
