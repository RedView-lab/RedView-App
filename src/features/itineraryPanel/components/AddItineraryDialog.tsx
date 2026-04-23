import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import type { ChangeEvent } from 'react';
import { createPortal } from 'react-dom';
import { MapCanvasGlassBackdrop } from '@/components/MapCanvasGlassBackdrop';
import { IconCopy04, IconPlus, IconUploadCircle } from './icons';

const MENU_WIDTH = 270;
const MENU_ROW_HEIGHT = 32;
const MENU_GAP = 6;

interface AddItineraryDialogProps {
  open: boolean;
  anchorEl: HTMLElement | null;
  onClose: () => void;
  onPickScratch: () => void;
  onPickDuplicate?: () => void;
  onPickGpx: (file: File) => Promise<void> | void;
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
  const fileInputRef = useRef<HTMLInputElement>(null);
  const firstActionRef = useRef<HTMLButtonElement>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [menuStyle, setMenuStyle] = useState<{
    top: number;
    left: number;
    scale: number;
    fontFamily: string;
  } | null>(null);

  useEffect(() => {
    if (open) {
      setError(null);
    }
  }, [open]);

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
      const menuHeight = (MENU_ROW_HEIGHT * 3 + (error ? 34 : 0)) * scale;
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
  }, [anchorEl, error, open]);

  const handleFileChange = async (e: ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    e.target.value = '';
    if (!file) return;
    if (!file.name.toLowerCase().endsWith('.gpx')) {
      setError('Veuillez sélectionner un fichier .gpx');
      return;
    }
    setError(null);
    setLoading(true);
    try {
      await onPickGpx(file);
      onClose();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Impossible de lire ce GPX');
    } finally {
      setLoading(false);
    }
  };

  const handleScratch = () => {
    onPickScratch();
    onClose();
  };

  const handleDuplicate = () => {
    if (!onPickDuplicate || loading) return;
    onPickDuplicate();
    onClose();
  };

  if (!open || !anchorEl || !menuStyle) {
    return null;
  }

  return createPortal(
    <>
      <div
        ref={menuRef}
        className="rvi-add-itin-menu"
        role="menu"
        aria-label="Créer un itinéraire"
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
          disabled={loading}
        >
          <span className="rvi-add-itin-menu__label">Créer un nouvel itinéraire</span>
          <span className="rvi-add-itin-menu__icon" aria-hidden>
            <IconPlus size={16} />
          </span>
        </button>

        <button
          type="button"
          className="rvi-add-itin-menu__item"
          role="menuitem"
          onClick={handleDuplicate}
          disabled={loading || !onPickDuplicate}
        >
          <span className="rvi-add-itin-menu__label">
            Dupliquer à partir de l’itinéraire sélectionné
          </span>
          <span className="rvi-add-itin-menu__icon" aria-hidden>
            <IconCopy04 size={16} />
          </span>
        </button>

        <button
          type="button"
          className="rvi-add-itin-menu__item"
          role="menuitem"
          onClick={() => {
            if (loading) return;
            fileInputRef.current?.click();
          }}
          disabled={loading}
        >
          <span className="rvi-add-itin-menu__label">
            {loading ? 'Lecture du GPX…' : 'Uploader un fichier gpx'}
          </span>
          <span className="rvi-add-itin-menu__icon" aria-hidden>
            <IconUploadCircle size={16} />
          </span>
        </button>

        {error ? (
          <div className="rvi-add-itin-menu__error" role="alert">
            {error}
          </div>
        ) : null}
      </div>

      <input
        ref={fileInputRef}
        type="file"
        accept=".gpx,application/gpx+xml,application/xml,text/xml"
        onChange={handleFileChange}
        disabled={loading}
        hidden
      />
    </>,
    document.body,
  );
}
