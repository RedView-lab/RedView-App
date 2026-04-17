import { useEffect, useRef, useState } from 'react';
import { MapView } from '@/features/map3d';
import { LidarPanel } from '@/features/lidar';
import { FitPredictionPanel } from '@/features/fitPredictor';
import { ControlPanelContainer } from '@/features/controlPanel';
import { ItineraryPanel } from '@/features/itineraryPanel';
import { LidarProvider } from '@/features/lidar/components/LidarContext';
import type { Map as MapboxMap } from 'mapbox-gl';

interface DashboardProps {
  email: string;
  onLogout: () => void;
}

const PANEL_WIDTH_KEY = 'rvc-panel-width';
const PANEL_WIDTH_MIN = 260;
const PANEL_WIDTH_MAX = 560;
const PANEL_WIDTH_DEFAULT = 300;
const PANEL_PADDING = 12;

const LEFT_PANEL_WIDTH_KEY = 'rvi-panel-width';
const LEFT_PANEL_WIDTH_MIN = 300;
const LEFT_PANEL_WIDTH_MAX = 520;
const LEFT_PANEL_WIDTH_DEFAULT = 360;

function readStoredLeftWidth(): number {
  try {
    const raw = localStorage.getItem(LEFT_PANEL_WIDTH_KEY);
    if (!raw) return LEFT_PANEL_WIDTH_DEFAULT;
    const n = parseInt(raw, 10);
    if (!Number.isFinite(n)) return LEFT_PANEL_WIDTH_DEFAULT;
    return Math.min(LEFT_PANEL_WIDTH_MAX, Math.max(LEFT_PANEL_WIDTH_MIN, n));
  } catch {
    return LEFT_PANEL_WIDTH_DEFAULT;
  }
}

function readStoredWidth(): number {
  try {
    const raw = localStorage.getItem(PANEL_WIDTH_KEY);
    if (!raw) return PANEL_WIDTH_DEFAULT;
    const n = parseInt(raw, 10);
    if (!Number.isFinite(n)) return PANEL_WIDTH_DEFAULT;
    return Math.min(PANEL_WIDTH_MAX, Math.max(PANEL_WIDTH_MIN, n));
  } catch {
    return PANEL_WIDTH_DEFAULT;
  }
}

export default function Dashboard({ onLogout }: DashboardProps) {
  const mapRef = useRef<MapboxMap | null>(null);
  const [mapLoaded, setMapLoaded] = useState(false);
  const [lidarModeEnabled, setLidarModeEnabled] = useState(false);
  const [lidarDetailsOpen, setLidarDetailsOpen] = useState(false);
  const [fitPanelOpen, setFitPanelOpen] = useState(false);
  const [panelWidth, setPanelWidth] = useState<number>(() => readStoredWidth());
  const [isResizing, setIsResizing] = useState(false);
  const [leftPanelOpen, setLeftPanelOpen] = useState(true);
  const [leftPanelWidth, setLeftPanelWidth] = useState<number>(() =>
    readStoredLeftWidth(),
  );
  const [isLeftResizing, setIsLeftResizing] = useState(false);

  useEffect(() => {
    try { localStorage.setItem(PANEL_WIDTH_KEY, String(panelWidth)); } catch { /* ignore */ }
  }, [panelWidth]);

  useEffect(() => {
    try {
      localStorage.setItem(LEFT_PANEL_WIDTH_KEY, String(leftPanelWidth));
    } catch {
      /* ignore */
    }
  }, [leftPanelWidth]);

  const handleResizeStart = (ev: React.MouseEvent<HTMLDivElement>) => {
    ev.preventDefault();
    setIsResizing(true);
    const onMove = (e: MouseEvent) => {
      const raw = window.innerWidth - e.clientX - PANEL_PADDING;
      const clamped = Math.min(PANEL_WIDTH_MAX, Math.max(PANEL_WIDTH_MIN, raw));
      setPanelWidth(clamped);
    };
    const onUp = () => {
      setIsResizing(false);
      document.removeEventListener('mousemove', onMove);
      document.removeEventListener('mouseup', onUp);
    };
    document.addEventListener('mousemove', onMove);
    document.addEventListener('mouseup', onUp);
  };

  const handleLeftResizeStart = (ev: React.MouseEvent<HTMLDivElement>) => {
    ev.preventDefault();
    setIsLeftResizing(true);
    const onMove = (e: MouseEvent) => {
      const raw = e.clientX - PANEL_PADDING;
      const clamped = Math.min(
        LEFT_PANEL_WIDTH_MAX,
        Math.max(LEFT_PANEL_WIDTH_MIN, raw),
      );
      setLeftPanelWidth(clamped);
    };
    const onUp = () => {
      setIsLeftResizing(false);
      document.removeEventListener('mousemove', onMove);
      document.removeEventListener('mouseup', onUp);
    };
    document.addEventListener('mousemove', onMove);
    document.addEventListener('mouseup', onUp);
  };

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

  const rightPanelStyle: React.CSSProperties = {
    position: 'absolute',
    top: 0,
    right: 0,
    bottom: 0,
    width: panelWidth + PANEL_PADDING * 2,
    zIndex: 25,
    padding: PANEL_PADDING,
    boxSizing: 'border-box',
    display: 'flex',
  };

  const leftPanelStyle: React.CSSProperties = {
    position: 'absolute',
    top: 0,
    left: 0,
    bottom: 0,
    width: leftPanelWidth + PANEL_PADDING * 2,
    zIndex: 25,
    padding: PANEL_PADDING,
    boxSizing: 'border-box',
    display: leftPanelOpen ? 'flex' : 'none',
  };

  const leftDockOffset =
    (leftPanelOpen ? leftPanelWidth + PANEL_PADDING * 2 : 0) + PANEL_PADDING;

  const logoutStyle: React.CSSProperties = {
    position: 'absolute',
    top: 12,
    right: panelWidth + PANEL_PADDING * 2 + 12,
    zIndex: 20,
    background: 'rgba(17,17,17,0.7)',
    color: 'rgba(255,255,255,0.8)',
    border: '1px solid rgba(255,255,255,0.15)',
    borderRadius: 6,
    padding: '6px 14px',
    fontSize: 12,
    cursor: 'pointer',
    backdropFilter: 'blur(8px)',
  };

  return (
    <LidarProvider>
    <div style={{ position: 'relative', width: '100vw', height: '100dvh' }}>
      <MapView onMapReady={handleMapReady} lidarSelectionEnabled={lidarModeEnabled} />

      <div style={leftPanelStyle}>
        <ItineraryPanel
          map={mapRef.current}
          isMapLoaded={mapLoaded}
          width={leftPanelWidth}
          onResizeStart={handleLeftResizeStart}
          isResizing={isLeftResizing}
          onClose={() => setLeftPanelOpen(false)}
        />
      </div>

      <div style={{ ...leftDockStackStyle, left: leftDockOffset }}>
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
      </div>

      <button onClick={onLogout} style={logoutStyle}>
        Logout
      </button>

      <div style={rightPanelStyle}>
        <ControlPanelContainer
          map={mapRef.current}
          isMapLoaded={mapLoaded}
          lidarDownloadModeActive={lidarModeEnabled}
          onToggleLidarDownloadMode={() => setLidarModeEnabled((v) => !v)}
          width={panelWidth}
          onResizeStart={handleResizeStart}
          isResizing={isResizing}
        />
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

