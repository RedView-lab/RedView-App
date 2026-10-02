import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';

import { useAppI18n } from '@/shared/i18n';
import { SvgV2Icon } from '@/shared/components/SvgV2Icon';
import { appScaledOverlayStyle, readAppScale } from '@/shared/lib/appScale';
import type { Itinerary } from '@/features/itineraryPanel';
import { IconCopy04, IconTrash } from '@/features/itineraryPanel/components/icons';

const MENU_WIDTH = 200;
const MENU_ROW_HEIGHT = 30;
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
  const { t } = useAppI18n();
  const menuRef = useRef<HTMLDivElement | null>(null);
  const firstActionRef = useRef<HTMLButtonElement | null>(null);
  const [menuStyle, setMenuStyle] = useState<{
    top: number;
    left: number;
    scale: number;
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
      const scale = readAppScale(anchorEl);
      const menuHeight = MENU_ROW_HEIGHT * 3 * scale;
      const gap = MENU_GAP * scale;
      const maxLeft = Math.max(8, window.innerWidth - MENU_WIDTH * scale - 8);
      const spaceBelow = window.innerHeight - rect.bottom - 8;
      const placeAbove = spaceBelow < menuHeight && rect.top > spaceBelow;

      setMenuStyle({
        top: placeAbove ? rect.top - menuHeight - gap : rect.bottom + gap,
        left: Math.min(rect.left, maxLeft),
        scale,
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
      className="rv-dropdown rvc-center-summary__menu"
      role="menu"
      aria-label={t('Actions pour {{name}}', { name: itinerary.name })}
      style={{
        ...appScaledOverlayStyle(menuStyle),
        width: MENU_WIDTH,
      }}
      onMouseDown={(event) => event.stopPropagation()}
    >
      <button
        ref={firstActionRef}
        type="button"
        className="rv-dropdown__item"
        role="menuitem"
        onClick={onStartRename}
      >
        <span className="rv-dropdown__label">{t('Renommer la trace')}</span>
        <span className="rv-dropdown__icon" aria-hidden>
          <SvgV2Icon name="edit-05.svg" size={16} />
        </span>
      </button>
      <button
        type="button"
        className="rv-dropdown__item"
        role="menuitem"
        onClick={onDuplicate}
      >
        <span className="rv-dropdown__label">{t('Dupliquer la trace')}</span>
        <span className="rv-dropdown__icon" aria-hidden>
          <IconCopy04 size={16} />
        </span>
      </button>
      <button
        type="button"
        className="rv-dropdown__item rv-dropdown__item--danger"
        role="menuitem"
        onClick={onDelete}
        disabled={!canDelete}
      >
        <span className="rv-dropdown__label">{t('Supprimer la trace')}</span>
        <span className="rv-dropdown__icon" aria-hidden>
          <IconTrash size={14} />
        </span>
      </button>
    </div>,
    document.body,
  );
}