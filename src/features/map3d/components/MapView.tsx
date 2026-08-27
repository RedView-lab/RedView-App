import 'mapbox-gl/dist/mapbox-gl.css';
import '@mapbox/mapbox-gl-draw/dist/mapbox-gl-draw.css';
import { useRef, useEffect, useState, useCallback, memo } from 'react';
import type { Map as MapboxMap } from 'mapbox-gl';
import { useMap } from '../hooks/useMap';
import { useMapPoiExternalLink } from '../hooks/useMapPoiExternalLink';
import { useLidarSelection } from '@/features/lidar/components/useLidarSelection';
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
import { resolvePanelPlacement } from './panelPlacement';

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
  useMapPoiExternalLink(isLoaded ? map.current : null);

  useEffect(() => {
    if (isLoaded && map.current && onMapReady) {
      onMapReady(map.current);
    }
  }, [isLoaded, map, onMapReady]);

  const handleMapContextMenuAction = useCallback((payload: MapContextMenuActionPayload) => {
    onMapContextMenuAction?.(payload);
    dispatchItineraryMapAction({ kind: 'context-menu', payload });
    if (payload.action !== 'create-poi') return;
    const containerRect = containerRef.current?.getBoundingClientRect();
    const anchorX = containerRect ? payload.screenPoint.x - containerRect.left : payload.screenPoint.x;
    const anchorY = containerRect ? payload.screenPoint.y - containerRect.top : payload.screenPoint.y;
    const placement = resolvePanelPlacement(
      anchorX,
      anchorY,
      containerRect?.width ?? window.innerWidth,
      containerRect?.height ?? window.innerHeight,
    );
    setPoiDraft(createPoiDraft(payload, map.current, placement));
  }, [map, onMapContextMenuAction]);

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
  }) => React.ReactNode;

  return (
    // width/height: 100% (not 100vw/100dvh) so the map fills its parent
    // container. The Dashboard wraps everything in a scaled box whose
    // logical size is `viewport / appScale`, so vw/dvh would only cover
    // a fraction of the wrapper and leave empty space on small screens.
    <div style={{ position: 'relative', width: '100%', height: '100%', zIndex: 0, isolation: 'isolate' }}>
      <div
        ref={containerRef}
        style={{ position: 'absolute', top: 0, left: 0, right: 0, bottom: 0 }}
      />

      <ContextMenuComponent
        map={isLoaded ? map.current : null}
        containerRef={containerRef}
        onAction={handleMapContextMenuAction}
        overlayContext={contextMenuOverlayContext}
      />

      {poiDraft ? (
        <MapPoiDraftCard
          draft={poiDraft}
          map={isLoaded ? map.current : null}
          containerRef={containerRef}
          onDraftChange={setPoiDraft}
          onAction={handlePoiDraftAction}
        />
      ) : null}

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
          <span style={{ color: 'rgba(255,255,255,0.6)', fontSize: 14 }}>
            Chargement du globe...
          </span>
        </div>
      )}
    </div>
  );
});
