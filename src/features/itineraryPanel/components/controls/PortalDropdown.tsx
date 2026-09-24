import { useEffect, useLayoutEffect, useState, useRef, type ReactNode, type RefObject } from 'react';
import { createPortal } from 'react-dom';

interface PortalDropdownProps {
  open: boolean;
  anchorRef: RefObject<HTMLElement | null>;
  onClose: () => void;
  children: ReactNode;
  width?: number;
  minWidth?: number;
  className?: string;
  align?: 'left' | 'right';
  estimatedHeight?: number;
}

export function PortalDropdown({
  open,
  anchorRef,
  onClose,
  children,
  width,
  minWidth,
  className = '',
  align = 'right',
  estimatedHeight = 150,
}: PortalDropdownProps) {
  const [pos, setPos] = useState<{
    top: number;
    left: number;
    width: number;
    placeAbove: boolean;
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

      const resolvedWidth =
        typeof width === 'number'
          ? width * scale
          : Math.max(minWidth ? minWidth * scale : rect.width, rect.width);

      const spaceBelow = window.innerHeight - rect.bottom - 8;
      const neededHeight = estimatedHeight * scale;
      const placeAbove = spaceBelow < neededHeight && rect.top > spaceBelow;

      const top = placeAbove
        ? rect.top - neededHeight - 4 * scale
        : rect.bottom + 4 * scale;

      let left = align === 'right' ? rect.right - resolvedWidth : rect.left;

      // Keep within viewport boundaries
      left = Math.max(8, Math.min(left, window.innerWidth - resolvedWidth - 8));

      setPos({
        top: Math.max(8, top),
        left,
        width: resolvedWidth,
        placeAbove,
      });
    };

    updatePos();

    window.addEventListener('scroll', updatePos, true);
    window.addEventListener('resize', updatePos);
    return () => {
      window.removeEventListener('scroll', updatePos, true);
      window.removeEventListener('resize', updatePos);
    };
  }, [open, anchorRef, width, minWidth, align, estimatedHeight]);

  if (!open || !pos) return null;

  return createPortal(
    <div
      ref={menuRef}
      className={`rvi-portal-dropdown ${className}`}
      style={{
        position: 'fixed',
        top: `${pos.top}px`,
        left: `${pos.left}px`,
        width: `${pos.width}px`,
        zIndex: 2147483647,
      }}
      role="listbox"
    >
      {children}
    </div>,
    document.body,
  );
}
