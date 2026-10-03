import 'mapbox-gl/dist/mapbox-gl.css';
import '@mapbox/mapbox-gl-draw/dist/mapbox-gl-draw.css';
import { useRef, useEffect, useState, useCallback, memo } from 'react';
import type { Map as MapboxMap } from 'mapbox-gl';
import { useMap } from '../hooks/useMap';
import { useMapPoiHoverCursor } from '../hooks/useMapPoiHoverCursor';
import { useCinematicIdleRotate } from '../hooks/useCinematicIdleRotate';
import { useLidarSelection } from '@/features/lidar/components/useLidarSelection';
import { useFreeCam } from '@/features/freeCam';
import { MapContextMenu } from './MapContextMenu/MapContextMenu';
import type {
  MapContextMenuActionPayload,
  MapContextMenuOverlayContext,
} from './MapContextMenu/types';
import { MapPoiDraftCard, type MapPoiDraft, type MapPoiDraftActionPayload } from './MapPoiDraftCard';
import type { MapViewport } from '../lib/viewport-persist';
import type { OverlayReloadRegistrar, OverlayStatusReporter } from '../lib/overlayStatus';
import type { BasemapRenderConfig } from '@/features/controlPanel/lib';
import { dispatchItineraryMapAction } from '@/features/itineraryPanel/lib/mapActionBridge';
import { resolvePanelArea, resolvePanelPlacement, type MapOverlayInsets } from './panelPlacement';
import { setMapOverlayInsets } from '../lib/mapOverlayInsets';

function sampleSlopePct(map: MapboxMap, lng: number, lat: number): number | null {
  const elevation = map.queryTerrainElevation?.([lng, lat]);
  if (!Number.isFinite(elevation)) return null;
  const baseElevation = Number(elevation);

  const sampleDistanceM = 8;
  const delta = sampleDistanceM / 111_320;
  const elevN = map.queryTerrainElevation?.([lng, lat + delta]) ?? baseElevation;
  const elevS = map.queryTerrainElevation?.([lng, lat - delta]) ?? baseElevation;
  const elevE = map.queryTerrainElevation?.([lng + delta, lat]) ?? baseElevation;
  const elevW = map.queryTerrainElevation?.([lng - delta, lat]) ?? baseElevation;
  const slopeX = Math.abs(elevE - elevW) / (2 * sampleDistanceM);
  const slopeY = Math.abs(elevN - elevS) / (2 * sampleDistanceM);
  return Math.round(Math.hypot(slopeX, slopeY) * 100);
}

function createPoiDraft(
  payload: MapContextMenuActionPayload,
  map: MapboxMap | null,
  placement: ReturnType<typeof resolvePanelPlacement>,
): MapPoiDraft {
  return {
    id: `map-poi-draft-${Date.now()}`,
    point: payload.point,
    screenPoint: payload.screenPoint,
    name: payload.point.title,
    favorite: false,
    category: null,
    slopePct: map ? sampleSlopePct(map, payload.point.lng, payload.point.lat) : null,
    surfaceLabel: payload.point.surfaceLabel,
    roadTypeLabel: payload.point.categoryLabel,
    placement,
  };
}

interface MapViewProps {
  onMapReady?: (map: MapboxMap) => void;
  onMapLoadStatusChange?: OverlayStatusReporter;
  onMapReloadChange?: OverlayReloadRegistrar;
  basemapConfig?: BasemapRenderConfig;
  lidarSelectionEnabled?: boolean;
  onLidarSelectionDisable?: () => void;
  initialViewport?: MapViewport | null;
  onViewportChange?: (viewport: MapViewport) => void;
  onMapContextMenuAction?: (payload: MapContextMenuActionPayload) => void;
  onMapPoiDraftAction?: (payload: MapPoiDraftActionPayload) => void;
  contextMenuOverlayContext?: MapContextMenuOverlayContext;
  /** Bords de la carte couverts par les panneaux du dashboard. */
  overlayInsets?: MapOverlayInsets | null;
}

export default memo(function MapView({
  onMapReady,
  onMapLoadStatusChange,
  onMapReloadChange,
  basemapConfig,
  lidarSelectionEnabled = false,
  onLidarSelectionDisable,
  initialViewport,
  onViewportChange,
  onMapContextMenuAction,
  onMapPoiDraftAction,
  contextMenuOverlayContext,
  overlayInsets,
}: MapViewProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const [poiDraft, setPoiDraft] = useState<MapPoiDraft | null>(null);
  const { map, isLoaded } = useMap(containerRef, {
    initialViewport,
    onViewportChange,
    onLoadStatusChange: onMapLoadStatusChange,
    registerReload: onMapReloadChange,
    basemapConfig,
  });

  useLidarSelection(isLoaded ? map.current : null, lidarSelectionEnabled, onLidarSelectionDisable);
  useMapPoiHoverCursor(isLoaded ? map.current : null);
  useCinematicIdleRotate(isLoaded ? map.current : null, isLoaded);
  useFreeCam(isLoaded ? map.current : null);

  useEffect(() => {
    if (isLoaded && map.current && onMapReady) {
      onMapReady(map.current);
    }
  }, [isLoaded, map, onMapReady]);

  // Publié pour les popups Mapbox (`keepPopupInVisibleMap`), hors de l'arbre React.
  useEffect(() => {
    if (isLoaded && map.current) setMapOverlayInsets(map.current, overlayInsets);
  }, [isLoaded, map, overlayInsets]);

  const handleMapContextMenuAction = useCallback((payload: MapContextMenuActionPayload) => {
    onMapContextMenuAction?.(payload);
    dispatchItineraryMapAction({ kind: 'context-menu', payload });
    if (payload.action !== 'create-poi') return;
    // `screenPoint` is the click's `event.point` (map-container layout px), the
    // space of the insets and of the card's left/top: no client rect involved.
    const container = containerRef.current;
    const area = resolvePanelArea(
      container?.clientWidth || window.innerWidth,
      container?.clientHeight || window.innerHeight,
      0,
      0,
      0,
      overlayInsets,
    );
    const placement = resolvePanelPlacement(
      payload.screenPoint.x - area.left,
      payload.screenPoint.y - area.top,
      area.width,
      area.height,
    );
    setPoiDraft(createPoiDraft(payload, map.current, placement));
  }, [map, onMapContextMenuAction, overlayInsets]);

  const handlePoiDraftAction = useCallback((payload: MapPoiDraftActionPayload) => {
    onMapPoiDraftAction?.(payload);
    dispatchItineraryMapAction({ kind: 'poi-draft', payload });
    if (
      payload.action === 'delete'
      || payload.action === 'close'
      || payload.action === 'start-here'
      || payload.action === 'add-waypoint'
      || payload.action === 'finish-here'
    ) {
      setPoiDraft(null);
    }
  }, [onMapPoiDraftAction]);

  const ContextMenuComponent = MapContextMenu as (props: {
    map: MapboxMap | null;
    containerRef: typeof containerRef;
    onAction?: (payload: MapContextMenuActionPayload) => void;
    overlayContext?: MapContextMenuOverlayContext;
    overlayInsets?: MapOverlayInsets | null;
  }) => React.ReactNode;

  return (
    // width/height: 100% (not 100vw/100dvh) so the map fills its parent
    // container. The Dashboard wraps everything in a scaled box whose
    // logical size is `viewport / appScale`, so vw/dvh would only cover
    // a fraction of the wrapper and leave empty space on small screens.
    <>
      <div style={{ position: 'relative', width: '100%', height: '100%', zIndex: 0, isolation: 'isolate' }}>
        <div
          ref={containerRef}
          style={{ position: 'absolute', top: 0, left: 0, right: 0, bottom: 0 }}
        />

        {!isLoaded && (
          <div
            style={{
              position: 'absolute',
              inset: 0,
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
              background: 'rgba(17, 17, 17, 0.85)',
              zIndex: 10,
            }}
          >
            <span style={{ color: 'rgba(255,255,255,0.6)', fontSize: 'var(--rv-font-size-lg)' }}>
              Chargement du globe...
            </span>
          </div>
        )}
      </div>

      {/* Menu contextuel et fiche POI : calque frère de la carte, au-dessus des
          panneaux du dashboard (z 25). Dans la carte isolée (z 0), ils
          passeraient dessous. Même origine que la carte : positions inchangées. */}
      <div style={{ position: 'absolute', inset: 0, zIndex: 40, pointerEvents: 'none' }}>
        <ContextMenuComponent
          map={isLoaded ? map.current : null}
          containerRef={containerRef}
          onAction={handleMapContextMenuAction}
          overlayContext={contextMenuOverlayContext}
          overlayInsets={overlayInsets}
        />

        {poiDraft ? (
          <MapPoiDraftCard
            draft={poiDraft}
            map={isLoaded ? map.current : null}
            containerRef={containerRef}
            overlayInsets={overlayInsets}
            onDraftChange={setPoiDraft}
            onAction={handlePoiDraftAction}
          />
        ) : null}
      </div>
    </>
  );
});
