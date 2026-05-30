import 'mapbox-gl/dist/mapbox-gl.css';
import '@mapbox/mapbox-gl-draw/dist/mapbox-gl-draw.css';
import { useRef, useEffect, useState, useCallback, memo } from 'react';
import type { Map as MapboxMap } from 'mapbox-gl';
import { useMap } from '../hooks/useMap';
import { useLidarSelection } from '@/features/lidar/components/useLidarSelection';
import { MapContextMenu, type MapContextMenuActionPayload } from './MapContextMenu';
import { MapPoiDraftCard, type MapPoiDraft, type MapPoiDraftActionPayload } from './MapPoiDraftCard';
import type { MapViewport } from '../lib/viewport-persist';
import type { OverlayReloadRegistrar, OverlayStatusReporter } from '../lib/overlayStatus';
import type { BasemapRenderConfig } from '@/features/controlPanel/lib';

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
): MapPoiDraft {
  return {
    id: `map-poi-draft-${Date.now()}`,
    point: payload.point,
    screenPoint: payload.screenPoint,
    name: null,
    favorite: false,
    category: null,
    slopePct: map ? sampleSlopePct(map, payload.point.lng, payload.point.lat) : null,
    surfaceLabel: null,
    roadTypeLabel: null,
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

  useEffect(() => {
    if (isLoaded && map.current && onMapReady) {
      onMapReady(map.current);
    }
  }, [isLoaded, map, onMapReady]);

  const handleMapContextMenuAction = useCallback((payload: MapContextMenuActionPayload) => {
    onMapContextMenuAction?.(payload);
    if (payload.action !== 'create-poi') return;
    setPoiDraft(createPoiDraft(payload, map.current));
  }, [map, onMapContextMenuAction]);

  const handlePoiDraftAction = useCallback((payload: MapPoiDraftActionPayload) => {
    onMapPoiDraftAction?.(payload);
    if (payload.action === 'delete' || payload.action === 'close') {
      setPoiDraft(null);
    }
  }, [onMapPoiDraftAction]);

  useEffect(() => {
    const currentMap = isLoaded ? map.current : null;
    if (!currentMap || !poiDraft) return;

    const closeDraft = () => setPoiDraft(null);
    currentMap.on('movestart', closeDraft);
    currentMap.on('dragstart', closeDraft);
    currentMap.on('pitchstart', closeDraft);
    currentMap.on('rotatestart', closeDraft);

    return () => {
      currentMap.off('movestart', closeDraft);
      currentMap.off('dragstart', closeDraft);
      currentMap.off('pitchstart', closeDraft);
      currentMap.off('rotatestart', closeDraft);
    };
  }, [isLoaded, map, poiDraft]);

  return (
    // width/height: 100% (not 100vw/100dvh) so the map fills its parent
    // container. The Dashboard wraps everything in a scaled box whose
    // logical size is `viewport / appScale`, so vw/dvh would only cover
    // a fraction of the wrapper and leave empty space on small screens.
    <div style={{ position: 'relative', width: '100%', height: '100%' }}>
      <div
        ref={containerRef}
        style={{ position: 'absolute', top: 0, left: 0, right: 0, bottom: 0 }}
      />

      <MapContextMenu
        map={isLoaded ? map.current : null}
        containerRef={containerRef}
        onAction={handleMapContextMenuAction}
      />

      {poiDraft ? (
        <MapPoiDraftCard
          draft={poiDraft}
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
