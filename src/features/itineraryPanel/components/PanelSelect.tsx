import type { ReactNode } from 'react';
import { IconChevronDown } from './icons';

interface SelectOption<T extends string = string> {
  value: T;
  label: string;
}

interface PanelSelectProps<T extends string = string> {
  value: T;
  options: SelectOption<T>[];
  onChange?: (v: T) => void;
  wide?: boolean;
  startAdornment?: ReactNode;
  ariaLabel?: string;
}

/** Native-backed styled dropdown, matches the Figma route selects. */
export function PanelSelect<T extends string = string>({
  value,
  options,
  onChange,
  wide,
  startAdornment,
  ariaLabel,
}: PanelSelectProps<T>) {
  const label = options.find((o) => o.value === value)?.label ?? value;
  return (
    <div className={`rvi-select${wide ? ' rvi-select--wide' : ''}`}>
      {startAdornment}
      <span className="rvi-select__value">{label}</span>
      <IconChevronDown size={16} className="rvi-select__chevron" />
      <select
        aria-label={ariaLabel}
        className="rvi-select__native"
        value={value}
        onChange={(e) => onChange?.(e.target.value as T)}
      >
        {options.map((o) => (
          <option key={o.value} value={o.value}>
            {o.label}
          </option>
        ))}
      </select>
    </div>
  );
}
