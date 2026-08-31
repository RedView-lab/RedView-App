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
  // 1. Blanc au Noir (Grayscale)
  '#FFFFFF', '#D4D4D8', '#71717A', '#27272A', '#000000',
  // 2. Blanc au Bleu foncé
  '#FFFFFF', '#93C5FD', '#3B82F6', '#1D4ED8', '#0A1B3F',
  // 3. Cyan au Bleu pétrole
  '#CCFBF1', '#22D3EE', '#06B6D4', '#0F766E', '#083344',
  // 4. Vert clair au Vert foncé
  '#DCFCE7', '#4ADE80', '#16A34A', '#15803D', '#052E16',
  // 5. Jaune au Rouge
  '#FEF08A', '#FBBF24', '#F97316', '#DC2626', '#7F1D1D',
  // 6. Pêche à Terre / Brun
  '#FFEDD5', '#FB923C', '#C2410C', '#78350F', '#431407',
  // 7. Rose au Violet
  '#FBCFE8', '#F472B6', '#D946EF', '#9333EA', '#3B0764',
  // 8. Lavande au Bleu nuit
  '#EDE9FE', '#A78BFA', '#6366F1', '#4338CA', '#1E1B4B',
] as const;

const POPUP_WIDTH = 128;
const POPUP_HEIGHT = 188;
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
  const [position, setPosition] = useState<{ top: number; left: number; scale: number; placeAbove: boolean } | null>(null);
  const currentColor = normalizeHex(color);

  const updatePosition = useCallback(() => {
    const trigger = triggerRef.current;
    if (!trigger) return;

    const computed = window.getComputedStyle(trigger);
    const rawScale = Number.parseFloat(computed.getPropertyValue('--app-scale'));
    const scale = Number.isFinite(rawScale) && rawScale > 0 ? rawScale : 1;

    const rect = trigger.getBoundingClientRect();
    const popupWidth = POPUP_WIDTH * scale;
    const popupHeight = POPUP_HEIGHT * scale;
    const maxLeft = Math.max(VIEWPORT_GAP, window.innerWidth - popupWidth - VIEWPORT_GAP);
    const left = Math.min(Math.max(rect.left, VIEWPORT_GAP), maxLeft);
    const spaceBelow = window.innerHeight - rect.bottom;
    const placeAbove = spaceBelow < popupHeight + ANCHOR_GAP && rect.top > popupHeight + ANCHOR_GAP;
    const preferredTop = placeAbove
      ? rect.top - popupHeight - ANCHOR_GAP
      : rect.bottom + ANCHOR_GAP;
    const maxTop = Math.max(VIEWPORT_GAP, window.innerHeight - popupHeight - VIEWPORT_GAP);
    const top = Math.min(Math.max(preferredTop, VIEWPORT_GAP), maxTop);

    setPosition({ top, left, scale, placeAbove });
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
          style={{
            top: position.top,
            left: position.left,
            transform: position.scale !== 1 ? `scale(${position.scale})` : undefined,
            transformOrigin: position.placeAbove ? 'bottom left' : 'top left',
          }}
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
