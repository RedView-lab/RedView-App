import { type ReactNode, useState, useRef, useEffect, useLayoutEffect } from 'react';
import { createPortal } from 'react-dom';
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
  className?: string;
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
  className,
  startAdornment,
  variant = 'default',
}: SelectProps<T>) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  const [dropPos, setDropPos] = useState<{ top: number; left: number; width: number } | null>(null);

  useEffect(() => {
    if (!open) return;
    const handler = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener('mousedown', handler);
    return () => document.removeEventListener('mousedown', handler);
  }, [open]);

  useLayoutEffect(() => {
    if (!open || !ref.current) return;
    const rect = ref.current.getBoundingClientRect();
    const dropdownHeight = options.length * 30;
    const spaceBelow = window.innerHeight - rect.bottom - 8;
    const placeAbove = spaceBelow < dropdownHeight && rect.top > spaceBelow;
    setDropPos({
      top: placeAbove ? rect.top - dropdownHeight - 4 : rect.bottom + 4,
      left: rect.left,
      width: Math.max(140, rect.width),
    });
  }, [open, options.length]);

  const dropdown = open && dropPos
    ? createPortal(
        <div
          className="rvc-select__dropdown"
          style={{
            position: 'fixed',
            top: dropPos.top,
            left: dropPos.left,
            width: dropPos.width,
            zIndex: 9999,
          }}
          onMouseDown={(e) => e.stopPropagation()}
        >
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
        </div>,
        document.body,
      )
    : null;

  return (
    <>
      <div
        ref={ref}
        className={`rvc-select rvc-select--${variant}${open ? ' is-open' : ''}${className ? ` ${className}` : ''}`}
        style={width !== undefined ? { width } : undefined}
        onClick={() => setOpen((v) => !v)}
      >
        {startAdornment ? <span className="rvc-select__adornment">{startAdornment}</span> : null}
        <span className="rvc-select__value">
          {options.find((o) => o.value === value)?.label ?? value}
        </span>
        <IconChevronDown size={20} className="rvc-select__chevron" />
      </div>
      {dropdown}
    </>
  );
}
