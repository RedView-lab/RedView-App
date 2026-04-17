import type { ReactNode } from 'react';
import { IconChevronDown } from '../icons';

interface SelectOption<T extends string = string> {
  value: T;
  label: string;
}

interface SelectProps<T extends string = string> {
  value: T;
  options: SelectOption<T>[];
  onChange?: (value: T) => void;
  width?: number | string;
  /** Rendered on the left side of the value, e.g. a color swatch. */
  startAdornment?: ReactNode;
  /** Optional class variant. */
  variant?: 'default' | 'solid';
}

/** Native <select> styled as a compact dark dropdown. */
export function Select<T extends string = string>({
  value,
  options,
  onChange,
  width,
  startAdornment,
  variant = 'default',
}: SelectProps<T>) {
  return (
    <div
      className={`rvc-select rvc-select--${variant}`}
      style={width !== undefined ? { width } : undefined}
    >
      {startAdornment ? <span className="rvc-select__adornment">{startAdornment}</span> : null}
      <span className="rvc-select__value">
        {options.find((o) => o.value === value)?.label ?? value}
      </span>
      <IconChevronDown size={16} className="rvc-select__chevron" />
      <select
        className="rvc-select__native"
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
