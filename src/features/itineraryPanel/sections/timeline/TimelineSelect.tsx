import {
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
} from 'react';
import { createPortal } from 'react-dom';
import { IconCheck, IconChevronDown } from '../../components/icons';

export interface TimelineSelectOption<T extends string | number> {
  value: T;
  label: string;
}

interface TimelineSelectProps<T extends string | number> {
  value: T;
  options: readonly TimelineSelectOption<T>[];
  onChange?: (value: T) => void;
  ariaLabel?: string;
}

interface PopoverStyle {
  top: number;
  left: number;
  minWidth: number;
  scale: number;
}

function resolvePortalTarget(anchorEl: HTMLElement): HTMLElement {
  const fullscreenRoot = anchorEl.closest('.rvi-panel-fullscreen-root');
  if (fullscreenRoot instanceof HTMLElement) return fullscreenRoot;
  return anchorEl.ownerDocument.body ?? document.body;
}

function computePopoverStyle(anchorEl: HTMLElement): PopoverStyle {
  const rect = anchorEl.getBoundingClientRect();
  const computed = window.getComputedStyle(anchorEl);
  const rawScale = Number.parseFloat(computed.getPropertyValue('--app-scale'));
  const scale = Number.isFinite(rawScale) && rawScale > 0 ? rawScale : 1;
  const offset = 4 * scale;

  return {
    top: rect.bottom + offset,
    left: rect.left,
    minWidth: Math.max(rect.width, 80 * scale),
    scale,
  };
}

export function TimelineSelect<T extends string | number>({
  value,
  options,
  onChange,
  ariaLabel,
}: TimelineSelectProps<T>) {
  const [isOpen, setIsOpen] = useState(false);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const popoverRef = useRef<HTMLDivElement>(null);
  const [popoverStyle, setPopoverStyle] = useState<PopoverStyle | null>(null);

  const selectedOption = options.find((opt) => opt.value === value) ?? options[0];

  useLayoutEffect(() => {
    if (!isOpen || !triggerRef.current) {
      setPopoverStyle(null);
      return;
    }

    const update = () => {
      if (triggerRef.current) {
        setPopoverStyle(computePopoverStyle(triggerRef.current));
      }
    };

    update();
    window.addEventListener('resize', update);
    window.addEventListener('scroll', update, true);
    return () => {
      window.removeEventListener('resize', update);
      window.removeEventListener('scroll', update, true);
    };
  }, [isOpen]);

  useEffect(() => {
    if (!isOpen) return;

    const handlePointerDown = (event: MouseEvent) => {
      const target = event.target;
      if (!(target instanceof Node)) return;
      if (popoverRef.current?.contains(target)) return;
      if (triggerRef.current?.contains(target)) return;
      setIsOpen(false);
    };

    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') setIsOpen(false);
    };

    document.addEventListener('mousedown', handlePointerDown);
    document.addEventListener('keydown', handleKeyDown);
    return () => {
      document.removeEventListener('mousedown', handlePointerDown);
      document.removeEventListener('keydown', handleKeyDown);
    };
  }, [isOpen]);

  const handleSelect = (nextValue: T) => {
    onChange?.(nextValue);
    setIsOpen(false);
  };

  return (
    <div className="rvi-tl-select-container">
      <button
        ref={triggerRef}
        type="button"
        className={`rvi-tl-select-trigger${isOpen ? ' is-open' : ''}`}
        onClick={() => setIsOpen((prev) => !prev)}
        aria-label={ariaLabel}
        aria-expanded={isOpen}
      >
        <span className="rvi-tl-select-value">{selectedOption?.label ?? ''}</span>
        <span className="rvi-tl-select-chevron" aria-hidden>
          <IconChevronDown size={12} />
        </span>
      </button>

      {isOpen && popoverStyle && triggerRef.current
        ? createPortal(
            <div
              ref={popoverRef}
              className="rvi-tl-select-popover"
              role="listbox"
              style={{
                top: popoverStyle.top,
                left: popoverStyle.left,
                minWidth: popoverStyle.minWidth,
                transform: `scale(${popoverStyle.scale})`,
                transformOrigin: 'top left',
              }}
              onMouseDown={(e) => e.stopPropagation()}
            >
              {options.map((option) => {
                const isSelected = option.value === value;
                return (
                  <button
                    key={String(option.value)}
                    type="button"
                    role="option"
                    aria-selected={isSelected}
                    className={`rvi-tl-select-option${isSelected ? ' is-selected' : ''}`}
                    onClick={() => handleSelect(option.value)}
                  >
                    <span>{option.label}</span>
                    {isSelected ? (
                      <span className="rvi-tl-select-option-check" aria-hidden>
                        <IconCheck size={11} />
                      </span>
                    ) : null}
                  </button>
                );
              })}
            </div>,
            resolvePortalTarget(triggerRef.current),
          )
        : null}
    </div>
  );
}
