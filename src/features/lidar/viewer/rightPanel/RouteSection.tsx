import { memo, useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { Section } from '@/features/controlPanel/components/Section';
import { Select } from '@/features/controlPanel/components/Select';
import { Slider } from '@/features/controlPanel/components/Slider';
import { ColorSwatch } from '@/features/controlPanel/components/ColorSwatch';
import { ColorPalettePicker } from '@/features/controlPanel/components/ColorPalettePicker';
import { IconChevronDown, IconEye, IconRoute, IconTrash } from '@/features/controlPanel/icons';
import { IconKebab, IconPlus } from '@/features/itineraryPanel/components/icons';
import { SvgV2Icon } from '@/shared/components/SvgV2Icon';
import { appScaledOverlayStyle, readAppScale } from '@/shared/lib/appScale';
import type { LidarRouteOverlayItem, ViewerRouteState } from '../route/types';
import { useAppI18n } from '@/shared/i18n';

export interface RouteSectionProps {
  state: ViewerRouteState;
  open?: boolean;
  onOpenChange?: (open: boolean) => void;
  onEnabledChange: (enabled: boolean) => void;
  onSelectRouteId?: (id: string) => void;
  onCreateRoute?: () => void;
  onColorChange?: (id: string, color: string) => void;
  onRouteOpacityChange?: (id: string, opacity: number) => void;
  onVisibilityToggle?: (id: string) => void;
  onRibbonWidthChange: (widthM: number) => void;
  onToggleEditMode?: (id: string) => void;
  onRenameRoute?: (id: string, name: string) => void;
  onDuplicateRoute?: (id: string) => void;
  onExportRouteGpx?: (id: string) => void;
  onDeleteRoute?: (id: string) => void;
}

const MENU_WIDTH = 160;
const MENU_ITEM_HEIGHT = 32;
const MENU_GAP = 6;
const VIEWPORT_PADDING = 8;

const MODE_OPTIONS = [
  { value: 'default', label: 'Défaut' },
  { value: 'slope', label: 'Pente' },
  { value: 'speedEst', label: 'Vitesse est.' },
];

interface OpacityPillProps {
  value: number;
  onChange: (next: number) => void;
}

function OpacityPill({ value, onChange }: OpacityPillProps) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(String(value));
  const inputRef = useRef<HTMLInputElement | null>(null);

  useEffect(() => {
    if (!editing) setDraft(String(value));
  }, [value, editing]);

  useEffect(() => {
    if (editing && inputRef.current) {
      inputRef.current.focus();
      inputRef.current.select();
    }
  }, [editing]);

  const commit = () => {
    const n = Number(draft);
    if (Number.isFinite(n)) {
      const clamped = Math.max(0, Math.min(100, Math.round(n)));
      if (clamped !== value) onChange(clamped);
    }
    setEditing(false);
  };

  if (editing) {
    return (
      <span className="rvc-routes__opacity rvc-routes__opacity--editing">
        <input
          ref={inputRef}
          type="number"
          min={0}
          max={100}
          step={1}
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          onBlur={commit}
          onKeyDown={(e) => {
            if (e.key === 'Enter') commit();
            else if (e.key === 'Escape') {
              setDraft(String(value));
              setEditing(false);
            }
          }}
          className="rvc-routes__opacity-input"
          aria-label="Opacité"
        />
        <span>%</span>
      </span>
    );
  }

  return (
    <button
      type="button"
      className="rvc-routes__opacity"
      onClick={() => setEditing(true)}
      title="Cliquer pour éditer l’opacité"
    >
      <span>{value} %</span>
    </button>
  );
}

interface RouteActionsMenuProps {
  route: LidarRouteOverlayItem;
  trigger: HTMLElement;
  onClose: () => void;
  onRename?: () => void;
  onDuplicate?: () => void;
  onExportGpx?: () => void;
  onDelete?: () => void;
}

/** "⋮" menu of a route row — same items and look as the app's itinerary menu. */
function RouteActionsMenu({ route, trigger, onClose, onRename, onDuplicate, onExportGpx, onDelete }: RouteActionsMenuProps) {
  const { t } = useAppI18n();
  const menuRef = useRef<HTMLDivElement | null>(null);
  const [position, setPosition] = useState<{ top: number; left: number; scale: number } | null>(null);
  const itemCount = [onRename, onDuplicate, onExportGpx, onDelete].filter(Boolean).length;

  useLayoutEffect(() => {
    const update = () => {
      const rect = trigger.getBoundingClientRect();
      const scale = readAppScale(trigger);
      const width = MENU_WIDTH * scale;
      const height = (itemCount * MENU_ITEM_HEIGHT + 2 * MENU_GAP) * scale;
      const left = Math.max(VIEWPORT_PADDING, Math.min(rect.right - width, window.innerWidth - width - VIEWPORT_PADDING));
      const below = rect.bottom + MENU_GAP * scale;
      const top = below + height <= window.innerHeight - VIEWPORT_PADDING
        ? below
        : Math.max(VIEWPORT_PADDING, rect.top - MENU_GAP * scale - height);
      setPosition({ top, left, scale });
    };
    update();
    window.addEventListener('resize', update);
    window.addEventListener('scroll', update, true);
    return () => {
      window.removeEventListener('resize', update);
      window.removeEventListener('scroll', update, true);
    };
  }, [trigger, itemCount]);

  useEffect(() => {
    const handlePointerDown = (event: MouseEvent) => {
      const target = event.target as Node;
      if (menuRef.current?.contains(target) || trigger.contains(target)) return;
      onClose();
    };
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') onClose();
    };
    document.addEventListener('mousedown', handlePointerDown, true);
    document.addEventListener('keydown', handleKeyDown);
    return () => {
      document.removeEventListener('mousedown', handlePointerDown, true);
      document.removeEventListener('keydown', handleKeyDown);
    };
  }, [trigger, onClose]);

  if (!position) return null;

  const run = (action?: () => void) => () => {
    onClose();
    action?.();
  };

  return createPortal(
    <div
      ref={menuRef}
      className="rv-dropdown rvc-routes__actions-menu"
      role="menu"
      aria-label={t('Actions pour {{name}}', { name: route.name })}
      style={{ ...appScaledOverlayStyle(position), width: MENU_WIDTH }}
    >
      {onRename ? (
        <button type="button" className="rv-dropdown__item" role="menuitem" onClick={run(onRename)}>
          <span className="rv-dropdown__label">{t('Renommer')}</span>
          <span className="rv-dropdown__icon" aria-hidden>
            <SvgV2Icon name="edit-05.svg" size={16} />
          </span>
        </button>
      ) : null}
      {onDuplicate ? (
        <button type="button" className="rv-dropdown__item" role="menuitem" onClick={run(onDuplicate)}>
          <span className="rv-dropdown__label">{t('Dupliquer')}</span>
          <span className="rv-dropdown__icon" aria-hidden>
            <SvgV2Icon name="copy-04.svg" size={16} />
          </span>
        </button>
      ) : null}
      {onExportGpx ? (
        <button
          type="button"
          className="rv-dropdown__item"
          role="menuitem"
          disabled={route.points.length === 0}
          onClick={run(onExportGpx)}
        >
          <span className="rv-dropdown__label">{t('Exporter en GPX')}</span>
          <span className="rv-dropdown__icon" aria-hidden>
            <SvgV2Icon name="download-01.svg" size={16} />
          </span>
        </button>
      ) : null}
      {onDelete ? (
        <button type="button" className="rv-dropdown__item rv-dropdown__item--danger" role="menuitem" onClick={run(onDelete)}>
          <span className="rv-dropdown__label">{t('Supprimer')}</span>
          <span className="rv-dropdown__icon" aria-hidden>
            <IconTrash size={14} />
          </span>
        </button>
      ) : null}
    </div>,
    document.body,
  );
}

interface RouteNameInputProps {
  name: string;
  onCommit: (name: string) => void;
  onCancel: () => void;
}

/** Inline rename: Enter or blur commits, Escape cancels. */
function RouteNameInput({ name, onCommit, onCancel }: RouteNameInputProps) {
  const { t } = useAppI18n();
  const [draft, setDraft] = useState(name);
  const inputRef = useRef<HTMLInputElement | null>(null);
  const doneRef = useRef(false);

  useEffect(() => {
    inputRef.current?.focus();
    inputRef.current?.select();
  }, []);

  const finish = (commit: boolean) => {
    if (doneRef.current) return;
    doneRef.current = true;
    const trimmed = draft.trim();
    if (commit && trimmed && trimmed !== name) onCommit(trimmed);
    else onCancel();
  };

  return (
    <input
      ref={inputRef}
      className="rvc-routes__label rvc-routes__label-input"
      value={draft}
      maxLength={120}
      onChange={(e) => setDraft(e.target.value)}
      onBlur={() => finish(true)}
      onKeyDown={(e) => {
        // Keep viewer shortcuts (camera, route editor) away from typing.
        e.stopPropagation();
        if (e.key === 'Enter') {
          e.preventDefault();
          finish(true);
        } else if (e.key === 'Escape') {
          e.preventDefault();
          finish(false);
        }
      }}
      aria-label={t('Renommer {{name}}', { name })}
    />
  );
}

export const RouteSection = memo(function RouteSection({
  state,
  open = true,
  onOpenChange,
  onEnabledChange,
  onSelectRouteId,
  onCreateRoute,
  onColorChange,
  onRouteOpacityChange,
  onVisibilityToggle,
  onRibbonWidthChange,
  onToggleEditMode,
  onRenameRoute,
  onDuplicateRoute,
  onExportRouteGpx,
  onDeleteRoute,
}: RouteSectionProps) {
  const { t } = useAppI18n();
  const { enabled, ribbonWidthM, routes, activeRoute, editMode } = state;
  const [menu, setMenu] = useState<{ routeId: string; trigger: HTMLElement } | null>(null);
  const [renamingId, setRenamingId] = useState<string | null>(null);
  const hasActions = Boolean(onRenameRoute || onDuplicateRoute || onExportRouteGpx || onDeleteRoute);
  const menuRoute = menu ? routes.find((route) => route.id === menu.routeId) ?? null : null;
  const closeMenu = useCallback(() => setMenu(null), []);

  const handleRouteClick = (routeId: string) => {
    if (activeRoute?.id === routeId && editMode) {
      // Toggle off if already active
      onToggleEditMode?.(routeId);
    } else {
      // Select and activate 3D tracing on tiles
      onSelectRouteId?.(routeId);
      onToggleEditMode?.(routeId);
    }
  };

  return (
    <Section
      title={t('Itinéraires')}
      icon={<IconRoute size={16} />}
      toggle={{ checked: enabled, onChange: onEnabledChange }}
      open={open}
      onOpenChange={onOpenChange}
    >
      <div className="rvc-routes__list">

        {routes.map((route) => {
          const isActive = activeRoute?.id === route.id;
          const isDrawing = isActive && editMode;

          return (
            <div key={route.id} className={`rvc-routes__row${hasActions ? ' rvc-routes__row--actions' : ''}`}>
              <ColorPalettePicker
                color={route.color}
                onChange={(nextColor) => onColorChange?.(route.id, nextColor)}
                className="rvc-routes__color-picker"
                ariaLabel={t('Choisir la couleur de {{name}}', { name: route.name })}
              >
                <ColorSwatch color={route.color} size={12} />
                <IconChevronDown size={20} />
              </ColorPalettePicker>

              {renamingId === route.id ? (
                <RouteNameInput
                  name={route.name}
                  onCommit={(name) => {
                    setRenamingId(null);
                    onRenameRoute?.(route.id, name);
                  }}
                  onCancel={() => setRenamingId(null)}
                />
              ) : (
                <div
                  className="rvc-routes__label"
                  onClick={() => handleRouteClick(route.id)}
                  style={{
                    cursor: 'pointer',
                    color: isDrawing ? '#4ade80' : isActive ? '#fff' : undefined,
                    fontWeight: isActive ? 700 : 600,
                    opacity: isDrawing || isActive ? 1 : 0.64,
                  }}
                  title={isDrawing ? 'En cours de tracé 3D (cliquez sur les dalles)' : 'Cliquer pour tracer sur les dalles 3D'}
                >
                  {isDrawing ? `● ${route.name}` : route.name}
                </div>
              )}

              <Select
                className="rvc-routes__mode-select"
                width="var(--rvc-panel-route-mode-width)"
                value="default"
                options={MODE_OPTIONS}
                onChange={() => {}}
              />

              <div className="rvc-routes__visibility-group" data-visible={route.visible !== false ? 'true' : 'false'}>
                <button
                  type="button"
                  className="rvc-routes__eye"
                  onClick={() => onVisibilityToggle?.(route.id)}
                  aria-pressed={route.visible !== false}
                  aria-label={route.visible !== false ? 'Masquer la trace' : 'Afficher la trace'}
                  title={route.visible !== false ? 'Masquer la trace' : 'Afficher la trace'}
                >
                  <IconEye size={14} />
                </button>
                <OpacityPill
                  value={Math.round((route.opacity ?? 1) * 100)}
                  onChange={(next) => onRouteOpacityChange?.(route.id, next)}
                />
              </div>

              {hasActions ? (
                <button
                  type="button"
                  className={`rvc-routes__menu-trigger${menu?.routeId === route.id ? ' is-open' : ''}`}
                  aria-label={t('Actions pour {{name}}', { name: route.name })}
                  aria-haspopup="menu"
                  aria-expanded={menu?.routeId === route.id}
                  onClick={(event) => {
                    const trigger = event.currentTarget;
                    setMenu((current) => (current?.routeId === route.id ? null : { routeId: route.id, trigger }));
                  }}
                >
                  <IconKebab size={14} />
                </button>
              ) : null}
            </div>
          );
        })}

        {menu && menuRoute ? (
          <RouteActionsMenu
            route={menuRoute}
            trigger={menu.trigger}
            onClose={closeMenu}
            onRename={onRenameRoute ? () => setRenamingId(menuRoute.id) : undefined}
            onDuplicate={onDuplicateRoute ? () => onDuplicateRoute(menuRoute.id) : undefined}
            onExportGpx={onExportRouteGpx ? () => onExportRouteGpx(menuRoute.id) : undefined}
            onDelete={onDeleteRoute ? () => onDeleteRoute(menuRoute.id) : undefined}
          />
        ) : null}

        <button
          type="button"
          className="rvc-routes__add-btn"
          onClick={onCreateRoute}
          title="Créer un nouvel itinéraire sur les dalles 3D"
        >
          <span className="rvc-routes__add-icon" aria-hidden>
            <IconPlus size={13} />
          </span>
          <span className="rvc-routes__add-label">Nouvel itinéraire</span>
        </button>

        <div className="rvc-row rvc-row--split rvc-routes__trace-width-row">
          <span className="rvc-row__label">Épaisseur des tracés</span>
          <div className="rvc-routes__trace-width-control">
            <div className="rvc-routes__trace-width-slider-wrap">
              <Slider
                value={ribbonWidthM}
                min={1}
                max={20}
                step={1}
                onChange={onRibbonWidthChange}
                width="100%"
              />
            </div>
            <span className="rvc-routes__trace-width-value">{Math.round(ribbonWidthM)} px</span>
          </div>
        </div>
      </div>
    </Section>
  );
});
