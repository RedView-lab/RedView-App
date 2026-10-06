import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';

import { UserAvatar } from '@/shared/components/UserAvatar/UserAvatar';
import { useAppI18n } from '@/shared/i18n';
import { appScaledOverlayStyle, readAppScale } from '@/shared/lib/appScale';
import type { CollaboratorAction, ProjectCollaborator } from '../../types';

const MENU_WIDTH = 220;
const MENU_ROW_HEIGHT = 30;
const MENU_GAP = 6;

interface CollaboratorMenuProps {
  /** Sa propre pastille (Présenter ma vue) ou les éditeurs masqués de la pile (« +N »). */
  people: readonly ProjectCollaborator[];
  anchorEl: HTMLElement;
  onAction: (userId: string, action: CollaboratorAction) => void;
  onClose: () => void;
}

/** Action d'une ligne : présenter sa vue (soi), suivre ou arrêter de suivre (les autres). */
function actionFor(person: ProjectCollaborator): CollaboratorAction {
  if (person.isSelf) return person.followed ? 'spotlight-stop' : 'spotlight-start';
  return person.followed ? 'unfollow' : 'follow';
}

/**
 * Menu des pastilles de l'en-tête (comme les outils multijoueur de Figma) :
 * même rendu que tous les menus (`rv-dropdown`), placé sous la pastille à
 * l'échelle du tableau de bord.
 */
export function CollaboratorMenu({ people, anchorEl, onAction, onClose }: CollaboratorMenuProps) {
  const { t } = useAppI18n();
  const menuRef = useRef<HTMLDivElement | null>(null);
  const firstActionRef = useRef<HTMLButtonElement | null>(null);
  const [menuStyle, setMenuStyle] = useState<{ top: number; left: number; scale: number } | null>(null);

  useEffect(() => {
    const onDocPointerDown = (event: MouseEvent) => {
      const target = event.target as Node;
      if (menuRef.current?.contains(target) || anchorEl.contains(target)) return;
      onClose();
    };
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== 'Escape') return;
      event.preventDefault();
      onClose();
    };
    document.addEventListener('mousedown', onDocPointerDown);
    document.addEventListener('keydown', onKeyDown);
    return () => {
      document.removeEventListener('mousedown', onDocPointerDown);
      document.removeEventListener('keydown', onKeyDown);
    };
  }, [anchorEl, onClose]);

  useEffect(() => {
    const handle = window.requestAnimationFrame(() => firstActionRef.current?.focus());
    return () => window.cancelAnimationFrame(handle);
  }, []);

  useLayoutEffect(() => {
    const updatePosition = () => {
      const rect = anchorEl.getBoundingClientRect();
      const scale = readAppScale(anchorEl);
      const menuHeight = MENU_ROW_HEIGHT * people.length * scale;
      const gap = MENU_GAP * scale;
      const maxLeft = Math.max(8, window.innerWidth - MENU_WIDTH * scale - 8);
      const spaceBelow = window.innerHeight - rect.bottom - 8;
      const placeAbove = spaceBelow < menuHeight && rect.top > spaceBelow;
      setMenuStyle({
        top: placeAbove ? rect.top - menuHeight - gap : rect.bottom + gap,
        left: Math.min(Math.max(8, rect.right - MENU_WIDTH * scale), maxLeft),
        scale,
      });
    };
    updatePosition();
    window.addEventListener('resize', updatePosition);
    const resizeObserver = new ResizeObserver(updatePosition);
    resizeObserver.observe(anchorEl);
    return () => {
      resizeObserver.disconnect();
      window.removeEventListener('resize', updatePosition);
    };
  }, [anchorEl, people.length]);

  if (!menuStyle) return null;

  const labelFor = (person: ProjectCollaborator) => {
    switch (actionFor(person)) {
      case 'spotlight-start':
        return t('Présenter ma vue');
      case 'spotlight-stop':
        return t('Arrêter de présenter');
      case 'unfollow':
        return t('Arrêter de suivre {{name}}', { name: person.name });
      default:
        return t('Suivre {{name}}', { name: person.name });
    }
  };

  return createPortal(
    <div
      ref={menuRef}
      className="rv-dropdown rvi-collaborator-menu"
      role="menu"
      style={{ ...appScaledOverlayStyle(menuStyle, false), width: MENU_WIDTH }}
      onMouseDown={(event) => event.stopPropagation()}
    >
      {people.map((person, index) => (
        <button
          key={person.userId}
          ref={index === 0 ? firstActionRef : undefined}
          type="button"
          className="rv-dropdown__item rv-dropdown__item--no-check"
          role="menuitem"
          onClick={() => {
            onAction(person.userId, actionFor(person));
            onClose();
          }}
        >
          <UserAvatar userId={person.userId} name={person.name} size={20} />
          <span className="rv-dropdown__label">{labelFor(person)}</span>
        </button>
      ))}
    </div>,
    anchorEl.ownerDocument.body ?? document.body,
  );
}
