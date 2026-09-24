import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { MapCanvasGlassBackdrop } from '@/shared/components/MapCanvasGlassBackdrop';
import { useAppI18n } from '@/shared/i18n';
import { IconCopy04, IconPlus, IconUploadCircle } from '../icons';

const MENU_WIDTH = 270;
const MENU_ROW_HEIGHT = 32;
const MENU_GAP = 6;

interface AddItineraryDialogProps {
  open: boolean;
  anchorEl: HTMLElement | null;
  onClose: () => void;
  onPickScratch: () => void;
  onPickDuplicate?: () => void;
  onPickGpx: () => void;
}

export function AddItineraryDialog({
  open,
  anchorEl,
  onClose,
  onPickScratch,
  onPickDuplicate,
  onPickGpx,
}: AddItineraryDialogProps) {
  const menuRef = useRef<HTMLDivElement>(null);
  const firstActionRef = useRef<HTMLButtonElement>(null);
  const { t } = useAppI18n();
  const [menuStyle, setMenuStyle] = useState<{
    top: number;
    left: number;
    scale: number;
    fontFamily: string;
  } | null>(null);

  useEffect(() => {
    if (!open) return;
    const onDocPointerDown = (event: MouseEvent) => {
      const target = event.target as Node;
      if (menuRef.current?.contains(target)) return;
      if (anchorEl?.contains(target)) return;
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
  }, [anchorEl, onClose, open]);

  useEffect(() => {
    if (!open) return;
    const focusHandle = window.requestAnimationFrame(() => {
      firstActionRef.current?.focus();
    });
    return () => window.cancelAnimationFrame(focusHandle);
  }, [open]);

  // L'option « Dupliquer » n'est proposée que s'il existe un itinéraire
  // sélectionné : en début de création de projet, le menu se limite aux
  // choix manuel et GPX.
  const showDuplicate = Boolean(onPickDuplicate);
  const visibleRowCount = showDuplicate ? 3 : 2;

  useLayoutEffect(() => {
    if (!open || !anchorEl) {
      setMenuStyle(null);
      return;
    }

    const updatePosition = () => {
      const rect = anchorEl.getBoundingClientRect();
      const computed = window.getComputedStyle(anchorEl);
      const rawScale = Number.parseFloat(computed.getPropertyValue('--app-scale'));
      const scale = Number.isFinite(rawScale) && rawScale > 0 ? rawScale : 1;
      const menuHeight = MENU_ROW_HEIGHT * visibleRowCount * scale;
      const gap = MENU_GAP * scale;
      const maxLeft = Math.max(8, window.innerWidth - MENU_WIDTH * scale - 8);
      const spaceBelow = window.innerHeight - rect.bottom - 8;
      const placeAbove = spaceBelow < menuHeight && rect.top > spaceBelow;

      setMenuStyle({
        top: placeAbove ? rect.top - menuHeight - gap : rect.bottom + gap,
        left: Math.min(rect.left, maxLeft),
        scale,
        fontFamily: computed.fontFamily,
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
  }, [anchorEl, open, visibleRowCount]);

  const handleScratch = () => {
    onPickScratch();
    onClose();
  };

  const handleDuplicate = () => {
    if (!onPickDuplicate) return;
    onPickDuplicate();
    onClose();
  };

  const handleGpxClick = () => {
    onClose();
    onPickGpx();
  };

  if (!open || !anchorEl || !menuStyle) {
    return null;
  }

  return createPortal(
    <div
      ref={menuRef}
      className="rvi-add-itin-menu"
      role="menu"
      aria-label={t('Créer un itinéraire')}
      style={{
        top: menuStyle.top,
        left: menuStyle.left,
        width: MENU_WIDTH,
        transform: `scale(${menuStyle.scale})`,
        transformOrigin: 'top left',
        fontFamily: menuStyle.fontFamily,
      }}
      onMouseDown={(e) => e.stopPropagation()}
    >
      <MapCanvasGlassBackdrop blur={34} saturate={1.85} tint="rgba(10, 10, 12, 0.46)" />
      <button
        ref={firstActionRef}
        type="button"
        className="rvi-add-itin-menu__item"
        role="menuitem"
        onClick={handleScratch}
      >
        <span className="rvi-add-itin-menu__label">{t('Créer un nouvel itinéraire')}</span>
        <span className="rvi-add-itin-menu__icon" aria-hidden>
          <IconPlus size={16} />
        </span>
      </button>

      {showDuplicate && (
        <button
          type="button"
          className="rvi-add-itin-menu__item"
          role="menuitem"
          onClick={handleDuplicate}
          disabled={!onPickDuplicate}
        >
          <span className="rvi-add-itin-menu__label">
            {t('Dupliquer à partir de l’itinéraire sélectionné')}
          </span>
          <span className="rvi-add-itin-menu__icon" aria-hidden>
            <IconCopy04 size={16} />
          </span>
        </button>
      )}

      <button
        type="button"
        className="rvi-add-itin-menu__item"
        role="menuitem"
        onClick={handleGpxClick}
      >
        <span className="rvi-add-itin-menu__label">{t('Uploader un fichier gpx')}</span>
        <span className="rvi-add-itin-menu__icon" aria-hidden>
          <IconUploadCircle size={16} />
        </span>
      </button>
    </div>,
    document.body,
  );
}
