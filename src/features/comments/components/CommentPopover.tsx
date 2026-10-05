import { useEffect, useLayoutEffect, useRef, type ReactNode } from 'react';
import { createPortal } from 'react-dom';

import { appScaledOverlayStyle, readAppScale } from '@/shared/lib/appScale';

/**
 * Menu ou sélecteur ancré à un bouton (menu « … », réactions, tri), rendu sur
 * <body> au-dessus de tout (la carte d'un fil défile et couperait un menu
 * interne). Même mise à l'échelle que les menus de l'app (`appScaledOverlayStyle`),
 * fermé au clic extérieur et par Échap.
 */

interface CommentPopoverProps {
  anchorEl: HTMLElement | null;
  open: boolean;
  onClose(): void;
  /** Largeur logique (px), pour rester dans la fenêtre. */
  width: number;
  /** Bord du bouton auquel le menu s'aligne. */
  align?: 'start' | 'end';
  className?: string;
  role?: 'menu' | 'dialog' | 'listbox';
  label?: string;
  children: ReactNode;
}

const EDGE = 8;
const OFFSET = 6;

/** Place le menu sous le bouton (au-dessus s'il ne tient pas), écrit directement dans son style. */
function placePopover(element: HTMLElement, anchorEl: HTMLElement, width: number, align: 'start' | 'end'): void {
  const rect = anchorEl.getBoundingClientRect();
  const scale = readAppScale(anchorEl);
  const screenWidth = width * scale;
  const height = element.offsetHeight * scale;
  const preferredLeft = align === 'end' ? rect.right - screenWidth : rect.left;
  const left = Math.min(Math.max(EDGE, preferredLeft), Math.max(EDGE, window.innerWidth - screenWidth - EDGE));
  const below = rect.bottom + OFFSET * scale;
  const above = rect.top - height - OFFSET * scale;
  const top = below + height > window.innerHeight - EDGE && above >= EDGE ? above : below;
  const style = appScaledOverlayStyle({ top, left, scale });
  element.style.top = `${style.top}px`;
  element.style.left = `${style.left}px`;
  element.style.zoom = style.zoom !== undefined ? String(style.zoom) : '';
  element.style.transform = typeof style.transform === 'string' ? style.transform : '';
  element.style.transformOrigin = typeof style.transformOrigin === 'string' ? style.transformOrigin : '';
  element.style.visibility = 'visible';
}

export function CommentPopover({ anchorEl, open, onClose, width, align = 'end', className, role = 'menu', label, children }: CommentPopoverProps) {
  const ref = useRef<HTMLDivElement>(null);
  const onCloseRef = useRef(onClose);
  useEffect(() => {
    onCloseRef.current = onClose;
  });

  useLayoutEffect(() => {
    const element = ref.current;
    if (!open || !anchorEl || !element) return;
    const update = () => placePopover(element, anchorEl, width, align);
    update();
    window.addEventListener('resize', update);
    window.addEventListener('scroll', update, true);
    const observer = typeof ResizeObserver === 'undefined' ? null : new ResizeObserver(update);
    observer?.observe(element);
    return () => {
      window.removeEventListener('resize', update);
      window.removeEventListener('scroll', update, true);
      observer?.disconnect();
    };
  }, [align, anchorEl, open, width]);

  useEffect(() => {
    if (!open) return;
    const handlePointerDown = (event: MouseEvent) => {
      const target = event.target;
      if (!(target instanceof Node)) return;
      if (ref.current?.contains(target) || anchorEl?.contains(target)) return;
      onCloseRef.current();
    };
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key !== 'Escape') return;
      event.stopPropagation();
      onCloseRef.current();
    };
    document.addEventListener('mousedown', handlePointerDown, true);
    document.addEventListener('keydown', handleKeyDown, true);
    return () => {
      document.removeEventListener('mousedown', handlePointerDown, true);
      document.removeEventListener('keydown', handleKeyDown, true);
    };
  }, [anchorEl, open]);

  if (!open || !anchorEl) return null;
  return createPortal(
    <div
      ref={ref}
      className={`rv-comment-popover${className ? ` ${className}` : ''}`}
      role={role}
      aria-label={label}
      style={{ top: -9999, left: -9999, width, visibility: 'hidden' }}
      onMouseDown={(event) => event.stopPropagation()}
    >
      {children}
    </div>,
    anchorEl.ownerDocument.body ?? document.body,
  );
}
