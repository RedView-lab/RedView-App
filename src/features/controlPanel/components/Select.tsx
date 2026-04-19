import { type ReactNode, useState, useRef, useEffect } from 'react';
import { IconChevronDown, IconCheck } from '../icons';

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

/** Custom dropdown styled per Figma node 1792:73224. */
export function Select<T extends string = string>({
  value,
  options,
  onChange,
  width,
  startAdornment,
  variant = 'default',
}: SelectProps<T>) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const handler = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener('mousedown', handler);
    return () => document.removeEventListener('mousedown', handler);
  }, [open]);

  return (
    <div
      ref={ref}
      className={`rvc-select rvc-select--${variant}${open ? ' is-open' : ''}`}
      style={width !== undefined ? { width } : undefined}
      onClick={() => setOpen((v) => !v)}
    >
      {startAdornment ? <span className="rvc-select__adornment">{startAdornment}</span> : null}
      <span className="rvc-select__value">
        {options.find((o) => o.value === value)?.label ?? value}
      </span>
      <IconChevronDown size={20} className="rvc-select__chevron" />

      {open && (
        <div className="rvc-select__dropdown">
          {options.map((o) => (
            <div
              key={o.value}
              className={`rvc-select__option${o.value === value ? ' is-selected' : ''}`}
              onClick={(e) => {
                e.stopPropagation();
                onChange?.(o.value);
                setOpen(false);
              }}
            >
              <span className="rvc-select__option-label">{o.label}</span>
              {o.value === value && <IconCheck size={16} className="rvc-select__option-check" />}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
