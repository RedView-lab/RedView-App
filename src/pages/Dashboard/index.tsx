import { useCallback, useEffect, useState } from 'react';
import type { Map as MapboxMap } from 'mapbox-gl';
import { ProjectBrowserOverlay } from '@/features/projectBrowser';
import { LidarProvider } from '@/features/lidar/components/LidarContext';
import { DashboardEditor } from './components/DashboardEditor';
import { DashboardProjectLoading } from './components/DashboardProjectLoading';
import { useDashboardBasemap } from './hooks/useDashboardBasemap';
import { useDashboardOverlayStatus } from './hooks/useDashboardOverlayStatus';
import { CENTER_PANEL_STACK_GAP, COLLAPSED_DRAWER_CLEARANCE, PANEL_PADDING } from './lib/constants';
import { getDashboardStyles } from './lib/dashboardStyles';
import { useDashboardChrome } from './useDashboardChrome';
import { useDashboardProjectState } from './useDashboardProjectState';
import { formatDisplayName } from './lib/utils';

interface DashboardProps {
  email: string;
  initialProjectId?: string | null;
  isDemoAccount: boolean;
  offersUrl: string;
}

export default function Dashboard({
  email,
  initialProjectId,
  isDemoAccount,
  offersUrl,
}: DashboardProps) {
  const [mapInstance, setMapInstance] = useState<MapboxMap | null>(null);
  const [mapLoaded, setMapLoaded] = useState(false);

  const prepareProjectClose = useCallback(async () => {
    setMapLoaded(false);
    await new Promise<void>((resolve) => {
      window.requestAnimationFrame(() => resolve());
    });
  }, []);

  const {
    activeProjectId,
    activeProjectInitial,
    isClosingProject,
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
    beforeCloseProject: prepareProjectClose,
  });

  const { activeBasemapConfig, handleBasemapChange } = useDashboardBasemap({
    activeProjectId,
    activeProjectInitial,
  });

  const {
    visibleStatuses,
    handleOverlayReload,
    handleMapLoadStatusChange,
    handleMapReloadChange,
    handleWeatherOverlayStatusChange,
    handleWindOverlayStatusChange,
    handleShadowOverlayStatusChange,
    handleSunlightMapOverlayStatusChange,
    handleSlopeOverlayStatusChange,
    handleAltitudeOverlayStatusChange,
    handleItineraryRouteStatusChange,
    handleWeatherOverlayReloadChange,
    handleWindOverlayReloadChange,
    handleShadowOverlayReloadChange,
    handleSunlightMapOverlayReloadChange,
  } = useDashboardOverlayStatus();

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
    isCenterResizing,
    projectMapViewport,
    rightPrimaryPanelHostRef,
    exporterPanelHostRef,
    layout,
    handleMapViewportChange,
    handleResizeStart,
    handleLeftResizeStart,
    handleCenterPanelResizeStart,
    handleToggleMapFocusMode,
    handleTraceStarted,
    restoreCenterPanel,
    restoreLeftPanel,
    restoreRightPanel,
    collapseLeftPanel,
    collapseRightPanel,
    collapseCenterPanel,
  } = useDashboardChrome({
    activeProjectInitial,
    updatePersistedDashboard,
  });

  const handleMapReady = useCallback((map: MapboxMap) => {
    setMapInstance(map);
    setMapLoaded(true);
  }, []);

  const rightDockWidth = isMapFocusMode
    ? 0
    : isRightPanelCollapsed
      ? 0
      : panelWidth + PANEL_PADDING * 2;
  const rightDockOffset = isMapFocusMode
    ? PANEL_PADDING
    : isRightPanelCollapsed
      ? COLLAPSED_DRAWER_CLEARANCE
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

  const leftDockWidth = isMapFocusMode || isLeftPanelCollapsed
    ? 0
    : leftPanelWidth + PANEL_PADDING * 2;

  // The search wrapper now starts right after the left drawer and owns the
  // mirrored panel toggle as its first flex child, so the row reads:
  // [ drawer ] PANEL_PADDING [ toggle ] PANEL_PADDING [ search bar ]
  const dashboardSearchLeft = isMapFocusMode || !leftPanelOpen
    ? PANEL_PADDING
    : leftPanelWidth + PANEL_PADDING * 2;
  const dashboardSearchVisible = !projectBrowserOpen && activeProjectId != null;

  const styles = getDashboardStyles({
    layout,
    isMapFocusMode,
    isLeftPanelCollapsed,
    isCenterPanelCollapsed,
    isRightPanelCollapsed,
    isCenterResizing,
    panelWidth,
    leftPanelWidth,
    rightDockWidth,
    rightDockOffset,
    leftDockWidth,
  });

  const displayName = formatDisplayName(email);
  const editorOpen = !projectBrowserOpen && activeProjectId != null;
  // Full screen: project manager -> loading page -> 3D editor. We keep the
  // manager mounted underneath while a project loads so its state survives the
  // transition, but the loading page covers it entirely.
  const loadingProject = projectLoading || isClosingProject;
  const projectBrowserVisible = (projectBrowserOpen || activeProjectId == null) && !loadingProject;

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
            <DashboardEditor
              activeProjectId={activeProjectId}
              activeProjectInitial={activeProjectInitial}
              isDemoAccount={isDemoAccount}
              offersUrl={offersUrl}
              isClosingProject={isClosingProject}
              mapInstance={mapInstance}
              mapLoaded={mapLoaded}
              lidarModeEnabled={lidarModeEnabled}
              setLidarModeEnabled={setLidarModeEnabled}
              isMapFocusMode={isMapFocusMode}
              leftPanelOpen={leftPanelOpen}
              panelWidth={panelWidth}
              leftPanelWidth={leftPanelWidth}
              isRightPanelCollapsed={isRightPanelCollapsed}
              isResizing={isResizing}
              isLeftResizing={isLeftResizing}
              projectMapViewport={projectMapViewport}
              rightPrimaryPanelHostRef={rightPrimaryPanelHostRef}
              exporterPanelHostRef={exporterPanelHostRef}
              layout={layout}
              styles={styles}
              activeBasemapConfig={activeBasemapConfig}
              visibleStatuses={visibleStatuses}
              statusDockRight={statusDockRight}
              statusDockLeft={statusDockLeft}
              statusDockBottom={statusDockBottom}
              dashboardSearchVisible={dashboardSearchVisible}
              dashboardSearchLeft={dashboardSearchLeft}
              onMapReady={handleMapReady}
              onMapLoadStatusChange={handleMapLoadStatusChange}
              onMapReloadChange={handleMapReloadChange}
              onMapViewportChange={handleMapViewportChange}
              onToggleMapFocusMode={handleToggleMapFocusMode}
              onRestoreLeftPanel={restoreLeftPanel}
              onRestoreRightPanel={restoreRightPanel}
              onRestoreCenterPanel={restoreCenterPanel}
              onCollapseLeftPanel={collapseLeftPanel}
              onCollapseRightPanel={collapseRightPanel}
              onCollapseCenterPanel={collapseCenterPanel}
              isLeftPanelCollapsed={isLeftPanelCollapsed}
              isCenterPanelCollapsed={isCenterPanelCollapsed}
              onTraceStarted={handleTraceStarted}
              onLeftResizeStart={handleLeftResizeStart}
              onRightResizeStart={handleResizeStart}
              onCenterResizeStart={handleCenterPanelResizeStart}
              onProjectChange={handleProjectChange}
              onBackToBrowser={handleBackToBrowser}
              onOverlayReload={handleOverlayReload}
              onBasemapChange={handleBasemapChange}
              onWeatherOverlayStatusChange={handleWeatherOverlayStatusChange}
              onWeatherOverlayReloadChange={handleWeatherOverlayReloadChange}
              onWindOverlayStatusChange={handleWindOverlayStatusChange}
              onWindOverlayReloadChange={handleWindOverlayReloadChange}
              onShadowOverlayStatusChange={handleShadowOverlayStatusChange}
              onShadowOverlayReloadChange={handleShadowOverlayReloadChange}
              onSunlightMapOverlayStatusChange={handleSunlightMapOverlayStatusChange}
              onSunlightMapOverlayReloadChange={handleSunlightMapOverlayReloadChange}
              onSlopeOverlayStatusChange={handleSlopeOverlayStatusChange}
              onAltitudeOverlayStatusChange={handleAltitudeOverlayStatusChange}
              onItineraryRouteStatusChange={handleItineraryRouteStatusChange}
            />
        ) : null}

        <ProjectBrowserOverlay
          open={projectBrowserVisible}
          displayName={displayName}
          canClose={activeProjectId != null && !projectLoading && !isClosingProject}
          onOpenProject={handleOpenProject}
          onRequestClose={() => setProjectBrowserOpen(false)}
        />

        {loadingProject ? (
          <DashboardProjectLoading projectName={activeProjectInitial?.name ?? null} />
        ) : null}
        </div>
      </div>
    </LidarProvider>
  );
}