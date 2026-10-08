import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';

import { SvgV2Icon } from '@/shared/components/SvgV2Icon';
import { useAppI18n } from '@/shared/i18n';
import { appScaledOverlayStyle, readAppScale } from '@/shared/lib/appScale';

type MenuDestination = {
  id: string | null;
  label: string;
  disabled?: boolean;
};

type ProjectBrowserCardMenuProps = {
  anchorEl: HTMLButtonElement;
  title: string;
  destinations?: MenuDestination[];
  onClose: () => void;
  /** Absents pour un projet partagé par un autre propriétaire. */
  onRename?: () => void;
  onMove?: (destinationId: string | null) => void;
  onDuplicate?: () => void;
  /** Projet uniquement : téléchargement en fichier `.redview`. */
  onExport?: () => void;
  /** Projet uniquement : membres et invitations (co-édition). */
  onShare?: () => void;
  /** Projet partagé par un autre propriétaire : le quitter. */
  onLeave?: () => void;
  onDelete?: () => void;
};

const MENU_WIDTH = 197;
const MENU_GAP = 8;

export function ProjectBrowserCardMenu({
  anchorEl,
  title,
  destinations = [],
  onClose,
  onRename,
  onMove,
  onDuplicate,
  onExport,
  onShare,
  onLeave,
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
      // Rendu en portail dans <body>, hors du canvas mis à l'échelle du tableau
      // de bord : on lit l'échelle du canvas sur l'ancre pour que le menu garde
      // la densité du gestionnaire de projets.
      const scale = readAppScale(anchorEl);
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
        ...appScaledOverlayStyle(menuStyle),
        width: MENU_WIDTH,
      }}
    >
      {onShare ? (
        <button type="button" className="rv-dropdown__item" role="menuitem" onClick={onShare}>
          <span className="rv-dropdown__label">{t('Partager…')}</span>
          <span className="rv-dropdown__icon" aria-hidden>
            <SvgV2Icon name="share-07.svg" size={16} />
          </span>
        </button>
      ) : null}

      {onDuplicate ? (
        <button type="button" className="rv-dropdown__item" role="menuitem" onClick={onDuplicate}>
          <span className="rv-dropdown__label">{t('Dupliquer')}</span>
          <span className="rv-dropdown__icon" aria-hidden>
            <SvgV2Icon name="copy-03.svg" size={16} />
          </span>
        </button>
      ) : null}

      {onExport ? (
        <button type="button" className="rv-dropdown__item" role="menuitem" onClick={onExport}>
          <span className="rv-dropdown__label">{t('Exporter (.redview)')}</span>
          <span className="rv-dropdown__icon" aria-hidden>
            <SvgV2Icon name="download-01.svg" size={16} />
          </span>
        </button>
      ) : null}

      {onRename ? (
        <button type="button" className="rv-dropdown__item" role="menuitem" onClick={onRename}>
          <span className="rv-dropdown__label">{isFolderMenu ? t('Renommer le dossier') : t('Renommer')}</span>
          <span className="rv-dropdown__icon" aria-hidden>
            <SvgV2Icon name="edit-01.svg" size={16} />
          </span>
        </button>
      ) : null}

      {onMove ? (
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
      ) : null}

      {onMove && moveOpen ? (
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

      {onLeave ? (
        <button type="button" className="rv-dropdown__item rv-dropdown__item--danger" role="menuitem" onClick={onLeave}>
          <span className="rv-dropdown__label">{t('Quitter le projet')}</span>
          <span className="rv-dropdown__icon" aria-hidden>
            <SvgV2Icon name="log-out-03.svg" size={16} />
          </span>
        </button>
      ) : null}

      {onDelete ? (
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
      ) : null}
    </div>,
    document.body,
  );
}