import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';

import { SvgV2Icon } from '@/shared/components/SvgV2Icon';
import { useAppI18n } from '@/shared/i18n';

type MenuDestination = {
  id: string | null;
  label: string;
  disabled?: boolean;
};

type ProjectBrowserCardMenuProps = {
  anchorEl: HTMLButtonElement;
  title: string;
  destinations: MenuDestination[];
  onClose: () => void;
  onRename: () => void;
  onMove: (destinationId: string | null) => void;
  onDuplicate?: () => void;
  onDelete: () => void;
};

const MENU_WIDTH = 197;
const MENU_GAP = 8;

export function ProjectBrowserCardMenu({
  anchorEl,
  title,
  destinations,
  onClose,
  onRename,
  onMove,
  onDuplicate,
  onDelete,
}: ProjectBrowserCardMenuProps) {
  const { t } = useAppI18n();
  const menuRef = useRef<HTMLDivElement | null>(null);
  const [menuStyle, setMenuStyle] = useState<{ top: number; left: number; scale: number } | null>(null);
  const [moveOpen, setMoveOpen] = useState(false);
  const isFolderMenu = title === 'Actions du dossier';

  useEffect(() => {
    const handlePointerDown = (event: MouseEvent) => {
      const target = event.target as Node;
      if (menuRef.current?.contains(target)) return;
      if (anchorEl.contains(target)) return;
      onClose();
    };
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') onClose();
    };
    document.addEventListener('mousedown', handlePointerDown);
    document.addEventListener('keydown', handleKeyDown);
    return () => {
      document.removeEventListener('mousedown', handlePointerDown);
      document.removeEventListener('keydown', handleKeyDown);
    };
  }, [anchorEl, onClose]);

  useLayoutEffect(() => {
    const updatePosition = () => {
      // Portaled to <body>, outside the scaled dashboard canvas: read the
      // canvas scale on the anchor so the menu keeps the browser's density.
      const rawScale = Number.parseFloat(
        window.getComputedStyle(anchorEl).getPropertyValue('--app-scale'),
      );
      const scale = Number.isFinite(rawScale) && rawScale > 0 ? rawScale : 1;
      const scaledWidth = MENU_WIDTH * scale;
      const rect = anchorEl.getBoundingClientRect();
      const nextTop = rect.bottom + MENU_GAP * scale;
      const nextLeft = Math.min(rect.right - scaledWidth, window.innerWidth - scaledWidth - 12);
      setMenuStyle({
        top: nextTop,
        left: Math.max(12, nextLeft),
        scale,
      });
    };

    updatePosition();
    window.addEventListener('resize', updatePosition);
    window.addEventListener('scroll', updatePosition, true);
    return () => {
      window.removeEventListener('resize', updatePosition);
      window.removeEventListener('scroll', updatePosition, true);
    };
  }, [anchorEl]);

  if (!menuStyle) return null;

  return createPortal(
    <div
      ref={menuRef}
      className="rv-dropdown rvpb-card-menu"
      role="menu"
      aria-label={t(title)}
      style={{
        top: menuStyle.top,
        left: menuStyle.left,
        width: MENU_WIDTH,
        transform: menuStyle.scale !== 1 ? `scale(${menuStyle.scale})` : undefined,
        transformOrigin: 'top left',
      }}
    >
      {onDuplicate ? (
        <button type="button" className="rv-dropdown__item" role="menuitem" onClick={onDuplicate}>
          <span className="rv-dropdown__label">{t('Dupliquer')}</span>
          <span className="rv-dropdown__icon" aria-hidden>
            <SvgV2Icon name="copy-03.svg" size={16} />
          </span>
        </button>
      ) : null}

      <button type="button" className="rv-dropdown__item" role="menuitem" onClick={onRename}>
        <span className="rv-dropdown__label">{isFolderMenu ? t('Renommer le dossier') : t('Renommer')}</span>
        <span className="rv-dropdown__icon" aria-hidden>
          <SvgV2Icon name="edit-01.svg" size={16} />
        </span>
      </button>

      <button
        type="button"
        className="rv-dropdown__item"
        role="menuitem"
        aria-expanded={moveOpen}
        onClick={() => setMoveOpen((prev) => !prev)}
      >
        <span className="rv-dropdown__label">{t('Déplacer vers…')}</span>
        <span className="rv-dropdown__icon" aria-hidden>
          <SvgV2Icon name="arrow-circle-right.svg" size={16} />
        </span>
      </button>

      {moveOpen ? (
        <div className="rvpb-card-menu__move-list" role="group" aria-label={t('Destinations disponibles')}>
          {destinations.map((destination) => (
            <button
              key={destination.id ?? '__root__'}
              type="button"
              className="rv-dropdown__item rvpb-card-menu__move-item"
              disabled={destination.disabled}
              onClick={() => {
                onMove(destination.id);
                onClose();
              }}
            >
              <span className="rv-dropdown__label">{destination.label}</span>
            </button>
          ))}
        </div>
      ) : null}

      <button
        type="button"
        className="rv-dropdown__item rv-dropdown__item--danger"
        role="menuitem"
        onClick={onDelete}
      >
        <span className="rv-dropdown__label">{isFolderMenu ? t('Supprimer le dossier') : t('Supprimer')}</span>
        <span className="rv-dropdown__icon" aria-hidden>
          <SvgV2Icon name="trash-03.svg" size={16} />
        </span>
      </button>
    </div>,
    document.body,
  );
}