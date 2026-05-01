import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';

import { SvgV2Icon } from '@/shared/components/SvgV2Icon';
import { IconCopy04, IconTrash } from '@/features/itineraryPanel/components/icons';

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

const MENU_WIDTH = 280;
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
  const menuRef = useRef<HTMLDivElement | null>(null);
  const [menuStyle, setMenuStyle] = useState<{ top: number; left: number } | null>(null);
  const [moveOpen, setMoveOpen] = useState(false);

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
      const rect = anchorEl.getBoundingClientRect();
      const nextTop = rect.bottom + MENU_GAP;
      const nextLeft = Math.min(rect.right - MENU_WIDTH, window.innerWidth - MENU_WIDTH - 12);
      setMenuStyle({
        top: nextTop,
        left: Math.max(12, nextLeft),
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
      className="rvpb-card-menu"
      role="menu"
      aria-label={title}
      style={{ top: menuStyle.top, left: menuStyle.left, width: MENU_WIDTH }}
    >
      <button type="button" className="rvpb-card-menu__item" role="menuitem" onClick={onRename}>
        <span>{title === 'Actions du dossier' ? 'Renommer le dossier' : 'Renommer le projet'}</span>
        <SvgV2Icon name="edit-05.svg" size={16} />
      </button>

      <button
        type="button"
        className="rvpb-card-menu__item"
        role="menuitem"
        aria-expanded={moveOpen}
        onClick={() => setMoveOpen((prev) => !prev)}
      >
        <span>Déplacer vers…</span>
        <SvgV2Icon name="switch-horizontal-01.svg" size={16} />
      </button>

      {moveOpen ? (
        <div className="rvpb-card-menu__move-list" role="group" aria-label="Destinations disponibles">
          {destinations.map((destination) => (
            <button
              key={destination.id ?? '__root__'}
              type="button"
              className="rvpb-card-menu__move-item"
              disabled={destination.disabled}
              onClick={() => {
                onMove(destination.id);
                onClose();
              }}
            >
              {destination.label}
            </button>
          ))}
        </div>
      ) : null}

      {onDuplicate ? (
        <button type="button" className="rvpb-card-menu__item" role="menuitem" onClick={onDuplicate}>
          <span>Dupliquer le projet</span>
          <IconCopy04 size={16} />
        </button>
      ) : null}

      <button
        type="button"
        className="rvpb-card-menu__item rvpb-card-menu__item--danger"
        role="menuitem"
        onClick={onDelete}
      >
        <span>{title === 'Actions du dossier' ? 'Supprimer le dossier' : 'Supprimer le projet'}</span>
        <IconTrash size={14} />
      </button>
    </div>,
    document.body,
  );
}