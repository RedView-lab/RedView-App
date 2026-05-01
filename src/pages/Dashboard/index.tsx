import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { Map as MapboxMap } from 'mapbox-gl';
import { SvgV2Icon } from '@/shared/components/SvgV2Icon';
import {
  createOverlayStatus,
  MapView,
  MapBlurMirror,
  MapOverlayStatusDock,
  type OverlayStatusId,
  type OverlayStatusSnapshot,
} from '@/features/map3d';
import {
  ControlPanelContainer,
  DEFAULT_BASEMAP_ID,
  ExporterPanel,
  getBasemapStyleUrl,
  normalizeBasemapId,
} from '@/features/controlPanel';
import { CenterPanel, CenterPanelToolbar } from '@/features/centerPanel';
import { AnalysisFlyoverProvider } from '@/features/centerPanel/flyover';
import { RouteMergeToolProvider } from '@/features/centerPanel/routeMerge';
import { RouteSplitToolProvider } from '@/features/centerPanel/routeSplit';
import { TraceToolProvider } from '@/features/centerPanel/tracer';
import { ForbiddenZoneToolProvider } from '@/features/centerPanel/forbiddenZones';
import { ItineraryPanel, PredictionProvider, ProjectProvider } from '@/features/itineraryPanel';
import { IconArrowLeft } from '@/features/itineraryPanel/components/icons';
import { MapViewportControls } from '@/features/mapViewportControls';
import { ProjectBrowserOverlay } from '@/features/projectBrowser';
import { LidarProvider } from '@/features/lidar/components/LidarContext';
import { DashboardPlaceSearch } from './DashboardPlaceSearch';
import {
  CENTER_PANEL_STACK_GAP,
  CENTER_TOOLBAR_HEIGHT,
  PANEL_PADDING,
} from './constants';
import { getDashboardStyles } from './dashboardStyles';
import { useDashboardChrome } from './useDashboardChrome';
import { useDashboardProjectState } from './useDashboardProjectState';
import { formatDisplayName } from './utils';

interface DashboardProps {
  email: string;
  initialProjectId?: string | null;
}

const OVERLAY_LABEL: Record<Exclude<OverlayStatusId, 'map'>, string> = {
  itinerary: 'Itinéraire',
  weather: 'Météo',
  shadow: 'Ombres',
};

export default function Dashboard({
  email,
  initialProjectId,
}: DashboardProps) {
  const [mapInstance, setMapInstance] = useState<MapboxMap | null>(null);
  const [mapLoaded, setMapLoaded] = useState(false);
  const [selectedBasemapId, setSelectedBasemapId] = useState(DEFAULT_BASEMAP_ID);
  const effectiveBasemapId = selectedBasemapId;
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

  const initialBasemapId = normalizeBasemapId(
    activeProjectInitial?.controlPanel?.basemapId ?? DEFAULT_BASEMAP_ID,
  );

  useEffect(() => {
    setSelectedBasemapId(initialBasemapId);
  }, [activeProjectId, initialBasemapId]);

  const {
    lidarModeEnabled,
    setLidarModeEnabled,
    isMapFocusMode,
    leftPanelOpen,
    panelWidth,
    isLeftPanelCollapsed,
    isCenterPanelCollapsed,
    isRightPanelCollapsed,
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
    restoreCenterPanel,
    restoreLeftPanel,
    restoreRightPanel,
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

  const handleItineraryRouteStatusChange = useCallback(
    (status: OverlayStatusSnapshot | null) => {
      setOverlayStatus('itinerary', status);
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
    const orderedIds: OverlayStatusId[] = ['itinerary', 'shadow', 'map', 'weather'];
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

  const rightDockWidth = isMapFocusMode
    ? 0
    : isRightPanelCollapsed
      ? 0
      : panelWidth + PANEL_PADDING * 2;
  const rightDockOffset = isMapFocusMode || isRightPanelCollapsed
    ? PANEL_PADDING
    : rightDockWidth + PANEL_PADDING;

  const statusDockRight = isMapFocusMode
    ? PANEL_PADDING
    : rightDockOffset;
  const statusDockLeft = isMapFocusMode && layout.centerToolbarVisible
    ? layout.centerToolbarLeft + layout.centerToolbarWidth / 2
    : undefined;
  const statusDockBottom = layout.centerToolbarVisible
    ? layout.designH - layout.centerToolbarTop + CENTER_PANEL_STACK_GAP
    : 88;

  const handleOverlayReload = useCallback((id: OverlayStatusId) => {
    overlayReloadersRef.current[id]?.();
  }, []);

  const leftDockWidth = isMapFocusMode || isLeftPanelCollapsed
    ? 0
    : leftPanelWidth + PANEL_PADDING * 2;

  const dashboardSearchLeft = isMapFocusMode || !leftPanelOpen
    ? PANEL_PADDING
    : leftPanelWidth + PANEL_PADDING * 2 + PANEL_PADDING;
  const dashboardSearchVisible = !projectBrowserOpen && activeProjectId != null;

  const styles = getDashboardStyles({
    layout,
    isMapFocusMode,
    isLeftPanelCollapsed,
    isCenterPanelCollapsed,
    isRightPanelCollapsed,
    panelWidth,
    leftPanelWidth,
    rightDockWidth,
    rightDockOffset,
    leftDockWidth,
  });

  const displayName = formatDisplayName(email);
  const editorOpen = !projectBrowserOpen && activeProjectId != null;

  useEffect(() => {
    if (editorOpen) return;
    setMapLoaded(false);
    setMapInstance(null);
  }, [editorOpen]);

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
          {editorOpen ? (
            <>
              <MapView
                onMapReady={handleMapReady}
                onMapLoadStatusChange={handleMapLoadStatusChange}
                onMapReloadChange={handleMapReloadChange}
                lidarSelectionEnabled={lidarModeEnabled}
                onLidarSelectionDisable={() => setLidarModeEnabled(false)}
                initialViewport={projectMapViewport}
                onViewportChange={handleMapViewportChange}
                basemapStyleUrl={getBasemapStyleUrl(effectiveBasemapId)}
              />

              <MapOverlayStatusDock
                statuses={visibleStatuses}
                right={statusDockRight}
                left={statusDockLeft}
                bottom={statusDockBottom}
                align={statusDockLeft == null ? 'end' : 'center'}
                transform={statusDockLeft == null ? undefined : 'translateX(-50%)'}
                hidden={!editorOpen}
                onReload={handleOverlayReload}
              />

              <div style={styles.mapViewportControlsStyle}>
                <MapViewportControls
                  map={mapInstance}
                  isMapLoaded={mapLoaded}
                  immersiveMode={isMapFocusMode}
                  onToggleImmersiveMode={handleToggleMapFocusMode}
                />
              </div>

              <div style={styles.leftCollapsedRailStyle}>
                <button
                  type="button"
                  aria-label="Rouvrir le panneau de gauche"
                  onClick={restoreLeftPanel}
                  style={{
                    ...styles.collapsedPanelRailButtonStyle,
                    transform: 'rotate(180deg)',
                  }}
                >
                  <IconArrowLeft size={18} />
                </button>
              </div>

              <div style={styles.rightCollapsedRailStyle}>
                <button
                  type="button"
                  aria-label="Rouvrir le panneau de droite"
                  onClick={restoreRightPanel}
                  style={styles.collapsedPanelRailButtonStyle}
                >
                  <IconArrowLeft size={18} />
                </button>
              </div>

              <div style={styles.centerCollapsedRailStyle}>
                <button
                  type="button"
                  aria-label="Rouvrir le panneau central"
                  onClick={restoreCenterPanel}
                  style={styles.centerCollapsedRailButtonStyle}
                >
                  <SvgV2Icon name="chevron-down.svg" size={18} />
                </button>
              </div>

              <DashboardPlaceSearch
                map={mapInstance}
                visible={dashboardSearchVisible}
                left={dashboardSearchLeft}
                top={PANEL_PADDING}
              />

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
              {mapLoaded && !isMapFocusMode && !isRightPanelCollapsed && (
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
                <RouteSplitToolProvider map={mapInstance}>
                  <RouteMergeToolProvider>
                    <TraceToolProvider map={mapInstance}>
                      <ForbiddenZoneToolProvider map={mapInstance}>
                      <PredictionProvider>
                      <div style={styles.leftPanelStyle}>
                        <div style={styles.leftPanelContentStyle}>
                          <ItineraryPanel
                            projectId={activeProjectId}
                            map={mapInstance}
                            isMapLoaded={mapLoaded}
                            onRouteStatusChange={handleItineraryRouteStatusChange}
                            width={leftPanelWidth}
                            onResizeStart={handleLeftResizeStart}
                            isResizing={isLeftResizing}
                            onBackToHome={handleBackToBrowser}
                          />
                        </div>
                      </div>

                      <AnalysisFlyoverProvider map={mapInstance}>
                        {layout.centerToolbarVisible ? (
                          <div style={styles.centerToolbarShellStyle}>
                            <CenterPanelToolbar />
                          </div>
                        ) : null}

                        {layout.centerPanelVisible ? (
                          <div
                            aria-hidden="true"
                            onMouseDown={handleCenterPanelResizeStart}
                            style={styles.centerResizeHandleStyle}
                          />
                        ) : null}

                        {layout.centerToolbarVisible ? (
                          <div style={styles.centerPanelShellStyle}>
                            <CenterPanel map={mapInstance} />
                          </div>
                        ) : null}
                      </AnalysisFlyoverProvider>

                      <div style={styles.rightPanelStyle}>
                        <div style={styles.rightPanelContentStyle}>
                          <div ref={rightPrimaryPanelHostRef} style={styles.rightPrimaryPanelStyle}>
                            <ControlPanelContainer
                              map={mapInstance}
                              isMapLoaded={mapLoaded}
                              onBasemapChange={setSelectedBasemapId}
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
                      </div>
                      </PredictionProvider>
                      </ForbiddenZoneToolProvider>
                    </TraceToolProvider>
                  </RouteMergeToolProvider>
                </RouteSplitToolProvider>
              </ProjectProvider>
            </>
          ) : null}

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