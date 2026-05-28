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
import { IconCheck } from '../../components/icons';
import type { TimelineColumnDef, TimelineColumnId } from './TimelineColumns';

interface MenuStyle {
  top: number;
  left: number;
  width: number;
  maxHeight: number;
  scale: number;
  fontFamily: string;
  fontSize: string;
  fontWeight: string;
  lineHeight: string;
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
  const computed = window.getComputedStyle(anchorEl);
  const rawScale = Number.parseFloat(computed.getPropertyValue('--app-scale'));
  const scale = Number.isFinite(rawScale) && rawScale > 0 ? rawScale : 1;

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
    fontFamily: computed.fontFamily,
    fontSize: computed.fontSize,
    fontWeight: computed.fontWeight,
    lineHeight: computed.lineHeight,
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

  return createPortal(
    <div
      ref={menuRef}
      className="rvi-tl-columns-menu"
      role="menu"
      aria-label={t('Colonnes')}
      style={{
        top: menuStyle.top,
        left: menuStyle.left,
        width: menuStyle.width,
        maxHeight: menuStyle.maxHeight,
        transform: `scale(${menuStyle.scale})`,
        transformOrigin: 'top left',
        fontFamily: menuStyle.fontFamily,
        fontSize: menuStyle.fontSize,
        fontWeight: menuStyle.fontWeight,
        lineHeight: menuStyle.lineHeight,
      }}
      onMouseDown={(event) => event.stopPropagation()}
    >
      <div className="rvi-tl-columns-menu__scroll">
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
              className={`rvi-tl-columns-menu__option${on ? ' is-on' : ''}${disabled ? ' is-disabled' : ''}`}
              onClick={() => {
                if (disabled) return;
                onToggle(col.id, !on);
              }}
            >
              <span className="rvi-tl-columns-menu__label">{t(col.label)}</span>
              <span className="rvi-tl-columns-menu__check" aria-hidden>
                {on ? <IconCheck size={16} /> : null}
              </span>
            </button>
          );
        })}
      </div>
    </div>,
    portalTarget,
  );
}
