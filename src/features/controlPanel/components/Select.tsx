import { type ReactNode, useState, useRef, useEffect, useLayoutEffect } from 'react';
import { createPortal } from 'react-dom';
import { useAppI18n } from '@/shared/i18n';
import { appScaledOverlayStyle, readAppScale } from '@/shared/lib/appScale';
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
  className?: string;
  placeholder?: string;
  /** Affiché à gauche de la valeur, p. ex. une pastille de couleur. */
  startAdornment?: ReactNode;
  /** Variante de classe optionnelle. */
  variant?: 'default' | 'solid';
  disabled?: boolean;
}

/** Liste déroulante personnalisée, stylée d'après le nœud Figma 1792:73224. */
export function Select<T extends string = string>({
  value,
  options,
  onChange,
  width,
  className,
  placeholder,
  startAdornment,
  variant = 'default',
  disabled = false,
}: SelectProps<T>) {
  const { t } = useAppI18n();
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  const [dropPos, setDropPos] = useState<{
    top: number;
    left: number;
    width: number;
    scale: number;
  } | null>(null);

  useEffect(() => {
    if (!open) return;
    const handler = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener('mousedown', handler);
    return () => document.removeEventListener('mousedown', handler);
  }, [open]);

  // Désactivé : la liste se ferme dans ce rendu.
  if (disabled && open) setOpen(false);

  useLayoutEffect(() => {
    if (!open || !ref.current) return;
    const rect = ref.current.getBoundingClientRect();
    const scale = readAppScale(ref.current);
    const rowHeight = 30 * scale;
    const maxDropdownHeight = 260 * scale;
    const rawDropdownHeight = options.length * rowHeight;
    const dropdownHeight = Math.min(rawDropdownHeight, maxDropdownHeight);
    const offset = 4 * scale;
    const spaceBelow = window.innerHeight - rect.bottom - 8;
    const placeAbove = spaceBelow < dropdownHeight && rect.top > spaceBelow;
    setDropPos({
      top: placeAbove ? rect.top - dropdownHeight - offset : rect.bottom + offset,
      left: rect.left,
      width: Math.max(140, rect.width / scale),
      scale,
    });
  }, [open, options.length]);

  const selectedOption = options.find((o) => o.value === value);

  const dropdown = open && !disabled && dropPos
    ? createPortal(
        <div
          className="rv-dropdown rvc-select__dropdown"
          role="listbox"
          style={{
            ...appScaledOverlayStyle(dropPos),
            width: dropPos.width,
          }}
          onMouseDown={(e) => e.stopPropagation()}
        >
          {options.map((o) => (
            <div
              key={o.value}
              role="option"
              aria-selected={o.value === value}
              className={`rv-dropdown__item${o.value === value ? ' is-selected' : ''}`}
              onClick={(e) => {
                e.stopPropagation();
                onChange?.(o.value);
                setOpen(false);
              }}
            >
              <span className="rv-dropdown__label">{t(o.label)}</span>
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
        className={`rvc-select rvc-select--${variant}${open ? ' is-open' : ''}${disabled ? ' is-disabled' : ''}${className ? ` ${className}` : ''}`}
        style={width !== undefined ? { width } : undefined}
        aria-disabled={disabled}
        onClick={() => {
          if (disabled) return;
          setOpen((v) => !v);
        }}
      >
        {startAdornment ? <span className="rvc-select__adornment">{startAdornment}</span> : null}
        <span
          className="rvc-select__value"
          style={!selectedOption && placeholder ? { color: 'rgb(var(--rv-ink) / 0.64)' } : undefined}
        >
          {selectedOption ? t(selectedOption.label) : (placeholder ?? (value ? t(value) : ''))}
        </span>
        <IconChevronDown size={20} className="rvc-select__chevron" />
      </div>
      {dropdown}
    </>
  );
}
