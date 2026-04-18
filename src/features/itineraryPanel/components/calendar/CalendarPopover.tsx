import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { Calendar, type CalendarProps } from './Calendar';

/**
 * Floating popover that hosts a `<Calendar />` and anchors itself to a
 * trigger element. Renders into `document.body` (portal) so the
 * surrounding panel's `overflow: hidden` cannot clip it.
 *
 * Positioning rules (deterministic, no third-party "floating-ui" dep):
 *   • Open below the trigger by default (8 px gap).
 *   • Flip above when there isn't enough room below.
 *   • Align the popover's left edge with the trigger; clamp inside the
 *     viewport with an 8 px safe-area.
 *   • Reposition on scroll/resize while open.
 *
 * Dismissal:
 *   • Click outside anywhere (capture phase).
 *   • Escape key.
 *   • Selecting a date.
 */
export interface CalendarPopoverProps extends CalendarProps {
  open: boolean;
  anchorRef: React.RefObject<HTMLElement | null>;
  onClose: () => void;
}

const POPOVER_WIDTH = 304; // 7 cells × 40 + 2 × 12 padding
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
  const [pos, setPos] = useState<{ top: number; left: number } | null>(null);

  // Position computation — runs on open, scroll, and resize.
  useLayoutEffect(() => {
    if (!open) return;

    const compute = () => {
      const trigger = anchorRef.current;
      if (!trigger) return;
      const rect = trigger.getBoundingClientRect();
      const popHeight = popoverRef.current?.offsetHeight ?? 360;

      const spaceBelow = window.innerHeight - rect.bottom - VIEWPORT_PADDING;
      const spaceAbove = rect.top - VIEWPORT_PADDING;
      const placeAbove = spaceBelow < popHeight && spaceAbove > spaceBelow;

      const top = placeAbove
        ? rect.top - popHeight - TRIGGER_GAP
        : rect.bottom + TRIGGER_GAP;

      const rawLeft = rect.left;
      const maxLeft = window.innerWidth - POPOVER_WIDTH - VIEWPORT_PADDING;
      const left = Math.max(VIEWPORT_PADDING, Math.min(rawLeft, maxLeft));

      setPos({ top, left });
    };

    compute();
    window.addEventListener('scroll', compute, true);
    window.addEventListener('resize', compute);
    return () => {
      window.removeEventListener('scroll', compute, true);
      window.removeEventListener('resize', compute);
    };
  }, [open, anchorRef]);

  // Click-outside + Escape.
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
        top: pos?.top ?? -9999,
        left: pos?.left ?? -9999,
        width: POPOVER_WIDTH,
        // Hide the popover for one frame while we measure to avoid a flash
        // at the wrong position.
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
