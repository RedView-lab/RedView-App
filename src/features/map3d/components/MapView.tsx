import 'mapbox-gl/dist/mapbox-gl.css';
import '@mapbox/mapbox-gl-draw/dist/mapbox-gl-draw.css';
import { useRef, useEffect } from 'react';
import type { Map as MapboxMap } from 'mapbox-gl';
import { useMap } from '../hooks/useMap';
import { useLidarSelection } from '@/features/lidar/components/useLidarSelection';
import type { MapViewport } from '../lib/viewport-persist';
import type { OverlayReloadRegistrar, OverlayStatusReporter } from '../lib/overlayStatus';
import type { BasemapRenderConfig } from '@/features/controlPanel/lib';

interface MapViewProps {
  onMapReady?: (map: MapboxMap) => void;
  onMapLoadStatusChange?: OverlayStatusReporter;
  onMapReloadChange?: OverlayReloadRegistrar;
  basemapConfig?: BasemapRenderConfig;
  lidarSelectionEnabled?: boolean;
  onLidarSelectionDisable?: () => void;
  initialViewport?: MapViewport | null;
  onViewportChange?: (viewport: MapViewport) => void;
}

export default function MapView({
  onMapReady,
  onMapLoadStatusChange,
  onMapReloadChange,
  basemapConfig,
  lidarSelectionEnabled = false,
  onLidarSelectionDisable,
  initialViewport,
  onViewportChange,
}: MapViewProps) {
  const containerRef = useRef<HTMLDivElement>(null);
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
}
