import {
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type ReactNode,
} from 'react';
import { createPortal } from 'react-dom';
import { MapCanvasGlassBackdrop } from '@/shared/components/MapCanvasGlassBackdrop';
import { IconChevronDown, IconCheck } from '../icons';

interface SelectOption<T extends string = string> {
  value: T;
  label: string;
}

interface PanelSelectProps<T extends string = string> {
  value: T;
  options: readonly SelectOption<T>[];
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
  const [dropPos, setDropPos] = useState<{
    top: number;
    left: number;
    width: number;
    scale: number;
    fontFamily: string;
    fontSize: string;
    fontWeight: string;
    lineHeight: string;
  } | null>(null);
  const label = options.find((o) => o.value === value)?.label ?? value;

  useEffect(() => {
    if (!open) return;
    const onDocPointer = (e: MouseEvent) => {
      if (rootRef.current && !rootRef.current.contains(e.target as Node)) {
        setOpen(false);
      }
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setOpen(false);
    };
    document.addEventListener('mousedown', onDocPointer);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('mousedown', onDocPointer);
      document.removeEventListener('keydown', onKey);
    };
  }, [open]);

  useLayoutEffect(() => {
    if (!open || !rootRef.current) return;
    const rect = rootRef.current.getBoundingClientRect();
    const computed = window.getComputedStyle(rootRef.current);
    const rawScale = Number.parseFloat(computed.getPropertyValue('--app-scale'));
    const scale = Number.isFinite(rawScale) && rawScale > 0 ? rawScale : 1;
    const rowHeight = 32 * scale;
    const dropdownHeight = options.length * rowHeight;
    const offset = 4 * scale;
    const spaceBelow = window.innerHeight - rect.bottom - 8;
    const placeAbove = spaceBelow < dropdownHeight && rect.top > spaceBelow;

    setDropPos({
      top: placeAbove ? rect.top - dropdownHeight - offset : rect.bottom + offset,
      left: rect.left,
      width: Math.max(104, rect.width / scale),
      scale,
      fontFamily: computed.fontFamily,
      fontSize: computed.fontSize,
      fontWeight: computed.fontWeight,
      lineHeight: computed.lineHeight,
    });
  }, [open, options.length]);

  const dropdown =
    open && dropPos
      ? createPortal(
          <div
            className="rvi-select__menu"
            role="listbox"
            aria-label={ariaLabel}
            style={{
              top: dropPos.top,
              left: dropPos.left,
              width: dropPos.width,
              transform: `scale(${dropPos.scale})`,
              transformOrigin: 'top left',
              fontFamily: dropPos.fontFamily,
              fontSize: dropPos.fontSize,
              fontWeight: dropPos.fontWeight,
              lineHeight: dropPos.lineHeight,
            }}
            onMouseDown={(e) => e.stopPropagation()}
          >
            <MapCanvasGlassBackdrop blur={30} saturate={1.8} />
            {options.map((o) => {
              const selected = o.value === value;
              return (
                <div
                  key={o.value}
                  role="option"
                  aria-selected={selected}
                  className={`rvi-select__option${selected ? ' is-selected' : ''}`}
                  onClick={(e) => {
                    e.stopPropagation();
                    onChange?.(o.value);
                    setOpen(false);
                  }}
                >
                  <span className="rvi-select__option-label">{o.label}</span>
                  {selected && <IconCheck size={16} className="rvi-select__option-check" />}
                </div>
              );
            })}
          </div>,
          document.body,
        )
      : null;

  return (
    <>
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
      </div>
      {dropdown}
    </>
  );
}
