import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { appScaledOverlayStyle, readAppScale } from '@/shared/lib/appScale';
import { Calendar, type CalendarProps } from './Calendar';

/**
 * Popover flottant qui contient un `<Calendar />` et s'ancre à un élément
 * déclencheur. Rendu dans `document.body` (portail) pour que le
 * `overflow: hidden` du panneau environnant ne puisse pas le rogner.
 *
 * Règles de positionnement (déterministes, sans dépendance « floating-ui ») :
 *   • Ouvert sous le déclencheur par défaut (écart de 8 px).
 *   • Basculé au-dessus quand la place manque en dessous.
 *   • Bord gauche du popover aligné sur le déclencheur ; borné dans la
 *     fenêtre avec une marge de sécurité de 8 px.
 *   • Repositionné au défilement/redimensionnement tant qu'il est ouvert.
 *
 * Fermeture :
 *   • Clic n'importe où à l'extérieur (phase de capture).
 *   • Touche Échap.
 *   • Choix d'une date.
 */
export interface CalendarPopoverProps extends CalendarProps {
  open: boolean;
  anchorRef: React.RefObject<HTMLElement | null>;
  onClose: () => void;
}

const POPOVER_WIDTH = 304; // 7 cellules × 40 + 2 × 12 de padding
const VIEWPORT_PADDING = 8;
const TRIGGER_GAP = 6;

export function CalendarPopover({
  open,
  anchorRef,
  onClose,
  value,
  onSelect,
  markedDates,
}: CalendarPopoverProps) {
  const popoverRef = useRef<HTMLDivElement | null>(null);
  const [pos, setPos] = useState<{ top: number; left: number; scale: number } | null>(null);

  // Calcul de la position — à l'ouverture, au défilement et au redimensionnement.
  useLayoutEffect(() => {
    if (!open) return;

    const compute = () => {
      const trigger = anchorRef.current;
      if (!trigger) return;

      const scale = readAppScale(trigger);

      const rect = trigger.getBoundingClientRect();
      const popHeight = (popoverRef.current?.offsetHeight ?? 360) * scale;
      const popWidth = POPOVER_WIDTH * scale;

      const spaceBelow = window.innerHeight - rect.bottom - VIEWPORT_PADDING;
      const spaceAbove = rect.top - VIEWPORT_PADDING;
      const placeAbove = spaceBelow < popHeight && spaceAbove > spaceBelow;

      const top = placeAbove
        ? rect.top - popHeight - TRIGGER_GAP
        : rect.bottom + TRIGGER_GAP;

      const rawLeft = rect.left;
      const maxLeft = window.innerWidth - popWidth - VIEWPORT_PADDING;
      const left = Math.max(VIEWPORT_PADDING, Math.min(rawLeft, maxLeft));

      setPos({ top, left, scale });
    };

    compute();
    window.addEventListener('scroll', compute, true);
    window.addEventListener('resize', compute);
    return () => {
      window.removeEventListener('scroll', compute, true);
      window.removeEventListener('resize', compute);
    };
  }, [open, anchorRef]);

  // Clic extérieur + Échap.
  useEffect(() => {
    if (!open) return;
    const onDocClick = (e: MouseEvent) => {
      const target = e.target as Node;
      if (
        popoverRef.current?.contains(target) ||
        anchorRef.current?.contains(target)
      ) {
        return;
      }
      onClose();
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    document.addEventListener('mousedown', onDocClick, true);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('mousedown', onDocClick, true);
      document.removeEventListener('keydown', onKey);
    };
  }, [open, onClose, anchorRef]);

  if (!open || typeof document === 'undefined') return null;

  return createPortal(
    <div
      ref={popoverRef}
      className="rvi-calendar-popover"
      style={{
        ...(pos ? appScaledOverlayStyle(pos) : { top: -9999, left: -9999 }),
        width: POPOVER_WIDTH,
        // Masquer le popover une image le temps de la mesure pour éviter un
        // flash à la mauvaise position.
        visibility: pos ? 'visible' : 'hidden',
      }}
    >
      <Calendar
        value={value}
        markedDates={markedDates}
        onSelect={(iso) => {
          onSelect(iso);
          onClose();
        }}
      />
    </div>,
    document.body,
  );
}
