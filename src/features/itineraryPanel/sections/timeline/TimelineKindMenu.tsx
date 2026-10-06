import {
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type ReactNode,
} from 'react';
import { createPortal } from 'react-dom';
import { useAppI18n } from '@/shared/i18n';
import { appScaledOverlayStyle, readAppScale } from '@/shared/lib/appScale';
import type { TimelineAddItemKind } from '../../types';

/** Fits « Point de passage » / « Destination » with their icon, untruncated. */
const MENU_WIDTH = 168;

interface TimelineKindMenuStyle {
  top: number;
  left: number;
  width: number;
  scale: number;
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
  const scale = readAppScale(anchorEl);
  const menuWidth = MENU_WIDTH * scale;
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
    width: MENU_WIDTH,
    scale,
  };
}

function resolvePortalTarget(anchorEl: HTMLElement): HTMLElement {
  const fullscreenRoot = anchorEl.closest('.rvi-panel-fullscreen-root');
  if (fullscreenRoot instanceof HTMLElement) return fullscreenRoot;
  return anchorEl.ownerDocument.body ?? document.body;
}

export function TimelineKindMenu({
  anchorEl,
  open,
  options,
  onSelect,
  onClose,
}: TimelineKindMenuProps) {
  const { t } = useAppI18n();
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
      if (event.key !== 'Escape') return;
      event.preventDefault();
      onClose?.();
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

  const portalTarget = resolvePortalTarget(anchorEl);
  const inScaledLayer = portalTarget !== anchorEl.ownerDocument.body;

  return createPortal(
    <div
      ref={menuRef}
      className="rv-dropdown rvi-tl-kind-menu"
      role="menu"
      aria-label={t('Ajouter un élément')}
      style={{
        ...appScaledOverlayStyle(menuStyle, inScaledLayer),
        width: menuStyle.width,
      }}
      onMouseDown={(event) => event.stopPropagation()}
    >
      {options.map((option) => (
        <button
          key={option.value}
          type="button"
          role="menuitem"
          disabled={option.disabled}
          className={`rv-dropdown__item${option.disabled ? ' is-disabled' : ''}`}
          onClick={() => {
            if (option.disabled) return;
            onSelect?.(option.value);
            onClose?.();
          }}
        >
          <span className="rvi-tl-kind-menu__icon" aria-hidden>
            {option.icon}
          </span>
          <span className="rv-dropdown__label">{t(option.label)}</span>
        </button>
      ))}
    </div>,
    portalTarget,
  );
}