import { useCallback, useMemo, useRef, useState, type CSSProperties } from 'react';
import type { Map as MapboxMap } from 'mapbox-gl';
import {
  MapView,
  MapBlurMirror,
  MapOverlayStatusDock,
  type OverlayStatusId,
  type OverlayStatusSnapshot,
} from '@/features/map3d';
import { createOverlayStatus } from '@/features/map3d/overlayStatus';
import { ControlPanelContainer } from '@/features/controlPanel';
import { ExporterPanel } from '@/features/controlPanel/ExporterPanel';
import { CenterPanel } from '@/features/centerPanel';
import { CenterPanelToolbar } from '@/features/centerPanel/components/CenterPanelToolbar';
import { ItineraryPanel, PredictionProvider, ProjectProvider } from '@/features/itineraryPanel';
import { MapViewportControls } from '@/features/mapViewportControls';
import { ProjectBrowserOverlay } from '@/features/projectBrowser';
import { LidarProvider } from '@/features/lidar/components/LidarContext';
import {
  CENTER_PANEL_STACK_GAP,
  CENTER_PANEL_RESIZE_HIT_AREA,
  CENTER_TOOLBAR_HEIGHT,
  IMMERSIVE_EASING,
  IMMERSIVE_TRANSITION_MS,
  PANEL_PADDING,
} from './constants';
import { useDashboardChrome } from './useDashboardChrome';
import { useDashboardProjectState } from './useDashboardProjectState';
import { formatDisplayName } from './utils';

interface DashboardProps {
  email: string;
  initialProjectId?: string | null;
}

const OVERLAY_LABEL: Record<Exclude<OverlayStatusId, 'map'>, string> = {
  weather: 'Météo',
  shadow: 'Ombres',
};

export default function Dashboard({
  email,
  initialProjectId,
}: DashboardProps) {
  const [mapInstance, setMapInstance] = useState<MapboxMap | null>(null);
  const [mapLoaded, setMapLoaded] = useState(false);
  const [mapStatus, setMapStatus] = useState<OverlayStatusSnapshot | null>(null);
  const [overlayStatuses, setOverlayStatuses] = useState<Partial<Record<OverlayStatusId, OverlayStatusSnapshot>>>({});
  const overlayReloadersRef = useRef<Partial<Record<OverlayStatusId, () => void>>>({});

  const {
    activeProjectId,
    activeProjectInitial,
    projectLoading,
    projectBrowserOpen,
    setProjectBrowserOpen,
    handleOpenProject,
    handleBackToBrowser,
    handleProjectChange,
    updatePersistedDashboard,
  } = useDashboardProjectState({
    initialProjectId,
    mapInstance,
  });

  const {
    lidarModeEnabled,
    setLidarModeEnabled,
    isMapFocusMode,
    leftPanelOpen,
    panelWidth,
    leftPanelWidth,
    isResizing,
    isLeftResizing,
    projectMapViewport,
    rightPrimaryPanelHostRef,
    exporterPanelHostRef,
    layout,
    handleMapViewportChange,
    handleResizeStart,
    handleLeftResizeStart,
    handleCenterPanelResizeStart,
    handleToggleMapFocusMode,
  } = useDashboardChrome({
    activeProjectInitial,
    updatePersistedDashboard,
  });

  const handleMapReady = (map: MapboxMap) => {
    setMapInstance(map);
    setMapLoaded(true);
  };

  const setOverlayStatus = useCallback((id: OverlayStatusId, status: OverlayStatusSnapshot | null) => {
    setOverlayStatuses((prev) => {
      if (!status) {
        if (!(id in prev)) return prev;
        const next = { ...prev };
        delete next[id];
        return next;
      }
      const current = prev[id];
      if (
        current
        && current.state === status.state
        && current.progress === status.progress
        && current.detail === status.detail
        && current.reloadable === status.reloadable
      ) {
        return prev;
      }
      return { ...prev, [id]: status };
    });
  }, []);

  const setOverlayReloader = useCallback((id: OverlayStatusId, reload: (() => void) | null) => {
    if (reload) {
      overlayReloadersRef.current[id] = reload;
      if (id !== 'map') {
        setOverlayStatuses((prev) => {
          const current = prev[id];
          if (current) {
            if (current.reloadable) return prev;
            return {
              ...prev,
              [id]: { ...current, reloadable: true },
            };
          }
          return {
            ...prev,
            [id]: {
              id,
              label: OVERLAY_LABEL[id],
              state: 'ready',
              progress: 100,
              detail: 'Overlay prêt',
              reloadable: true,
              updatedAt: Date.now(),
            },
          };
        });
      }
      return;
    }
    delete overlayReloadersRef.current[id];
    if (id !== 'map') {
      setOverlayStatuses((prev) => {
        const current = prev[id];
        if (!current || current.state !== 'ready') return prev;
        const next = { ...prev };
        delete next[id];
        return next;
      });
    }
  }, []);

  const handleMapLoadStatusChange = useCallback((status: OverlayStatusSnapshot | null) => {
    setMapStatus(status);
  }, []);

  const handleMapReloadChange = useCallback((reload: (() => void) | null) => {
    setOverlayReloader('map', reload);
    setMapStatus((prev) => {
      if (!reload) {
        if (!prev) return null;
        if (!prev.reloadable) return prev;
        return { ...prev, reloadable: false, updatedAt: Date.now() };
      }

      if (!prev) {
        return createOverlayStatus({
          id: 'map',
          label: 'Carte',
          state: 'ready',
          progress: 100,
          detail: 'Carte prête',
          reloadable: true,
        });
      }

      if (prev.reloadable) return prev;
      return { ...prev, reloadable: true, updatedAt: Date.now() };
    });
  }, [setOverlayReloader]);

  const handleWeatherOverlayStatusChange = useCallback(
    (status: OverlayStatusSnapshot | null) => {
      setOverlayStatus('weather', status);
    },
    [setOverlayStatus],
  );

  const handleShadowOverlayStatusChange = useCallback(
    (status: OverlayStatusSnapshot | null) => {
      setOverlayStatus('shadow', status);
    },
    [setOverlayStatus],
  );

  const handleWeatherOverlayReloadChange = useCallback(
    (reload: (() => void) | null) => {
      setOverlayReloader('weather', reload);
    },
    [setOverlayReloader],
  );

  const handleShadowOverlayReloadChange = useCallback(
    (reload: (() => void) | null) => {
      setOverlayReloader('shadow', reload);
    },
    [setOverlayReloader],
  );

  const visibleStatuses = useMemo(() => {
    const orderedIds: OverlayStatusId[] = ['shadow', 'map', 'weather'];
    const snapshots: Partial<Record<OverlayStatusId, OverlayStatusSnapshot>> = {
      ...overlayStatuses,
      ...(mapStatus
        ? {
            map: {
              ...mapStatus,
              reloadable: mapStatus.reloadable ?? Boolean(overlayReloadersRef.current.map),
            },
          }
        : {}),
    };
    return orderedIds
      .map((id) => snapshots[id])
      .filter((status): status is OverlayStatusSnapshot => Boolean(status));
  }, [mapStatus, overlayStatuses]);

  const statusDockRight = isMapFocusMode
    ? PANEL_PADDING
    : panelWidth + PANEL_PADDING * 2 + PANEL_PADDING;
  const statusDockLeft = isMapFocusMode && layout.centerToolbarVisible
    ? layout.centerToolbarLeft + layout.centerToolbarWidth / 2
    : undefined;
  const statusDockBottom = layout.centerToolbarVisible
    ? layout.designH - layout.centerToolbarTop + CENTER_PANEL_STACK_GAP
    : 88;

  const handleOverlayReload = useCallback((id: OverlayStatusId) => {
    overlayReloadersRef.current[id]?.();
  }, []);

  const rightPanelStyle: CSSProperties = {
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
    gap: PANEL_PADDING,
    overflow: 'hidden',
    opacity: isMapFocusMode ? 0 : 1,
    transform: isMapFocusMode
      ? 'translate3d(28px, 0, 0) scale(0.985)'
      : 'translate3d(0, 0, 0) scale(1)',
    filter: isMapFocusMode ? 'blur(10px) saturate(0.88)' : 'blur(0px) saturate(1)',
    pointerEvents: isMapFocusMode ? 'none' : 'auto',
    transition: `opacity ${IMMERSIVE_TRANSITION_MS}ms ${IMMERSIVE_EASING}, transform ${IMMERSIVE_TRANSITION_MS}ms ${IMMERSIVE_EASING}, filter ${IMMERSIVE_TRANSITION_MS}ms ease`,
    willChange: 'transform, opacity, filter',
  };

  const leftPanelStyle: CSSProperties = {
    position: 'absolute',
    top: 0,
    left: 0,
    bottom: 0,
    width: leftPanelWidth + PANEL_PADDING * 2,
    zIndex: 25,
    padding: PANEL_PADDING,
    boxSizing: 'border-box',
    display: 'flex',
    flexDirection: 'column',
    overflow: 'hidden',
    opacity: isMapFocusMode ? 0 : 1,
    transform: isMapFocusMode
      ? 'translate3d(-28px, 0, 0) scale(0.985)'
      : 'translate3d(0, 0, 0) scale(1)',
    filter: isMapFocusMode ? 'blur(10px) saturate(0.88)' : 'blur(0px) saturate(1)',
    pointerEvents: isMapFocusMode ? 'none' : 'auto',
    transition: `opacity ${IMMERSIVE_TRANSITION_MS}ms ${IMMERSIVE_EASING}, transform ${IMMERSIVE_TRANSITION_MS}ms ${IMMERSIVE_EASING}, filter ${IMMERSIVE_TRANSITION_MS}ms ease`,
    willChange: 'transform, opacity, filter',
  };

  const mapViewportControlsStyle: CSSProperties = {
    position: 'absolute',
    top: PANEL_PADDING,
    right: isMapFocusMode
      ? PANEL_PADDING
      : panelWidth + PANEL_PADDING * 2 + PANEL_PADDING,
    zIndex: 30,
    transition: `right ${IMMERSIVE_TRANSITION_MS}ms ${IMMERSIVE_EASING}, top ${IMMERSIVE_TRANSITION_MS}ms ${IMMERSIVE_EASING}`,
  };

  const rightPrimaryPanelStyle: CSSProperties = {
    height: `${layout.rightPrimaryPanelHeight}px`,
    minHeight: 0,
    display: 'flex',
    transition: 'height 360ms cubic-bezier(0.22, 1, 0.36, 1), transform 360ms cubic-bezier(0.22, 1, 0.36, 1), filter 280ms ease',
    willChange: 'height, transform',
    transform:
      layout.rightPrimaryPanelHeight > 80 ? 'translateY(0)' : 'translateY(-2px)',
    filter: layout.rightPrimaryPanelHeight > 80 ? 'saturate(1)' : 'saturate(0.96)',
  };

  const displayName = formatDisplayName(email);

  return (
    <LidarProvider>
      <div style={{ position: 'relative', width: '100vw', height: '100dvh', overflow: 'hidden' }}>
        <div
          style={{
            position: 'absolute',
            top: 0,
            left: 0,
            width: `${layout.scaledViewportWidth}px`,
            height: `${layout.scaledViewportHeight}px`,
            overflow: 'hidden',
            transform: `scale(${layout.appScale})`,
            transformOrigin: 'top left',
            ['--app-scale' as string]: String(layout.appScale),
          }}
        >
          <MapView
            onMapReady={handleMapReady}
            onMapLoadStatusChange={handleMapLoadStatusChange}
            onMapReloadChange={handleMapReloadChange}
            lidarSelectionEnabled={lidarModeEnabled}
            onLidarSelectionDisable={() => setLidarModeEnabled(false)}
            initialViewport={projectMapViewport}
            onViewportChange={handleMapViewportChange}
          />

          <MapOverlayStatusDock
            statuses={visibleStatuses}
            right={statusDockRight}
            left={statusDockLeft}
            bottom={statusDockBottom}
            align={statusDockLeft == null ? 'end' : 'center'}
            transform={statusDockLeft == null ? undefined : 'translateX(-50%)'}
            hidden={projectBrowserOpen || activeProjectId == null}
            onReload={handleOverlayReload}
          />

          <div style={mapViewportControlsStyle}>
            <MapViewportControls
              map={mapInstance}
              isMapLoaded={mapLoaded}
              immersiveMode={isMapFocusMode}
              onToggleImmersiveMode={handleToggleMapFocusMode}
            />
          </div>

          {mapLoaded && leftPanelOpen && (
            <MapBlurMirror
              map={mapInstance}
              top={PANEL_PADDING}
              left={PANEL_PADDING}
              width={leftPanelWidth}
              height={Math.max(0, layout.designH - PANEL_PADDING * 2)}
              borderRadius={8}
            />
          )}
          {mapLoaded && !isMapFocusMode && (
            <MapBlurMirror
              map={mapInstance}
              top={PANEL_PADDING}
              left={Math.max(0, layout.designW - panelWidth - PANEL_PADDING)}
              width={panelWidth}
              height={Math.max(0, layout.designH - PANEL_PADDING * 2)}
              borderRadius={8}
            />
          )}
          {mapLoaded && layout.centerToolbarVisible && (
            <MapBlurMirror
              map={mapInstance}
              top={layout.centerToolbarTop}
              left={layout.centerToolbarLeft}
              width={layout.centerToolbarWidth}
              height={CENTER_TOOLBAR_HEIGHT}
              borderRadius={8}
            />
          )}
          {mapLoaded && layout.centerPanelVisible && (
            <MapBlurMirror
              map={mapInstance}
              top={layout.centerPanelTop}
              left={layout.centerPanelLeft}
              width={layout.centerPanelWidth}
              height={layout.centerPanelHeight}
              borderRadius={8}
            />
          )}

          <ProjectProvider
            key={activeProjectId ?? 'no-project'}
            initialProject={activeProjectInitial ?? undefined}
            onProjectChange={handleProjectChange}
          >
            <PredictionProvider>
              <div style={leftPanelStyle}>
                <ItineraryPanel
                  map={mapInstance}
                  isMapLoaded={mapLoaded}
                  width={leftPanelWidth}
                  onResizeStart={handleLeftResizeStart}
                  isResizing={isLeftResizing}
                  onBackToHome={handleBackToBrowser}
                />
              </div>

              {layout.centerToolbarVisible ? (
                <div
                  style={{
                    position: 'absolute',
                    top: layout.centerToolbarTop,
                    left: layout.centerToolbarLeft,
                    width: layout.centerToolbarWidth,
                    height: CENTER_TOOLBAR_HEIGHT,
                    zIndex: 25,
                    overflow: 'hidden',
                    transition: `top ${IMMERSIVE_TRANSITION_MS}ms ${IMMERSIVE_EASING}, left ${IMMERSIVE_TRANSITION_MS}ms ${IMMERSIVE_EASING}, width ${IMMERSIVE_TRANSITION_MS}ms ${IMMERSIVE_EASING}`,
                    willChange: 'top, left, width',
                  }}
                >
                  <CenterPanelToolbar />
                </div>
              ) : null}

              {layout.centerToolbarVisible ? (
                <div
                  aria-hidden="true"
                  onMouseDown={handleCenterPanelResizeStart}
                  style={{
                    position: 'absolute',
                    top: layout.centerPanelResizeHitTop,
                    left: layout.centerPanelLeft,
                    width: layout.centerPanelWidth,
                    height: CENTER_PANEL_RESIZE_HIT_AREA,
                    zIndex: 26,
                    cursor: isMapFocusMode ? 'default' : 'row-resize',
                    userSelect: 'none',
                    touchAction: 'none',
                    opacity: isMapFocusMode ? 0 : 1,
                    pointerEvents: isMapFocusMode ? 'none' : 'auto',
                    transition: `opacity ${IMMERSIVE_TRANSITION_MS}ms ${IMMERSIVE_EASING}, top ${IMMERSIVE_TRANSITION_MS}ms ${IMMERSIVE_EASING}, left ${IMMERSIVE_TRANSITION_MS}ms ${IMMERSIVE_EASING}, width ${IMMERSIVE_TRANSITION_MS}ms ${IMMERSIVE_EASING}`,
                  }}
                />
              ) : null}

              {layout.centerToolbarVisible ? (
                <div
                  style={{
                    position: 'absolute',
                    top: layout.centerPanelTop,
                    left: layout.centerPanelLeft,
                    width: layout.centerPanelWidth,
                    height: layout.centerPanelHeight,
                    zIndex: 25,
                    overflow: 'hidden',
                    opacity: layout.centerPanelVisible ? 1 : 0,
                    transform: layout.centerPanelVisible
                      ? 'translate3d(0, 0, 0) scale(1)'
                      : 'translate3d(0, 24px, 0) scale(0.985)',
                    filter: layout.centerPanelVisible
                      ? 'blur(0px) saturate(1)'
                      : 'blur(10px) saturate(0.88)',
                    pointerEvents: layout.centerPanelVisible ? 'auto' : 'none',
                    transition: `opacity ${IMMERSIVE_TRANSITION_MS}ms ${IMMERSIVE_EASING}, transform ${IMMERSIVE_TRANSITION_MS}ms ${IMMERSIVE_EASING}, filter ${IMMERSIVE_TRANSITION_MS}ms ease, top ${IMMERSIVE_TRANSITION_MS}ms ${IMMERSIVE_EASING}, left ${IMMERSIVE_TRANSITION_MS}ms ${IMMERSIVE_EASING}, width ${IMMERSIVE_TRANSITION_MS}ms ${IMMERSIVE_EASING}`,
                    willChange: 'transform, opacity, filter, top, left, width',
                  }}
                >
                  <CenterPanel map={mapInstance} />
                </div>
              ) : null}

              <div style={rightPanelStyle}>
                <div ref={rightPrimaryPanelHostRef} style={rightPrimaryPanelStyle}>
                  <ControlPanelContainer
                    map={mapInstance}
                    isMapLoaded={mapLoaded}
                    onWeatherOverlayStatusChange={handleWeatherOverlayStatusChange}
                    onWeatherOverlayReloadChange={handleWeatherOverlayReloadChange}
                    onShadowOverlayStatusChange={handleShadowOverlayStatusChange}
                    onShadowOverlayReloadChange={handleShadowOverlayReloadChange}
                    lidarDownloadModeActive={lidarModeEnabled}
                    onToggleLidarDownloadMode={() => setLidarModeEnabled((value) => !value)}
                    width={panelWidth}
                    onResizeStart={handleResizeStart}
                    isResizing={isResizing}
                  />
                </div>
                <div ref={exporterPanelHostRef} style={{ flex: '0 0 auto' }}>
                  <ExporterPanel width={panelWidth} />
                </div>
              </div>
            </PredictionProvider>
          </ProjectProvider>

          <ProjectBrowserOverlay
            open={projectBrowserOpen || activeProjectId == null}
            displayName={displayName}
            canClose={activeProjectId != null && !projectLoading}
            onOpenProject={handleOpenProject}
            onRequestClose={() => setProjectBrowserOpen(false)}
          />
        </div>
      </div>
    </LidarProvider>
  );
}