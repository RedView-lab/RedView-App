import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type RefObject } from 'react';
import type { Map as MapboxMap, MapMouseEvent } from 'mapbox-gl';

import { MapCanvasGlassBackdrop } from '@/shared/components/MapCanvasGlassBackdrop';
import { useAppI18n } from '@/shared/i18n';
import { useProjectStoreOptional } from '@/features/itineraryPanel';

import { computePanelPosition, resolvePanelPlacement, type PanelPlacement } from '../panelPlacement';
import { sampleSlopePct, resolvePointContext } from './contextMenuHelpers';
import { fetchOverlayDetails } from './overlayForecast';
import { MapContextMenuHeader } from './MapContextMenuHeader';
import { MapContextMenuMetadata } from './MapContextMenuMetadata';
import { MapContextMenuActions } from './MapContextMenuActions';
import type {
  MapContextMenuActionId,
  MapContextMenuActionPayload,
  MapContextMenuOverlayContext,
  MapContextMenuPoint,
} from './types';
import { copyTextToClipboard, formatCoordinates } from './utils';

const MENU_EDGE_PADDING = 8;
const RIGHT_CLICK_MOVE_TOLERANCE_PX = 6;
const RIGHT_CLICK_MAX_HOLD_MS = 320;
const MENU_WIDTH = 224;

interface MapContextMenuProps {
  map: MapboxMap | null;
  containerRef: RefObject<HTMLDivElement | null>;
  onAction?: (payload: MapContextMenuActionPayload) => void;
  overlayContext?: MapContextMenuOverlayContext;
}

interface MenuState {
  screenX: number;
  screenY: number;
  placement: PanelPlacement;
  point: MapContextMenuPoint;
}

interface PendingRightClickState {
  startedAtMs: number;
  startX: number;
  startY: number;
  moved: boolean;
  rotated: boolean;
}

/**
 * Menu contextuel interactif sur la carte 3D (clic droit ou appui long).
 * Affiche les coordonnées, altitude, pente, météo locale et propose des actions
 * (Créer un POI, Démarrer ici, Ajouter une étape, Finir ici).
 */
export function MapContextMenu({ map, containerRef, onAction, overlayContext }: MapContextMenuProps) {
  const { t } = useAppI18n();
  const projectStore = useProjectStoreOptional();
  const project = projectStore?.project;

  const hasStartPoint = useMemo(() => {
    if (!project || project.itineraries.length === 0) return false;
    const activeItinerary =
      project.itineraries.find((it) => it.id === project.activeItineraryId) ??
      project.itineraries[0];
    if (!activeItinerary) return false;
    if (activeItinerary.gpxRoute && activeItinerary.gpxRoute.points.length > 0) return true;
    const start = activeItinerary.timeline.find((row) => row.kind === 'start');
    return Boolean(start && start.lat != null && start.lon != null);
  }, [project]);

  const menuRef = useRef<HTMLDivElement | null>(null);
  const copyResetTimerRef = useRef<number | null>(null);
  const overlayAbortRef = useRef<AbortController | null>(null);
  const pendingRightClickRef = useRef<PendingRightClickState | null>(null);
  const pendingCleanupTimerRef = useRef<number | null>(null);
  const lastMapTransformTimeRef = useRef<number>(0);
  const [menuState, setMenuState] = useState<MenuState | null>(null);
  const [copied, setCopied] = useState(false);
  const [menuPosition, setMenuPosition] = useState({ left: MENU_EDGE_PADDING, top: MENU_EDGE_PADDING });

  const closeMenu = useCallback(() => {
    setMenuState(null);
    setCopied(false);
    if (copyResetTimerRef.current != null) {
      window.clearTimeout(copyResetTimerRef.current);
      copyResetTimerRef.current = null;
    }
    overlayAbortRef.current?.abort();
    overlayAbortRef.current = null;
  }, []);

  useEffect(() => {
    if (!map) return;

    const canvas = map.getCanvas();

    const handleMouseDown = (event: MouseEvent) => {
      if (event.button !== 2) return;
      if (pendingCleanupTimerRef.current != null) {
        window.clearTimeout(pendingCleanupTimerRef.current);
        pendingCleanupTimerRef.current = null;
      }
      pendingRightClickRef.current = {
        startedAtMs: performance.now(),
        startX: event.clientX,
        startY: event.clientY,
        moved: false,
        rotated: false,
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

      const deltaX = event.clientX - pending.startX;
      const deltaY = event.clientY - pending.startY;
      if (Math.hypot(deltaX, deltaY) > RIGHT_CLICK_MOVE_TOLERANCE_PX) {
        pending.moved = true;
      }

      // Keep pending state briefly for contextmenu event, then clean up if no contextmenu event fires
      if (pendingCleanupTimerRef.current != null) {
        window.clearTimeout(pendingCleanupTimerRef.current);
      }
      pendingCleanupTimerRef.current = window.setTimeout(() => {
        pendingRightClickRef.current = null;
        pendingCleanupTimerRef.current = null;
      }, 400);
    };

    const handleMapTransform = () => {
      lastMapTransformTimeRef.current = performance.now();
      if (pendingRightClickRef.current) {
        pendingRightClickRef.current.rotated = true;
      }
    };

    const handleContextMenu = (event: MapMouseEvent) => {
      event.preventDefault();

      if (pendingCleanupTimerRef.current != null) {
        window.clearTimeout(pendingCleanupTimerRef.current);
        pendingCleanupTimerRef.current = null;
      }

      const pending = pendingRightClickRef.current;
      pendingRightClickRef.current = null;

      // If no valid right-click was tracked, ignore
      if (!pending) return;

      const holdDurationMs = performance.now() - pending.startedAtMs;
      const wasDragged = pending.moved;
      const wasRotated = pending.rotated;
      const wasLongHold = holdDurationMs > RIGHT_CLICK_MAX_HOLD_MS;
      const wasRecentTransform = performance.now() - lastMapTransformTimeRef.current < 250;
      const isMapTransforming = (map.isRotating?.() ?? false) || (map.isMoving?.() ?? false);

      if (wasDragged || wasRotated || wasLongHold || wasRecentTransform || isMapTransforming) {
        return;
      }

      if (event.originalEvent) {
        const deltaX = event.originalEvent.clientX - pending.startX;
        const deltaY = event.originalEvent.clientY - pending.startY;
        if (Math.hypot(deltaX, deltaY) > RIGHT_CLICK_MOVE_TOLERANCE_PX) {
          return;
        }
      }

      const lngLat = event.lngLat;
      if (!lngLat) return;

      const lat = lngLat.lat;
      const lng = lngLat.lng;
      const elevation = map.queryTerrainElevation?.([lng, lat]) ?? null;
      const slopePct = sampleSlopePct(map, lng, lat);
      const pointContext = resolvePointContext(map, event.point);

      let forbiddenZoneId: string | null = null;
      try {
        const candidateLayers = [
          'brouter-forbidden-zone-fill-layer',
          'brouter-forbidden-zone-line-layer',
        ].filter((layerId) => Boolean(map.getLayer(layerId)));
        if (candidateLayers.length > 0) {
          const fzFeatures = map.queryRenderedFeatures(event.point, { layers: candidateLayers });
          if (fzFeatures.length > 0) {
            forbiddenZoneId = (fzFeatures[0]?.properties?.id as string | undefined) ?? 'forbidden-zone';
          }
        }
        if (!forbiddenZoneId) {
          const allFeatures = map.queryRenderedFeatures(event.point);
          const fz = allFeatures.find(
            (f) =>
              f.layer?.id?.includes('forbidden-zone') &&
              !f.layer?.id?.includes('draft'),
          );
          if (fz) {
            forbiddenZoneId = (fz.properties?.id as string | undefined) ?? 'forbidden-zone';
          }
        }
      } catch {
        /* noop */
      }

      const nextPoint: MapContextMenuPoint = {
        lat,
        lng,
        elevationMeters: Number.isFinite(elevation) ? Number(elevation) : null,
        slopePct,
        coordinatesLabel: formatCoordinates(lat, lng),
        title: pointContext.title,
        categoryLabel: pointContext.categoryLabel,
        surfaceLabel: pointContext.surfaceLabel,
        openingHoursLabel: pointContext.openingHoursLabel,
        overlayDetails: [],
        forbiddenZoneId,
      };

      const container = containerRef.current;
      const containerBounds = container?.getBoundingClientRect() ?? {
        left: 0,
        top: 0,
        right: window.innerWidth,
        bottom: window.innerHeight,
        width: window.innerWidth,
        height: window.innerHeight,
      };

      const screenX = event.point.x;
      const screenY = event.point.y;
      const placement = resolvePanelPlacement(screenX, screenY, containerBounds.width, containerBounds.height);

      setCopied(false);
      setMenuState({
        screenX,
        screenY,
        placement,
        point: nextPoint,
      });
    };

    canvas.addEventListener('mousedown', handleMouseDown);
    window.addEventListener('mousemove', handleMouseMove);
    window.addEventListener('mouseup', handleMouseUp);
    map.on('rotatestart', handleMapTransform);
    map.on('rotate', handleMapTransform);
    map.on('pitchstart', handleMapTransform);
    map.on('pitch', handleMapTransform);
    map.on('dragstart', handleMapTransform);
    map.on('drag', handleMapTransform);
    map.on('movestart', handleMapTransform);
    map.on('move', handleMapTransform);
    map.on('contextmenu', handleContextMenu);

    return () => {
      canvas.removeEventListener('mousedown', handleMouseDown);
      window.removeEventListener('mousemove', handleMouseMove);
      window.removeEventListener('mouseup', handleMouseUp);
      map.off('rotatestart', handleMapTransform);
      map.off('rotate', handleMapTransform);
      map.off('pitchstart', handleMapTransform);
      map.off('pitch', handleMapTransform);
      map.off('dragstart', handleMapTransform);
      map.off('drag', handleMapTransform);
      map.off('movestart', handleMapTransform);
      map.off('move', handleMapTransform);
      map.off('contextmenu', handleContextMenu);
      if (pendingCleanupTimerRef.current != null) {
        window.clearTimeout(pendingCleanupTimerRef.current);
        pendingCleanupTimerRef.current = null;
      }
    };
  }, [containerRef, map]);

  useLayoutEffect(() => {
    if (!menuState) return;
    const menuEl = menuRef.current;
    const container = containerRef.current;
    if (!menuEl || !container) return;

    const pos = computePanelPosition(
      menuState.screenX,
      menuState.screenY,
      menuEl.offsetWidth || MENU_WIDTH,
      menuEl.offsetHeight || 280,
      container.clientWidth,
      container.clientHeight,
      MENU_EDGE_PADDING,
      menuState.placement,
    );

    setMenuPosition(pos);
  }, [containerRef, menuState]);

  const activePointLat = menuState?.point.lat;
  const activePointLng = menuState?.point.lng;

  useEffect(() => {
    if (activePointLat == null || activePointLng == null || !overlayContext) return;

    overlayAbortRef.current?.abort();
    const controller = new AbortController();
    overlayAbortRef.current = controller;

    fetchOverlayDetails(activePointLat, activePointLng, overlayContext, controller.signal)
      .then((overlayDetails) => {
        if (controller.signal.aborted) return;
        setMenuState((current) => {
          if (!current || current.point.lat !== activePointLat || current.point.lng !== activePointLng) {
            return current;
          }
          return {
            ...current,
            point: {
              ...current.point,
              overlayDetails,
            },
          };
        });
      })
      .catch(() => {
        if (controller.signal.aborted) return;
      });

    return () => {
      controller.abort();
      if (overlayAbortRef.current === controller) {
        overlayAbortRef.current = null;
      }
    };
  }, [activePointLat, activePointLng, overlayContext]);

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

    document.addEventListener('pointerdown', handlePointerDown);
    document.addEventListener('keydown', handleKeyDown);
    window.addEventListener('resize', handleWindowChange);
    window.addEventListener('blur', handleWindowChange);

    if (map) {
      map.on('movestart', closeMenu);
      map.on('rotatestart', closeMenu);
      map.on('pitchstart', closeMenu);
      map.on('zoomstart', closeMenu);
    }

    return () => {
      document.removeEventListener('pointerdown', handlePointerDown);
      document.removeEventListener('keydown', handleKeyDown);
      window.removeEventListener('resize', handleWindowChange);
      window.removeEventListener('blur', handleWindowChange);
      if (map) {
        map.off('movestart', closeMenu);
        map.off('rotatestart', closeMenu);
        map.off('pitchstart', closeMenu);
        map.off('zoomstart', closeMenu);
      }
    };
  }, [closeMenu, map, menuState]);

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

  const titleLabel = menuState?.point.title?.trim() || t('Point sélectionné');

  const handleOpenStreetView = useCallback(() => {
    if (!menuState) return;
    const { lat, lng } = menuState.point;
    const streetViewUrl = `https://www.google.com/maps/@?api=1&map_action=pano&viewpoint=${encodeURIComponent(`${lat},${lng}`)}`;
    window.open(streetViewUrl, '_blank', 'noopener,noreferrer');
  }, [menuState]);

  if (!menuState) return null;

  return (
    <div
      ref={menuRef}
      role="menu"
      aria-label={t('Menu contextuel de la carte')}
      style={{
        position: 'absolute',
        top: menuPosition.top,
        left: menuPosition.left,
        zIndex: 34,
        width: MENU_WIDTH,
        display: 'flex',
        flexDirection: 'column',
        gap: 4,
        padding: 6,
        overflow: 'hidden',
        borderTopLeftRadius: 8,
        borderTopRightRadius: 8,
        borderBottomRightRadius: 8,
        borderBottomLeftRadius: 0,
        boxShadow: '0 12px 36px rgba(0,0,0,0.38)',
        color: '#ffffff',
        fontFamily: 'Rethink Sans, system-ui, -apple-system, Segoe UI, sans-serif',
        pointerEvents: 'auto',
      }}
    >
      <MapCanvasGlassBackdrop blur={60} saturate={1.6} tint="rgba(15, 15, 15, 0.74)" />

      <MapContextMenuHeader
        titleLabel={titleLabel}
        onOpenStreetView={handleOpenStreetView}
      />

      <MapContextMenuMetadata
        point={menuState.point}
        copied={copied}
        onCopyCoordinates={() => {
          void handleCopyCoordinates();
        }}
      />

      <div
        aria-hidden
        style={{
          position: 'relative',
          width: '100%',
          height: 1,
          background: 'rgba(255,255,255,0.12)',
        }}
      />

      <MapContextMenuActions
        hasForbiddenZone={Boolean(menuState.point.forbiddenZoneId)}
        hasStartPoint={hasStartPoint}
        onAction={(actionId) => {
          emitAction(actionId);
          closeMenu();
        }}
      />
    </div>
  );
}