import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type RefObject } from 'react';
import type { Map as MapboxMap, MapMouseEvent } from 'mapbox-gl';

import { MapCanvasGlassBackdrop } from '@/shared/components/MapCanvasGlassBackdrop';
import { useAppI18n } from '@/shared/i18n';

import { MenuActionRow } from './MenuActionRow';
import {
  CopyButtonIcon,
  ElevationGlyph,
  FinishGlyph,
  PoiPinGlyph,
  StartGlyph,
  WaypointGlyph,
} from './icons';
import type { MapContextMenuActionId, MapContextMenuActionPayload, MapContextMenuPoint } from './types';
import { clamp, copyTextToClipboard, formatCoordinates } from './utils';

const MENU_EDGE_PADDING = 8;
const RIGHT_CLICK_MOVE_TOLERANCE_PX = 8;
const RIGHT_CLICK_MAX_HOLD_MS = 320;

interface MapContextMenuProps {
  map: MapboxMap | null;
  containerRef: RefObject<HTMLDivElement | null>;
  onAction?: (payload: MapContextMenuActionPayload) => void;
}

interface MenuState {
  left: number;
  top: number;
  screenX: number;
  screenY: number;
  point: MapContextMenuPoint;
}

interface PendingRightClickState {
  startedAtMs: number;
  startX: number;
  startY: number;
  moved: boolean;
  consumed: boolean;
}

export function MapContextMenu({ map, containerRef, onAction }: MapContextMenuProps) {
  const { t } = useAppI18n();
  const menuRef = useRef<HTMLDivElement | null>(null);
  const copyResetTimerRef = useRef<number | null>(null);
  const pendingRightClickRef = useRef<PendingRightClickState | null>(null);
  const [menuState, setMenuState] = useState<MenuState | null>(null);
  const [copied, setCopied] = useState(false);

  const closeMenu = useCallback(() => {
    setMenuState(null);
    setCopied(false);
    if (copyResetTimerRef.current != null) {
      window.clearTimeout(copyResetTimerRef.current);
      copyResetTimerRef.current = null;
    }
  }, []);

  useEffect(() => {
    if (!map) return;

    const canvas = map.getCanvas();

    const resetPendingRightClick = () => {
      pendingRightClickRef.current = null;
    };

    const markPendingRightClickAsMoved = () => {
      const pending = pendingRightClickRef.current;
      if (!pending) return;
      pending.moved = true;
    };

    const handleMouseDown = (event: MouseEvent) => {
      if (event.button !== 2) return;
      pendingRightClickRef.current = {
        startedAtMs: performance.now(),
        startX: event.clientX,
        startY: event.clientY,
        moved: false,
        consumed: false,
      };
    };

    const handleMouseMove = (event: MouseEvent) => {
      const pending = pendingRightClickRef.current;
      if (!pending) return;

      const deltaX = event.clientX - pending.startX;
      const deltaY = event.clientY - pending.startY;
      if (Math.hypot(deltaX, deltaY) > RIGHT_CLICK_MOVE_TOLERANCE_PX) {
        pending.moved = true;
      }
    };

    const handleMouseUp = (event: MouseEvent) => {
      if (event.button !== 2) return;
      const pending = pendingRightClickRef.current;
      if (!pending) return;
      if (pending.consumed || pending.moved) {
        pendingRightClickRef.current = null;
      }
    };

    const handleContextMenu = (event: MapMouseEvent) => {
      event.preventDefault();

      const pending = pendingRightClickRef.current;
      const elapsedMs = pending ? performance.now() - pending.startedAtMs : Number.POSITIVE_INFINITY;
      const shouldOpenMenu = Boolean(
        pending
          && !pending.consumed
          && !pending.moved
          && elapsedMs <= RIGHT_CLICK_MAX_HOLD_MS,
      );

      pendingRightClickRef.current = null;
      if (!shouldOpenMenu || !pending) return;

      const container = containerRef.current;
      if (!container) return;

      const { lng, lat } = event.lngLat;
      const rect = container.getBoundingClientRect();
      const elevation = map.queryTerrainElevation?.([lng, lat]);

      setCopied(false);
      pending.consumed = true;
      setMenuState({
        left: event.originalEvent.clientX - rect.left,
        top: event.originalEvent.clientY - rect.top,
        screenX: event.originalEvent.clientX,
        screenY: event.originalEvent.clientY,
        point: {
          lng,
          lat,
          elevationMeters: Number.isFinite(elevation) ? Number(elevation) : null,
          coordinatesLabel: formatCoordinates(lat, lng),
        },
      });
    };

    canvas.addEventListener('mousedown', handleMouseDown);
    canvas.addEventListener('mousemove', handleMouseMove);
    canvas.addEventListener('mouseup', handleMouseUp);
    canvas.addEventListener('mouseleave', resetPendingRightClick);
    map.on('contextmenu', handleContextMenu);
    map.on('movestart', closeMenu);
    map.on('dragstart', closeMenu);
    map.on('pitchstart', closeMenu);
    map.on('rotatestart', closeMenu);
    map.on('movestart', markPendingRightClickAsMoved);
    map.on('dragstart', markPendingRightClickAsMoved);
    map.on('pitchstart', markPendingRightClickAsMoved);
    map.on('rotatestart', markPendingRightClickAsMoved);

    return () => {
      canvas.removeEventListener('mousedown', handleMouseDown);
      canvas.removeEventListener('mousemove', handleMouseMove);
      canvas.removeEventListener('mouseup', handleMouseUp);
      canvas.removeEventListener('mouseleave', resetPendingRightClick);
      map.off('contextmenu', handleContextMenu);
      map.off('movestart', closeMenu);
      map.off('dragstart', closeMenu);
      map.off('pitchstart', closeMenu);
      map.off('rotatestart', closeMenu);
      map.off('movestart', markPendingRightClickAsMoved);
      map.off('dragstart', markPendingRightClickAsMoved);
      map.off('pitchstart', markPendingRightClickAsMoved);
      map.off('rotatestart', markPendingRightClickAsMoved);
    };
  }, [closeMenu, containerRef, map]);

  useLayoutEffect(() => {
    if (!menuState || !menuRef.current || !containerRef.current) return;

    const menuRect = menuRef.current.getBoundingClientRect();
    const containerRect = containerRef.current.getBoundingClientRect();
    const nextLeft = clamp(
      menuState.left,
      MENU_EDGE_PADDING,
      Math.max(MENU_EDGE_PADDING, containerRect.width - menuRect.width - MENU_EDGE_PADDING),
    );
    const nextTop = clamp(
      menuState.top,
      MENU_EDGE_PADDING,
      Math.max(MENU_EDGE_PADDING, containerRect.height - menuRect.height - MENU_EDGE_PADDING),
    );

    if (nextLeft !== menuState.left || nextTop !== menuState.top) {
      setMenuState((current) => {
        if (!current) return current;
        if (current.left === nextLeft && current.top === nextTop) return current;
        return { ...current, left: nextLeft, top: nextTop };
      });
    }
  }, [containerRef, menuState]);

  useEffect(() => {
    if (!menuState) return;

    const handlePointerDown = (event: MouseEvent) => {
      const target = event.target as Node;
      if (menuRef.current?.contains(target)) return;
      closeMenu();
    };

    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') closeMenu();
    };

    const handleWindowChange = () => closeMenu();

    document.addEventListener('mousedown', handlePointerDown);
    document.addEventListener('keydown', handleKeyDown);
    window.addEventListener('resize', handleWindowChange);
    window.addEventListener('blur', handleWindowChange);

    return () => {
      document.removeEventListener('mousedown', handlePointerDown);
      document.removeEventListener('keydown', handleKeyDown);
      window.removeEventListener('resize', handleWindowChange);
      window.removeEventListener('blur', handleWindowChange);
    };
  }, [closeMenu, menuState]);

  const emitAction = useCallback((action: MapContextMenuActionId) => {
    if (!menuState) return;
    onAction?.({
      action,
      point: menuState.point,
      screenPoint: {
        x: menuState.screenX,
        y: menuState.screenY,
      },
    });
  }, [menuState, onAction]);

  const handleCopyCoordinates = useCallback(async () => {
    if (!menuState) return;
    try {
      await copyTextToClipboard(menuState.point.coordinatesLabel);
      emitAction('copy-coordinates');
      setCopied(true);
      if (copyResetTimerRef.current != null) {
        window.clearTimeout(copyResetTimerRef.current);
      }
      copyResetTimerRef.current = window.setTimeout(() => {
        setCopied(false);
        copyResetTimerRef.current = null;
      }, 1200);
    } catch {
      emitAction('copy-coordinates');
    }
  }, [emitAction, menuState]);

  useEffect(() => () => {
    if (copyResetTimerRef.current != null) {
      window.clearTimeout(copyResetTimerRef.current);
    }
  }, []);

  const elevationLabel = useMemo(() => {
    if (!menuState) return null;
    if (menuState.point.elevationMeters == null) return '...';
    return `${Math.round(menuState.point.elevationMeters)}m`;
  }, [menuState]);

  if (!menuState) return null;

  return (
    <div
      ref={menuRef}
      role="menu"
      aria-label={t('Menu contextuel de la carte')}
      onMouseDown={(event) => event.stopPropagation()}
      onContextMenu={(event) => event.preventDefault()}
      style={{
        position: 'absolute',
        top: menuState.top,
        left: menuState.left,
        zIndex: 34,
        width: 182,
        display: 'flex',
        flexDirection: 'column',
        gap: 4,
        padding: 6,
        overflow: 'hidden',
        border: '1px solid rgba(255,255,255,0.08)',
        borderTopLeftRadius: 8,
        borderTopRightRadius: 8,
        borderBottomRightRadius: 8,
        borderBottomLeftRadius: 0,
        boxShadow: '0 12px 36px rgba(0,0,0,0.38)',
        color: '#ffffff',
        fontFamily: 'Rethink Sans, system-ui, -apple-system, Segoe UI, sans-serif',
      }}
    >
      <MapCanvasGlassBackdrop blur={60} saturate={1.6} tint="rgba(15, 15, 15, 0.74)" />

      <div style={{ position: 'relative', display: 'flex', flexDirection: 'column', padding: '4px 0', gap: 6 }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 8, minHeight: 24 }}>
          <span
            style={{
              minWidth: 0,
              flex: '1 1 0',
              overflow: 'hidden',
              textOverflow: 'ellipsis',
              whiteSpace: 'nowrap',
              fontSize: 12,
              fontWeight: 500,
              lineHeight: 'normal',
              color: 'rgba(255,255,255,0.64)',
            }}
          >
            {menuState.point.coordinatesLabel}
          </span>

          <button
            type="button"
            onClick={() => {
              void handleCopyCoordinates();
            }}
            aria-label={t('Copier les coordonnées')}
            title={t('Copier les coordonnées')}
            style={{
              position: 'relative',
              zIndex: 1,
              display: 'inline-flex',
              alignItems: 'center',
              justifyContent: 'center',
              width: 24,
              height: 24,
              padding: 0,
              border: 'none',
              background: 'transparent',
              cursor: 'pointer',
            }}
          >
            <CopyButtonIcon copied={copied} />
          </button>
        </div>

        <div style={{ display: 'flex', alignItems: 'center', gap: 6, minHeight: 20 }}>
          <ElevationGlyph />
          <span
            style={{
              fontSize: 13,
              fontWeight: 500,
              lineHeight: 'normal',
            }}
          >
            {elevationLabel}
          </span>
        </div>
      </div>

      <div
        aria-hidden
        style={{
          position: 'relative',
          width: '100%',
          height: 1,
          background: 'rgba(255,255,255,0.12)',
        }}
      />

      <div style={{ position: 'relative', display: 'flex', flexDirection: 'column', gap: 0 }}>
        <MenuActionRow
          label={t('Créer un POI')}
          icon={<PoiPinGlyph />}
          onClick={() => {
            emitAction('create-poi');
            closeMenu();
          }}
        />
        <MenuActionRow
          label={t('Démarrer ici')}
          icon={<StartGlyph />}
          onClick={() => {
            emitAction('set-start');
            closeMenu();
          }}
        />
        <MenuActionRow
          label={t('Ajouter une étape')}
          icon={<WaypointGlyph />}
          onClick={() => {
            emitAction('add-waypoint');
            closeMenu();
          }}
        />
        <MenuActionRow
          label={t('Finir ici')}
          icon={<FinishGlyph />}
          onClick={() => {
            emitAction('set-finish');
            closeMenu();
          }}
        />
      </div>
    </div>
  );
}