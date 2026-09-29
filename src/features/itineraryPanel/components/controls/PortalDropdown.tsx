import { useEffect, useLayoutEffect, useState, useRef, type ReactNode, type RefObject } from 'react';
import { createPortal } from 'react-dom';

interface PortalDropdownProps {
  open: boolean;
  anchorRef: RefObject<HTMLElement | null>;
  onClose: () => void;
  children: ReactNode;
  /** Largeur fixe (px non scalés). Par défaut : max(minWidth, largeur de l'ancre). */
  width?: number;
  minWidth?: number;
  className?: string;
  align?: 'left' | 'right';
  /** Hauteur de repli tant que le menu n'a pas encore été mesuré (px non scalés). */
  estimatedHeight?: number;
}

/**
 * Menu déroulant rendu en portal. Apparence : `.rv-dropdown` (shared/styles/dropdown.css).
 * Les enfants doivent porter la classe `rv-dropdown__item`.
 */
export function PortalDropdown({
  open,
  anchorRef,
  onClose,
  children,
  width,
  minWidth = 140,
  className = '',
  align = 'right',
  estimatedHeight = 150,
}: PortalDropdownProps) {
  const [pos, setPos] = useState<{
    top: number;
    left: number;
    width: number;
    scale: number;
  } | null>(null);

  const menuRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const handlePointerDown = (e: MouseEvent) => {
      const target = e.target as Node;
      if (
        menuRef.current &&
        !menuRef.current.contains(target) &&
        anchorRef.current &&
        !anchorRef.current.contains(target)
      ) {
        onClose();
      }
    };
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };

    document.addEventListener('mousedown', handlePointerDown);
    document.addEventListener('keydown', handleKeyDown);
    return () => {
      document.removeEventListener('mousedown', handlePointerDown);
      document.removeEventListener('keydown', handleKeyDown);
    };
  }, [open, onClose, anchorRef]);

  useLayoutEffect(() => {
    if (!open || !anchorRef.current) return;

    const updatePos = () => {
      if (!anchorRef.current) return;
      const rect = anchorRef.current.getBoundingClientRect();
      const rawScale = Number.parseFloat(
        window.getComputedStyle(anchorRef.current).getPropertyValue('--app-scale'),
      );
      const scale = Number.isFinite(rawScale) && rawScale > 0 ? rawScale : 1;

      const unscaledWidth = typeof width === 'number' ? width : Math.max(minWidth, rect.width / scale);
      const scaledWidth = unscaledWidth * scale;

      const measuredHeight = menuRef.current?.offsetHeight;
      const neededHeight = (measuredHeight && measuredHeight > 0 ? measuredHeight : estimatedHeight) * scale;
      const spaceBelow = window.innerHeight - rect.bottom - 8;
      const placeAbove = spaceBelow < neededHeight && rect.top > spaceBelow;

      const top = placeAbove
        ? rect.top - neededHeight - 4 * scale
        : rect.bottom + 4 * scale;

      let left = align === 'right' ? rect.right - scaledWidth : rect.left;

      // Keep within viewport boundaries
      left = Math.max(8, Math.min(left, window.innerWidth - scaledWidth - 8));

      setPos({
        top: Math.max(8, top),
        left,
        width: unscaledWidth,
        scale,
      });
    };

    updatePos();
    // Second pass once the menu is in the DOM so its real height drives placement.
    const raf = requestAnimationFrame(updatePos);

    window.addEventListener('scroll', updatePos, true);
    window.addEventListener('resize', updatePos);
    return () => {
      cancelAnimationFrame(raf);
      window.removeEventListener('scroll', updatePos, true);
      window.removeEventListener('resize', updatePos);
    };
  }, [open, anchorRef, width, minWidth, align, estimatedHeight]);

  if (!open) return null;

  return createPortal(
    <div
      ref={menuRef}
      className={`rv-dropdown rvi-portal-dropdown ${className}`}
      style={{
        position: 'fixed',
        top: `${pos?.top ?? 0}px`,
        left: `${pos?.left ?? 0}px`,
        width: `${pos?.width ?? minWidth}px`,
        transform: `scale(${pos?.scale ?? 1})`,
        transformOrigin: 'top left',
        visibility: pos ? 'visible' : 'hidden',
        zIndex: 2147483647,
      }}
      role="listbox"
    >
      {children}
    </div>,
    document.body,
  );
}
