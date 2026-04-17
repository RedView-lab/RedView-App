import type { ReactNode } from 'react';
import { IconCheck } from './icons';

interface CheckboxProps {
  checked: boolean;
  onChange?: (v: boolean) => void;
  ariaLabel?: string;
}

export function PanelCheckbox({ checked, onChange, ariaLabel }: CheckboxProps) {
  return (
    <label className="rvi-checkbox">
      <span className={`rvi-checkbox__box${checked ? ' is-checked' : ''}`}>
        {checked ? <IconCheck size={10} /> : null}
      </span>
      <input
        type="checkbox"
        className="rvi-checkbox__native"
        checked={checked}
        onChange={(e) => onChange?.(e.target.checked)}
        aria-label={ariaLabel}
      />
    </label>
  );
}

interface CheckboxFieldProps {
  checked: boolean;
  onToggle?: (v: boolean) => void;
  label: string;
  trailing: ReactNode;
}

/** Row: [✓] Label (opacity 64) <trailing element>. */
export function CheckboxField({
  checked,
  onToggle,
  label,
  trailing,
}: CheckboxFieldProps) {
  return (
    <div className="rvi-cfield">
      <PanelCheckbox checked={checked} onChange={onToggle} ariaLabel={label} />
      <span className="rvi-cfield__label" title={label}>
        {label}
      </span>
      {trailing}
    </div>
  );
}
