import { useEffect, useRef, useState } from 'react';
import { MapView, MapBlurMirror } from '@/features/map3d';
import { LidarPanel } from '@/features/lidar';
import { FitPredictionPanel } from '@/features/fitPredictor';
import { ControlPanelContainer } from '@/features/controlPanel';
import { ItineraryPanel } from '@/features/itineraryPanel';
import { LidarProvider } from '@/features/lidar/components/LidarContext';
import { CenterPanel } from '@/features/analysisPanel';
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
// Hard minimum computed from the Rythme section's narrowest row:
//   [checkbox 16 + gap 4 + label min 28 + gap 4 + upload min 88]
// + gap 8
// + [checkbox 16 + gap 4 + label min 28 + gap 4 + chip min 64]
// = 264 px inner content, + 24 px panel padding + 8 px safety = 296.
// We round up to 320 so the scrollbar + browser rounding never push
// cells into overlap when the user drags the handle all the way left.
const LEFT_PANEL_WIDTH_MIN = 320;
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
  const [viewport, setViewport] = useState(() => ({
    w: window.innerWidth,
    h: window.innerHeight,
  }));

  useEffect(() => {
    const onResize = () =>
      setViewport({ w: window.innerWidth, h: window.innerHeight });
    window.addEventListener('resize', onResize);
    return () => window.removeEventListener('resize', onResize);
  }, []);

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
    flexDirection: 'column',
    overflow: 'hidden',
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
    flexDirection: 'column',
    overflow: 'hidden',
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
    <div style={{ position: 'relative', width: '100vw', height: '100dvh', overflow: 'hidden' }}>
      <MapView onMapReady={handleMapReady} lidarSelectionEnabled={lidarModeEnabled} onLidarSelectionDisable={() => setLidarModeEnabled(false)} />

      {/*
        Glass-effect blur backdrops. Each one is a 2D canvas that mirrors
        a slice of the Mapbox WebGL canvas every frame with a CSS
        `filter: blur()` applied. This works around the fact that CSS
        `backdrop-filter` does not reliably sample a sibling WebGL canvas
        in Chromium / Safari (compositor-layer boundaries break backdrop
        sampling). The mirror sits BELOW the panel (z-index 24 vs 25), so
        the panel only needs a translucent tint as background — no
        `backdrop-filter` required.
      */}
      {mapLoaded && leftPanelOpen && (
        <MapBlurMirror
          map={mapRef.current}
          top={PANEL_PADDING}
          left={PANEL_PADDING}
          width={leftPanelWidth}
          height={Math.max(0, viewport.h - PANEL_PADDING * 2)}
          borderRadius={8}
        />
      )}
      {mapLoaded && (
        <MapBlurMirror
          map={mapRef.current}
          top={PANEL_PADDING}
          left={Math.max(
            0,
            viewport.w - panelWidth - PANEL_PADDING,
          )}
          width={panelWidth}
          height={Math.max(0, viewport.h - PANEL_PADDING * 2)}
          borderRadius={8}
        />
      )}

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

      {/* Bottom center analysis panel */}
      <div style={{
        position: 'absolute',
        bottom: PANEL_PADDING,
        left: leftPanelOpen ? leftPanelWidth + PANEL_PADDING * 2 : 0,
        right: panelWidth + PANEL_PADDING * 2,
        zIndex: 25,
        display: 'flex',
        justifyContent: 'center',
        pointerEvents: 'none',
      }}>
        <CenterPanel
          className="backdrop-blur-[60px] bg-[rgba(15,15,15,0.74)] flex flex-col gap-[12px] items-start min-h-[407px] p-[12px] rounded-[8px] w-full max-w-[1308px]"
          style={{ pointerEvents: 'auto' }}
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

