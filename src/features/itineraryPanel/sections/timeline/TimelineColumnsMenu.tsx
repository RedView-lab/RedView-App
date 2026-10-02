/**
 * Portal-based dropdown for the "+ Colonnes" button in the Feuille de route.
 *
 * Mirrors the {@link TimelineKindMenu} pattern: positioned against the anchor
 * with `--app-scale` awareness, dismissed on outside click / Escape, rendered
 * in a portal target that stays inside the fullscreen shell when needed so it
 * can escape clipping ancestors without dropping behind the fullscreen overlay.
 */
import {
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
} from 'react';
import { createPortal } from 'react-dom';
import { useAppI18n } from '@/shared/i18n';
import { appScaledOverlayStyle, readAppScale } from '@/shared/lib/appScale';
import type { TimelineColumnDef, TimelineColumnId } from './TimelineColumns';

interface MenuStyle {
  top: number;
  left: number;
  width: number;
  maxHeight: number;
  scale: number;
}

interface TimelineColumnsMenuProps {
  anchorEl: HTMLElement | null;
  open: boolean;
  columns: readonly TimelineColumnDef[];
  visibility: Record<TimelineColumnId, boolean>;
  onToggle: (id: TimelineColumnId, on: boolean) => void;
  onClose: () => void;
}

const MENU_WIDTH = 324;
const ROW_HEIGHT = 30;

function computeStyle(anchorEl: HTMLElement, rowCount: number): MenuStyle {
  const rect = anchorEl.getBoundingClientRect();
  const scale = readAppScale(anchorEl);

  const offset = 6 * scale;
  const fullHeight = rowCount * ROW_HEIGHT * scale + 8;
  const viewportH = window.innerHeight;

  const spaceBelow = viewportH - rect.bottom - offset - 8;
  const spaceAbove = rect.top - offset - 8;
  const placeBelow = spaceBelow >= Math.min(fullHeight, 240) || spaceBelow >= spaceAbove;
  const maxHeight = Math.max(160, placeBelow ? spaceBelow : spaceAbove);

  const menuWidthPx = MENU_WIDTH * scale;
  const maxLeft = Math.max(8, window.innerWidth - menuWidthPx - 8);
  // Right-align against the trigger button.
  const desiredLeft = rect.right - menuWidthPx;
  const left = Math.min(Math.max(8, desiredLeft), maxLeft);
  const top = placeBelow ? rect.bottom + offset : rect.top - Math.min(fullHeight, maxHeight) - offset;

  return {
    top,
    left,
    width: MENU_WIDTH,
    maxHeight: Math.round(maxHeight / scale),
    scale,
  };
}

function resolvePortalTarget(anchorEl: HTMLElement): HTMLElement {
  const fullscreenRoot = anchorEl.closest('.rvi-panel-fullscreen-root');
  if (fullscreenRoot instanceof HTMLElement) return fullscreenRoot;
  return anchorEl.ownerDocument.body ?? document.body;
}

export function TimelineColumnsMenu({
  anchorEl,
  open,
  columns,
  visibility,
  onToggle,
  onClose,
}: TimelineColumnsMenuProps) {
  const { t } = useAppI18n();
  const menuRef = useRef<HTMLDivElement>(null);
  const [menuStyle, setMenuStyle] = useState<MenuStyle | null>(null);

  useLayoutEffect(() => {
    if (!open || !anchorEl) return;
    const update = () => setMenuStyle(computeStyle(anchorEl, columns.length));
    update();
    window.addEventListener('resize', update);
    window.addEventListener('scroll', update, true);
    return () => {
      window.removeEventListener('resize', update);
      window.removeEventListener('scroll', update, true);
    };
  }, [anchorEl, open, columns.length]);

  useEffect(() => {
    if (!open) return;
    const handlePointerDown = (event: MouseEvent) => {
      const target = event.target;
      if (!(target instanceof Node)) return;
      if (menuRef.current?.contains(target)) return;
      if (anchorEl?.contains(target)) return;
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
  }, [anchorEl, onClose, open]);

  if (!open || !anchorEl || !menuStyle) return null;

  const portalTarget = resolvePortalTarget(anchorEl);
  const inScaledLayer = portalTarget !== anchorEl.ownerDocument.body;

  return createPortal(
    <div
      ref={menuRef}
      className="rv-dropdown rvi-tl-columns-menu"
      role="menu"
      aria-label={t('Colonnes')}
      style={{
        ...appScaledOverlayStyle(menuStyle, inScaledLayer),
        width: menuStyle.width,
        maxHeight: menuStyle.maxHeight,
      }}
      onMouseDown={(event) => event.stopPropagation()}
    >
      {columns.map((col) => {
        const on = visibility[col.id] === true;
        const disabled = col.pinned === true;
        return (
          <button
            key={col.id}
            type="button"
            role="menuitemcheckbox"
            aria-checked={on}
            disabled={disabled}
            className={`rv-dropdown__item${on ? ' is-selected' : ''}${disabled ? ' is-disabled' : ''}`}
            onClick={() => {
              if (disabled) return;
              onToggle(col.id, !on);
            }}
          >
            <span className="rv-dropdown__label">{t(col.label)}</span>
          </button>
        );
      })}
    </div>,
    portalTarget,
  );
}
