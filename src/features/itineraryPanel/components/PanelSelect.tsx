import { useEffect, useRef, useState, type ReactNode } from 'react';
import { MapCanvasGlassBackdrop } from '@/components/MapCanvasGlassBackdrop';
import { IconChevronDown, IconCheck } from './icons';

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

/** Custom dropdown matching the Figma DROPDOWN component (node 1710:44458). */
export function PanelSelect<T extends string = string>({
  value,
  options,
  onChange,
  wide,
  startAdornment,
  ariaLabel,
}: PanelSelectProps<T>) {
  const [open, setOpen] = useState(false);
  const rootRef = useRef<HTMLDivElement>(null);
  const label = options.find((o) => o.value === value)?.label ?? value;

  useEffect(() => {
    if (!open) return;
    const onDocPointer = (e: PointerEvent) => {
      if (!rootRef.current?.contains(e.target as Node)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setOpen(false);
    };
    document.addEventListener('pointerdown', onDocPointer, true);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('pointerdown', onDocPointer, true);
      document.removeEventListener('keydown', onKey);
    };
  }, [open]);

  return (
    <div
      ref={rootRef}
      className={`rvi-select${wide ? ' rvi-select--wide' : ''}${open ? ' is-open' : ''}`}
    >
      {startAdornment}
      <span className="rvi-select__value">{label}</span>
      <IconChevronDown size={20} className="rvi-select__chevron" />
      <button
        type="button"
        className="rvi-select__trigger"
        aria-label={ariaLabel}
        aria-haspopup="listbox"
        aria-expanded={open}
        onClick={() => setOpen((v) => !v)}
      />
      {open && (
        <div className="rvi-select__menu" role="listbox" aria-label={ariaLabel}>
          <MapCanvasGlassBackdrop blur={30} saturate={1.8} />
          {options.map((o) => {
            const selected = o.value === value;
            return (
              <button
                key={o.value}
                type="button"
                role="option"
                aria-selected={selected}
                className={`rvi-select__option${selected ? ' is-selected' : ''}`}
                onClick={() => {
                  onChange?.(o.value);
                  setOpen(false);
                }}
              >
                <span className="rvi-select__option-label">{o.label}</span>
                {selected && <IconCheck size={16} className="rvi-select__option-check" />}
              </button>
            );
          })}
        </div>
      )}
    </div>
  );
}
