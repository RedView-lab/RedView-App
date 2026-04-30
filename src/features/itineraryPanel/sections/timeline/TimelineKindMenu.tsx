import {
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type ReactNode,
} from 'react';
import { createPortal } from 'react-dom';
import { MapCanvasGlassBackdrop } from '@/shared/components/MapCanvasGlassBackdrop';
import type { TimelineAddItemKind } from '../../types';

interface TimelineKindMenuStyle {
  top: number;
  left: number;
  width: number;
  scale: number;
  fontFamily: string;
  fontSize: string;
  fontWeight: string;
  lineHeight: string;
}

export interface TimelineKindMenuOption {
  value: TimelineAddItemKind;
  label: string;
  icon: ReactNode;
  disabled?: boolean;
}

interface TimelineKindMenuProps {
  anchorEl: HTMLElement | null;
  open: boolean;
  options: readonly TimelineKindMenuOption[];
  onSelect?: (kind: TimelineAddItemKind) => void;
  onClose?: () => void;
}

function computeMenuStyle(
  anchorEl: HTMLElement,
  optionCount: number,
): TimelineKindMenuStyle {
  const rect = anchorEl.getBoundingClientRect();
  const computed = window.getComputedStyle(anchorEl);
  const rawScale = Number.parseFloat(computed.getPropertyValue('--app-scale'));
  const scale = Number.isFinite(rawScale) && rawScale > 0 ? rawScale : 1;
  const menuWidth = 139 * scale;
  const menuHeight = optionCount * 30 * scale + 2;
  const offset = 6 * scale;
  const maxLeft = Math.max(8, window.innerWidth - menuWidth - 8);
  const left = Math.min(Math.max(8, rect.left), maxLeft);
  const topBelow = rect.bottom + offset;
  const topAbove = rect.top - menuHeight - offset;
  const top =
    topBelow + menuHeight > window.innerHeight - 8 && topAbove >= 8
      ? topAbove
      : topBelow;

  return {
    top,
    left,
    width: 139,
    scale,
    fontFamily: computed.fontFamily,
    fontSize: computed.fontSize,
    fontWeight: computed.fontWeight,
    lineHeight: computed.lineHeight,
  };
}

export function TimelineKindMenu({
  anchorEl,
  open,
  options,
  onSelect,
  onClose,
}: TimelineKindMenuProps) {
  const menuRef = useRef<HTMLDivElement>(null);
  const [menuStyle, setMenuStyle] = useState<TimelineKindMenuStyle | null>(null);

  useLayoutEffect(() => {
    if (!open || !anchorEl) {
      setMenuStyle(null);
      return;
    }

    const update = () => {
      setMenuStyle(computeMenuStyle(anchorEl, options.length));
    };

    update();
    window.addEventListener('resize', update);
    window.addEventListener('scroll', update, true);
    return () => {
      window.removeEventListener('resize', update);
      window.removeEventListener('scroll', update, true);
    };
  }, [anchorEl, open, options.length]);

  useEffect(() => {
    if (!open) return;

    const handlePointerDown = (event: MouseEvent) => {
      const target = event.target;
      if (!(target instanceof Node)) return;
      if (menuRef.current?.contains(target)) return;
      if (anchorEl?.contains(target)) return;
      onClose?.();
    };

    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') onClose?.();
    };

    document.addEventListener('mousedown', handlePointerDown);
    document.addEventListener('keydown', handleKeyDown);
    return () => {
      document.removeEventListener('mousedown', handlePointerDown);
      document.removeEventListener('keydown', handleKeyDown);
    };
  }, [anchorEl, onClose, open]);

  if (!open || !anchorEl || !menuStyle) {
    return null;
  }

  return createPortal(
    <div
      ref={menuRef}
      className="rvi-tl-kind-menu"
      role="menu"
      aria-label="Ajouter un élément"
      style={{
        top: menuStyle.top,
        left: menuStyle.left,
        width: menuStyle.width,
        transform: `scale(${menuStyle.scale})`,
        transformOrigin: 'top left',
        fontFamily: menuStyle.fontFamily,
        fontSize: menuStyle.fontSize,
        fontWeight: menuStyle.fontWeight,
        lineHeight: menuStyle.lineHeight,
      }}
      onMouseDown={(event) => event.stopPropagation()}
    >
      <MapCanvasGlassBackdrop blur={60} saturate={1.8} />
      {options.map((option) => (
        <button
          key={option.value}
          type="button"
          role="menuitem"
          disabled={option.disabled}
          className={`rvi-tl-kind-menu__option${option.disabled ? ' is-disabled' : ''}`}
          onClick={() => {
            if (option.disabled) return;
            onSelect?.(option.value);
            onClose?.();
          }}
        >
          <span className="rvi-tl-kind-menu__icon" aria-hidden>
            {option.icon}
          </span>
          <span className="rvi-tl-kind-menu__label">{option.label}</span>
        </button>
      ))}
    </div>,
    document.body,
  );
}