import { lazy, Suspense, useCallback, useEffect, useLayoutEffect, useState, type PointerEvent } from 'react';
import type { Map as MapboxMap } from 'mapbox-gl';
import { setDprLayoutScale } from '@/features/map3d/hooks/useMap/runtimeProfile';
import { appScaleStyle, publishRootAppScale } from '@/shared/lib/appScale';
import { ProjectBrowserOverlay } from '@/features/projectBrowser';
import { LidarProvider } from '@/features/lidar/components/LidarContext';
import { DashboardProjectLoading } from './components/DashboardProjectLoading';
import { useDashboardBasemap } from './hooks/useDashboardBasemap';
import { useDashboardOverlayStatus } from './hooks/useDashboardOverlayStatus';
import { CENTER_PANEL_STACK_GAP, PANEL_PADDING } from './lib/constants';
import { getDashboardStyles } from './lib/dashboardStyles';
import { useDashboardChrome } from './useDashboardChrome';
import { useDashboardProjectState } from './useDashboardProjectState';
import { formatDisplayName } from './lib/utils';
import { loadDashboardEditor, prefetchDashboardEditor, prefetchDashboardEditorWhenIdle } from './editorLoader';

// Éditeur 3D chargé à la demande : le gestionnaire de projets s'affiche sans
// lui (carte, LiDAR, panneaux). Préchargé dès qu'un projet est visé.
const DashboardEditor = lazy(() => loadDashboardEditor().then((module) => ({ default: module.DashboardEditor })));

/** Survol d'une carte projet : intention d'ouvrir, l'éditeur est préchargé. */
function prefetchEditorOnProjectIntent(event: PointerEvent<HTMLElement>) {
  if ((event.target as Element | null)?.closest?.('[data-rv-project-card]')) prefetchDashboardEditor();
}

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
    handleSaveProject,
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
    isAllPanelsCollapsed,
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

  // Render canvases (Mapbox, charts) at on-screen resolution despite the
  // canvas scale (`appScaleStyle`). Layout effect: runs before useMap's
  // passive effect creates the map. The logical size can stay constant while
  // appScale changes (proportional window resize), so force a map resize.
  useLayoutEffect(() => {
    setDprLayoutScale(layout.appScale);
    mapInstance?.resize();
  }, [layout.appScale, mapInstance]);

  // Mirror the scale on :root for overlays portaled to <body> (outside the
  // scaled canvas) that must keep the dashboard density: `.rv-app-scaled-layer`
  // in src/index.css, `appScaledOverlayStyle` in shared/lib/appScale.ts.
  useLayoutEffect(() => publishRootAppScale(layout.appScale), [layout.appScale]);

  const handleMapReady = useCallback((map: MapboxMap) => {
    setMapInstance(map);
    setMapLoaded(true);
  }, []);

  const rightDockWidth = isRightPanelCollapsed
    ? 0
    : panelWidth + PANEL_PADDING * 2;
  const rightDockOffset = isRightPanelCollapsed
    ? PANEL_PADDING
    : rightDockWidth + PANEL_PADDING;

  // Short canvas: the status dock no longer fits under the map tools in the
  // map stage height, it moves beside them.
  const statusDockRight = layout.isShortCanvas
    ? rightDockOffset + layout.mapToolsWidth + PANEL_PADDING
    : rightDockOffset;
  const statusDockBottom = layout.centerToolbarVisible
    ? layout.designH - layout.centerToolbarTop + CENTER_PANEL_STACK_GAP
    : 88;

  const leftDockWidth = isLeftPanelCollapsed
    ? 0
    : leftPanelWidth + PANEL_PADDING * 2;

  // The search wrapper now starts right after the left drawer and owns the
  // mirrored panel toggle as its first flex child, so the row reads:
  // [ drawer ] PANEL_PADDING [ toggle ] PANEL_PADDING [ search bar ]
  const dashboardSearchLeft = !leftPanelOpen
    ? PANEL_PADDING
    : leftPanelWidth + PANEL_PADDING * 2;
  const dashboardSearchRight = rightDockOffset + layout.mapToolsWidth + PANEL_PADDING;
  const dashboardSearchVisible = !projectBrowserOpen && activeProjectId != null;

  const styles = getDashboardStyles({
    layout,
    isLeftPanelCollapsed,
    isRightPanelCollapsed,
    isCenterResizing,
    isResizing,
    isLeftResizing,
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

  // Projet en cours d'ouverture (lien direct compris) : l'éditeur se charge
  // en parallèle du projet. Gestionnaire affiché : préchargement au repos.
  useEffect(() => {
    if (activeProjectId != null) prefetchDashboardEditor();
  }, [activeProjectId]);
  useEffect(() => {
    if (!projectBrowserVisible) return;
    return prefetchDashboardEditorWhenIdle();
  }, [projectBrowserVisible]);

  return (
    <LidarProvider>
      {/* `clip`, not `hidden`: a hidden box can still be scrolled by code
          (scrollIntoView, focus()) and would shift the whole UI up, leaving
          its top unreachable. A clip box never scrolls. */}
      <div style={{ position: 'relative', width: '100vw', height: '100dvh', overflow: 'clip' }}>
        <div
          data-rv-canvas=""
          onPointerOver={editorOpen ? undefined : prefetchEditorOnProjectIntent}
          style={{
            position: 'absolute',
            top: 0,
            left: 0,
            width: `${layout.scaledViewportWidth}px`,
            height: `${layout.scaledViewportHeight}px`,
            overflow: 'clip',
            // 1:1 up to the design reference, gentle growth above with CSS
            // zoom (text laid out at its final size, never resampled).
            ...appScaleStyle(layout.appScale),
            // Logical canvas: `@container rv-canvas (...)` and the
            // --rv-canvas-* sizes replace viewport media queries and vw/vh
            // units, which measure the real screen instead (src/index.css).
            containerType: 'inline-size',
            containerName: 'rv-canvas',
            ['--app-scale' as string]: String(layout.appScale),
            ['--rv-canvas-width' as string]: `${layout.scaledViewportWidth}px`,
            ['--rv-canvas-height' as string]: `${layout.scaledViewportHeight}px`,
          }}
        >
          {editorOpen ? (
            <Suspense fallback={<DashboardProjectLoading projectName={activeProjectInitial?.name ?? null} />}>
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
              isAllPanelsCollapsed={isAllPanelsCollapsed}
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
              statusDockBottom={statusDockBottom}
              dashboardSearchVisible={dashboardSearchVisible}
              dashboardSearchLeft={dashboardSearchLeft}
              dashboardSearchRight={dashboardSearchRight}
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
              onSaveProject={handleSaveProject}
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
            </Suspense>
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