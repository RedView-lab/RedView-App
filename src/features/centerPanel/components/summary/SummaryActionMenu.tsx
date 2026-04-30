import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';

import { MapCanvasGlassBackdrop } from '@/shared/components/MapCanvasGlassBackdrop';
import { SvgV2Icon } from '@/shared/components/SvgV2Icon';
import type { Itinerary } from '@/features/itineraryPanel';
import { IconCopy04, IconTrash } from '@/features/itineraryPanel/components/icons';

const MENU_WIDTH = 270;
const MENU_ROW_HEIGHT = 32;
const MENU_GAP = 6;

interface SummaryActionMenuProps {
  itinerary: Itinerary;
  anchorEl: HTMLButtonElement;
  canDelete: boolean;
  onClose: () => void;
  onStartRename: () => void;
  onDuplicate: () => void;
  onDelete: () => void;
}

export function SummaryActionMenu({
  itinerary,
  anchorEl,
  canDelete,
  onClose,
  onStartRename,
  onDuplicate,
  onDelete,
}: SummaryActionMenuProps) {
  const menuRef = useRef<HTMLDivElement | null>(null);
  const firstActionRef = useRef<HTMLButtonElement | null>(null);
  const [menuStyle, setMenuStyle] = useState<{
    top: number;
    left: number;
    scale: number;
    fontFamily: string;
    transformOrigin: string;
  } | null>(null);

  useEffect(() => {
    const onDocPointerDown = (event: MouseEvent) => {
      const target = event.target as Node;
      if (menuRef.current?.contains(target)) return;
      if (anchorEl.contains(target)) return;
      onClose();
    };
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') onClose();
    };
    document.addEventListener('mousedown', onDocPointerDown);
    document.addEventListener('keydown', onKeyDown);
    return () => {
      document.removeEventListener('mousedown', onDocPointerDown);
      document.removeEventListener('keydown', onKeyDown);
    };
  }, [anchorEl, onClose]);

  useEffect(() => {
    const handle = window.requestAnimationFrame(() => {
      firstActionRef.current?.focus();
    });
    return () => window.cancelAnimationFrame(handle);
  }, []);

  useLayoutEffect(() => {
    const updatePosition = () => {
      const rect = anchorEl.getBoundingClientRect();
      const computed = window.getComputedStyle(anchorEl);
      const rawScale = Number.parseFloat(computed.getPropertyValue('--app-scale'));
      const scale = Number.isFinite(rawScale) && rawScale > 0 ? rawScale : 1;
      const menuHeight = MENU_ROW_HEIGHT * 3 * scale;
      const gap = MENU_GAP * scale;
      const maxLeft = Math.max(8, window.innerWidth - MENU_WIDTH * scale - 8);
      const spaceBelow = window.innerHeight - rect.bottom - 8;
      const placeAbove = spaceBelow < menuHeight && rect.top > spaceBelow;

      setMenuStyle({
        top: placeAbove ? rect.top - menuHeight - gap : rect.bottom + gap,
        left: Math.min(rect.left, maxLeft),
        scale,
        fontFamily: computed.fontFamily,
        transformOrigin: placeAbove ? 'bottom left' : 'top left',
      });
    };

    updatePosition();
    window.addEventListener('resize', updatePosition);
    window.addEventListener('scroll', updatePosition, true);
    const resizeObserver = new ResizeObserver(updatePosition);
    resizeObserver.observe(anchorEl);
    return () => {
      resizeObserver.disconnect();
      window.removeEventListener('resize', updatePosition);
      window.removeEventListener('scroll', updatePosition, true);
    };
  }, [anchorEl]);

  if (!menuStyle) return null;

  return createPortal(
    <div
      ref={menuRef}
      className="rvc-center-summary__menu"
      role="menu"
      aria-label={`Actions pour ${itinerary.name}`}
      style={{
        top: menuStyle.top,
        left: menuStyle.left,
        width: MENU_WIDTH,
        transform: `scale(${menuStyle.scale})`,
        transformOrigin: menuStyle.transformOrigin,
        fontFamily: menuStyle.fontFamily,
      }}
      onMouseDown={(event) => event.stopPropagation()}
    >
      <MapCanvasGlassBackdrop blur={34} saturate={1.85} tint="rgba(10, 10, 12, 0.46)" />

      <button
        ref={firstActionRef}
        type="button"
        className="rvc-center-summary__menu-item"
        role="menuitem"
        onClick={onStartRename}
      >
        <span className="rvc-center-summary__menu-label">Renommer la trace</span>
        <span className="rvc-center-summary__menu-icon" aria-hidden>
          <SvgV2Icon name="edit-05.svg" size={16} />
        </span>
      </button>
      <button
        type="button"
        className="rvc-center-summary__menu-item"
        role="menuitem"
        onClick={onDuplicate}
      >
        <span className="rvc-center-summary__menu-label">Dupliquer la trace</span>
        <span className="rvc-center-summary__menu-icon" aria-hidden>
          <IconCopy04 size={16} />
        </span>
      </button>
      <button
        type="button"
        className="rvc-center-summary__menu-item rvc-center-summary__menu-item--danger"
        role="menuitem"
        onClick={onDelete}
        disabled={!canDelete}
      >
        <span className="rvc-center-summary__menu-label">Supprimer la trace</span>
        <span className="rvc-center-summary__menu-icon" aria-hidden>
          <IconTrash size={14} />
        </span>
      </button>
    </div>,
    document.body,
  );
}