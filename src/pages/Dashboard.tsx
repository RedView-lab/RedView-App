import { useRef, useState } from 'react';
import { MapView } from '@/features/map3d';
import { LidarPanel } from '@/features/lidar';
import { FitPredictionPanel } from '@/features/fitPredictor';
import { MapToolsPanel } from '@/features/weather';
import { PoiPanel } from '@/features/poi';
import { LidarProvider } from '@/features/lidar/components/LidarContext';
import type { Map as MapboxMap } from 'mapbox-gl';

interface DashboardProps {
  email: string;
  onLogout: () => void;
}

export default function Dashboard({ onLogout }: DashboardProps) {
  const mapRef = useRef<MapboxMap | null>(null);
  const [mapLoaded, setMapLoaded] = useState(false);
  const [lidarModeEnabled, setLidarModeEnabled] = useState(false);
  const [lidarDetailsOpen, setLidarDetailsOpen] = useState(false);
  const [fitPanelOpen, setFitPanelOpen] = useState(false);

  const handleMapReady = (map: MapboxMap) => {
    mapRef.current = map;
    setMapLoaded(true);
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

      <div style={leftDockStackStyle}>
        <LidarPanel
          modeActive={lidarModeEnabled}
          detailsOpen={lidarDetailsOpen}
          onToggleMode={() => setLidarModeEnabled((current) => !current)}
          onToggleDetails={() => setLidarDetailsOpen((current) => !current)}
          onFlyTo={handleFlyTo}
        />
        <FitPredictionPanel
          open={fitPanelOpen}
          onToggleOpen={() => setFitPanelOpen((current) => !current)}
        />
        <PoiPanel map={mapRef.current} isMapLoaded={mapLoaded} />
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

      <div style={rightDockStyle}>
        <MapToolsPanel map={mapRef.current} isMapLoaded={mapLoaded} />
      </div>
    </div>
    </LidarProvider>
  );
}

const leftDockStackStyle: React.CSSProperties = {
  position: 'absolute',
  top: 12,
  left: 12,
  zIndex: 20,
  display: 'flex',
  flexDirection: 'column',
  gap: 10,
};

const rightDockStyle: React.CSSProperties = {
  position: 'absolute',
  top: 50,
  right: 12,
  zIndex: 20,
};
