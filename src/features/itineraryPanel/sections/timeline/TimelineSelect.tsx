import {
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
} from 'react';
import { createPortal } from 'react-dom';
import { appScaledOverlayStyle, readAppScale } from '@/shared/lib/appScale';
import { IconChevronDown } from '../../components/icons';

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
  /** Px non mis à l'échelle — le popover lui-même est mis à l'échelle par `--app-scale`. */
  width: number;
  scale: number;
  /** Portalé dans le panneau plein écran, qui est déjà rendu à `scale`. */
  inScaledLayer: boolean;
  /** Où le popover est portalé (panneau plein écran ou body). */
  portalTarget: HTMLElement;
}

function resolvePortalTarget(anchorEl: HTMLElement): HTMLElement {
  const fullscreenRoot = anchorEl.closest('.rvi-panel-fullscreen-root');
  if (fullscreenRoot instanceof HTMLElement) return fullscreenRoot;
  return anchorEl.ownerDocument.body ?? document.body;
}

function computePopoverStyle(anchorEl: HTMLElement): PopoverStyle {
  const rect = anchorEl.getBoundingClientRect();
  const scale = readAppScale(anchorEl);
  const offset = 4 * scale;
  const portalTarget = resolvePortalTarget(anchorEl);

  return {
    top: rect.bottom + offset,
    left: rect.left,
    width: Math.max(140, rect.width / scale),
    scale,
    inScaledLayer: portalTarget !== anchorEl.ownerDocument.body,
    portalTarget,
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

  // Mesuré avant l'affichage à chaque ouverture : le style d'une ouverture
  // précédente n'est jamais peint (le popover n'est rendu que si `isOpen`).
  useLayoutEffect(() => {
    if (!isOpen || !triggerRef.current) return;

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

      {isOpen && popoverStyle
        ? createPortal(
            <div
              ref={popoverRef}
              className="rv-dropdown rvi-tl-select-popover"
              role="listbox"
              style={{
                ...appScaledOverlayStyle(popoverStyle, popoverStyle.inScaledLayer),
                width: popoverStyle.width,
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
                    className={`rv-dropdown__item${isSelected ? ' is-selected' : ''}`}
                    onClick={() => handleSelect(option.value)}
                  >
                    <span className="rv-dropdown__label">{option.label}</span>
                  </button>
                );
              })}
            </div>,
            popoverStyle.portalTarget,
          )
        : null}
    </div>
  );
}
