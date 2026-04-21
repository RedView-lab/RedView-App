import {
  createPortal,
} from 'react-dom';
import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type ReactNode,
} from 'react';

interface ColorPalettePickerProps {
  color: string;
  onChange?: (color: string) => void;
  className?: string;
  ariaLabel?: string;
  children: ReactNode;
}

const PALETTE_COLORS = [
  '#000000', '#292524', '#57534E', '#9AA4B2', '#FFFFFF',
  '#202939', '#293056', '#3E4784', '#717BBC', '#4B5565',
  '#18346C', '#0040C1', '#155EEF', '#528BFF', '#155B75',
  '#095C37', '#0E9384', '#2ED3B7', '#22CCEE', '#088AB2',
  '#125D56', '#099250', '#3CCB7F', '#326212', '#4CA30D',
  '#932F19', '#93370D', '#DC6803', '#FF692E', '#FDB022',
  '#912018', '#D92D20', '#F97066', '#F670C7', '#DD2590',
  '#9E165F', '#B692F6', '#7F56D9', '#53389E',
] as const;

const POPUP_WIDTH = 128;
const POPUP_HEIGHT = 202;
const VIEWPORT_GAP = 8;
const ANCHOR_GAP = 6;

function normalizeHex(color: string): string {
  const value = color.startsWith('#') ? color : `#${color}`;
  return value.toUpperCase();
}

export function ColorPalettePicker({
  color,
  onChange,
  className,
  ariaLabel,
  children,
}: ColorPalettePickerProps) {
  const triggerRef = useRef<HTMLButtonElement>(null);
  const popupRef = useRef<HTMLDivElement>(null);
  const [open, setOpen] = useState(false);
  const [position, setPosition] = useState<{ top: number; left: number } | null>(null);
  const currentColor = normalizeHex(color);

  const updatePosition = useCallback(() => {
    const trigger = triggerRef.current;
    if (!trigger) return;

    const rect = trigger.getBoundingClientRect();
    const maxLeft = Math.max(VIEWPORT_GAP, window.innerWidth - POPUP_WIDTH - VIEWPORT_GAP);
    const left = Math.min(Math.max(rect.left, VIEWPORT_GAP), maxLeft);
    const spaceBelow = window.innerHeight - rect.bottom;
    const placeAbove = spaceBelow < POPUP_HEIGHT + ANCHOR_GAP && rect.top > POPUP_HEIGHT + ANCHOR_GAP;
    const preferredTop = placeAbove
      ? rect.top - POPUP_HEIGHT - ANCHOR_GAP
      : rect.bottom + ANCHOR_GAP;
    const maxTop = Math.max(VIEWPORT_GAP, window.innerHeight - POPUP_HEIGHT - VIEWPORT_GAP);
    const top = Math.min(Math.max(preferredTop, VIEWPORT_GAP), maxTop);

    setPosition({ top, left });
  }, []);

  useLayoutEffect(() => {
    if (!open) return;
    updatePosition();
  }, [open, updatePosition]);

  useEffect(() => {
    if (!open) return;

    const handlePointerDown = (event: MouseEvent) => {
      const target = event.target as Node;
      if (triggerRef.current?.contains(target) || popupRef.current?.contains(target)) return;
      setOpen(false);
    };

    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') setOpen(false);
    };

    const handleReposition = () => updatePosition();

    document.addEventListener('mousedown', handlePointerDown);
    document.addEventListener('keydown', handleKeyDown);
    window.addEventListener('resize', handleReposition);
    window.addEventListener('scroll', handleReposition, true);

    return () => {
      document.removeEventListener('mousedown', handlePointerDown);
      document.removeEventListener('keydown', handleKeyDown);
      window.removeEventListener('resize', handleReposition);
      window.removeEventListener('scroll', handleReposition, true);
    };
  }, [open, updatePosition]);

  const popup = open && position
    ? createPortal(
        <div
          ref={popupRef}
          className="rvc-color-palette__popup"
          style={{ top: position.top, left: position.left }}
          role="dialog"
          aria-label={ariaLabel ?? 'Choisir une couleur'}
        >
          <div className="rvc-color-palette__grid">
            {PALETTE_COLORS.map((paletteColor) => {
              const normalized = normalizeHex(paletteColor);
              const isActive = normalized === currentColor;

              return (
                <button
                  key={paletteColor}
                  type="button"
                  className={`rvc-color-palette__swatch${isActive ? ' is-active' : ''}`}
                  style={{ backgroundColor: paletteColor }}
                  aria-label={`Choisir ${normalized}`}
                  aria-pressed={isActive}
                  onClick={() => {
                    onChange?.(normalized);
                    setOpen(false);
                  }}
                />
              );
            })}
          </div>
        </div>,
        document.body,
      )
    : null;

  return (
    <>
      <button
        ref={triggerRef}
        type="button"
        className={`rvc-color-palette__trigger${className ? ` ${className}` : ''}`}
        aria-label={ariaLabel ?? 'Choisir une couleur'}
        aria-expanded={open}
        onClick={() => setOpen((value) => !value)}
      >
        {children}
      </button>
      {popup}
    </>
  );
}
