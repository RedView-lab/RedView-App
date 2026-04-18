import 'mapbox-gl/dist/mapbox-gl.css';
import { useRef, useEffect } from 'react';
import type { Map as MapboxMap } from 'mapbox-gl';
import { useMap } from '../hooks/useMap';
import { useLidarSelection } from '@/features/lidar/components/useLidarSelection';

interface MapViewProps {
  onMapReady?: (map: MapboxMap) => void;
  lidarSelectionEnabled?: boolean;
  onLidarSelectionDisable?: () => void;
}

export default function MapView({ onMapReady, lidarSelectionEnabled = false, onLidarSelectionDisable }: MapViewProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const { map, isLoaded } = useMap(containerRef);

  useLidarSelection(isLoaded ? map.current : null, lidarSelectionEnabled, onLidarSelectionDisable);

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
