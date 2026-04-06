import { useRef, useState } from 'react';
import { MapView } from '@/features/map3d';
import { LidarPanel } from '@/features/lidar';
import { LidarProvider } from '@/features/lidar/components/LidarContext';
import type { Map as MapboxMap } from 'mapbox-gl';

interface DashboardProps {
  email: string;
  onLogout: () => void;
}

export default function Dashboard({ onLogout }: DashboardProps) {
  const mapRef = useRef<MapboxMap | null>(null);
  const [lidarModeEnabled, setLidarModeEnabled] = useState(false);
  const [lidarDetailsOpen, setLidarDetailsOpen] = useState(false);

  const handleMapReady = (map: MapboxMap) => {
    mapRef.current = map;
  };

  const handleFlyTo = (lon: number, lat: number) => {
    mapRef.current?.flyTo({
      center: [lon, lat],
      zoom: Math.max(mapRef.current.getZoom(), 13),
      essential: true,
    });
  };

  return (
    <LidarProvider>
    <div style={{ position: 'relative', width: '100vw', height: '100dvh' }}>
      <MapView onMapReady={handleMapReady} lidarSelectionEnabled={lidarModeEnabled} />

      <div style={lidarDockStyle}>
        <LidarPanel
          modeActive={lidarModeEnabled}
          detailsOpen={lidarDetailsOpen}
          onToggleMode={() => setLidarModeEnabled((current) => !current)}
          onToggleDetails={() => setLidarDetailsOpen((current) => !current)}
          onFlyTo={handleFlyTo}
        />
      </div>

      <button
        onClick={onLogout}
        style={{
          position: 'absolute',
          top: 12,
          right: 12,
          zIndex: 20,
          background: 'rgba(17,17,17,0.7)',
          color: 'rgba(255,255,255,0.8)',
          border: '1px solid rgba(255,255,255,0.15)',
          borderRadius: 6,
          padding: '6px 14px',
          fontSize: 12,
          cursor: 'pointer',
          backdropFilter: 'blur(8px)',
        }}
      >
        Logout
      </button>
    </div>
    </LidarProvider>
  );
}

const lidarDockStyle: React.CSSProperties = {
  position: 'absolute',
  top: 12,
  left: 12,
  zIndex: 20,
};
