import 'mapbox-gl/dist/mapbox-gl.css';
import { useRef, useEffect } from 'react';
import type { Map as MapboxMap } from 'mapbox-gl';
import { useMap } from '../hooks/useMap';
import { useLidarContextMenu } from '@/features/lidar/components/useLidarContextMenu';

interface MapViewProps {
  onMapReady?: (map: MapboxMap) => void;
}

export default function MapView({ onMapReady }: MapViewProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const { map, isLoaded } = useMap(containerRef);

  // LiDAR: right-click context menu on map
  useLidarContextMenu(isLoaded ? map.current : null);

  useEffect(() => {
    if (isLoaded && map.current && onMapReady) {
      onMapReady(map.current);
    }
  }, [isLoaded, map, onMapReady]);

  return (
    <div style={{ position: 'relative', width: '100vw', height: '100dvh' }}>
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
