import {
  useEffect,
  useRef,
  useState,
  useCallback,
  useMemo,
  type Dispatch,
  type MouseEvent as ReactMouseEvent,
  type RefObject,
  type SetStateAction,
} from 'react';
import type { Map as MapboxMap } from 'mapbox-gl';
import {
  MapBlurMirror,
  MapCursorLoader,
  MapOverlayStatusDock,
  MapView,
  type MapContextMenuOverlayContext,
  type OverlayReloadRegistrar,
  type OverlayStatusId,
  type OverlayStatusReporter,
  type OverlayStatusSnapshot,
} from '@/features/map3d';
import {
  ControlPanelContainer,
  ExporterPanel,
  type BasemapId,
  type BasemapRenderConfig,
} from '@/features/controlPanel';
import { CenterPanel, CenterPanelToolbar } from '@/features/centerPanel';
import { AnalysisFlyoverProvider } from '@/features/centerPanel/flyover';
import { RouteMergeToolProvider } from '@/features/centerPanel/routeMerge';
import { RouteSplitToolProvider } from '@/features/centerPanel/routeSplit';
import { ChartPlacementToolProvider } from '@/features/centerPanel/chartPlacement';
import { RouteDragWaypointProvider } from '@/features/centerPanel/routeDragWaypoint';
import { TraceToolProvider } from '@/features/centerPanel/tracer';
import { ForbiddenZoneToolProvider } from '@/features/centerPanel/forbiddenZones';
import { ItineraryPanel, PredictionProvider, ProjectProvider, useProjectStore } from '@/features/itineraryPanel';
import type { ItineraryProject } from '@/features/itineraryPanel/types';
import { hasProjectTracedContent } from '@/features/itineraryPanel/lib/project';
import { MapViewportControls } from '@/features/mapViewportControls';
import type { MapViewport } from '@/features/map3d/lib/viewport-persist';
import { useAppI18n } from '@/shared/i18n';
import { DashboardPlaceSearch } from './DashboardPlaceSearch';
import type { DashboardFilterId, DashboardPoiOptionId } from './DashboardPlaceSearch.types';
import { DASHBOARD_POI_OPTIONS } from './DashboardPlaceSearch.constants';
import type { TimelineFilterState } from '@/features/itineraryPanel/sections/timeline/TimelineFilters';
import { CENTER_TOOLBAR_HEIGHT, DASHBOARD_SEARCH_BAR_HEIGHT, PANEL_PADDING } from '../lib/constants';
import { getDashboardStyles } from '../lib/dashboardStyles';
import { getDashboardLayout } from '../lib/layout';

interface DashboardEditorProps {
  activeProjectId: string | null;
  activeProjectInitial: ItineraryProject | null;
  isDemoAccount: boolean;
  offersUrl: string;
  isClosingProject: boolean;
  mapInstance: MapboxMap | null;
  mapLoaded: boolean;
  lidarModeEnabled: boolean;
  setLidarModeEnabled: Dispatch<SetStateAction<boolean>>;
  isAllPanelsCollapsed: boolean;
  leftPanelOpen: boolean;
  panelWidth: number;
  leftPanelWidth: number;
  isLeftPanelCollapsed: boolean;
  isRightPanelCollapsed: boolean;
  isCenterPanelCollapsed: boolean;
  isResizing: boolean;
  isLeftResizing: boolean;
  projectMapViewport: MapViewport | null;
  rightPrimaryPanelHostRef: RefObject<HTMLDivElement | null>;
  exporterPanelHostRef: RefObject<HTMLDivElement | null>;
  layout: ReturnType<typeof getDashboardLayout>;
  styles: ReturnType<typeof getDashboardStyles>;
  activeBasemapConfig: BasemapRenderConfig;
  visibleStatuses: OverlayStatusSnapshot[];
  statusDockRight: number;
  statusDockLeft?: number;
  statusDockBottom: number;
  dashboardSearchVisible: boolean;
  dashboardSearchLeft: number;
  dashboardSearchRight?: number;
  onMapReady: (map: MapboxMap) => void;
  onMapLoadStatusChange: OverlayStatusReporter;
  onMapReloadChange: OverlayReloadRegistrar;
  onMapViewportChange: (viewport: MapViewport) => void;
  onToggleMapFocusMode: () => void;
  onRestoreLeftPanel: () => void;
  onRestoreRightPanel: () => void;
  onRestoreCenterPanel: () => void;
  onCollapseLeftPanel: () => void;
  onCollapseRightPanel: () => void;
  onCollapseCenterPanel: () => void;
  /**
   * Fired the first time the active (empty) project receives traced content
   * (a placed start point or an imported route). Used to auto-reveal the
   * center analysis table and the right settings dock.
   */
  onTraceStarted: () => void;
  onLeftResizeStart: (ev: ReactMouseEvent<HTMLDivElement>) => void;
  onRightResizeStart: (ev: ReactMouseEvent<HTMLDivElement>) => void;
  onCenterResizeStart: (ev: ReactMouseEvent<HTMLDivElement>) => void;
  onProjectChange: (next: ItineraryProject) => void;
  onBackToBrowser: () => void;
  onSaveProject: (options?: { force?: boolean }) => Promise<ItineraryProject | null>;
  onOverlayReload: (id: OverlayStatusId) => void;
  onBasemapChange: (id: BasemapId) => void;
  onWeatherOverlayStatusChange: OverlayStatusReporter;
  onWeatherOverlayReloadChange: OverlayReloadRegistrar;
  onWindOverlayStatusChange: OverlayStatusReporter;
  onWindOverlayReloadChange: OverlayReloadRegistrar;
  onShadowOverlayStatusChange: OverlayStatusReporter;
  onShadowOverlayReloadChange: OverlayReloadRegistrar;
  onSunlightMapOverlayStatusChange: OverlayStatusReporter;
  onSunlightMapOverlayReloadChange: OverlayReloadRegistrar;
  onSlopeOverlayStatusChange: OverlayStatusReporter;
  onAltitudeOverlayStatusChange: OverlayStatusReporter;
  onItineraryRouteStatusChange: OverlayStatusReporter;
}

/**
 * Side-effect-only bridge: lives inside <ProjectProvider> so it can read the
 * LIVE project state, and fires `onTraceStarted` exactly once when the project
 * transitions from empty (no placed start point / no route) to having traced
 * content. That triggers the auto-reveal of the center table + right dock for
 * projects that started collapsed.
 *
 * Renders nothing.
 */
function TraceRevealWatcher({ onTraceStarted }: { onTraceStarted: () => void }) {
  const { project } = useProjectStore();
  const wasTracedRef = useRef(hasProjectTracedContent(project));

  useEffect(() => {
    const isTraced = hasProjectTracedContent(project);
    if (!wasTracedRef.current && isTraced) {
      onTraceStarted();
    }
    wasTracedRef.current = isTraced;
  }, [project, onTraceStarted]);

  return null;
}

export function DashboardEditor({
  activeProjectId,
  activeProjectInitial,
  isDemoAccount: _isDemoAccount,
  offersUrl: _offersUrl,
  isClosingProject,
  mapInstance,
  mapLoaded,
  lidarModeEnabled,
  setLidarModeEnabled,
  isAllPanelsCollapsed,
  leftPanelOpen,
  panelWidth,
  leftPanelWidth,
  isLeftPanelCollapsed,
  isRightPanelCollapsed,
  isCenterPanelCollapsed,
  isResizing,
  isLeftResizing,
  projectMapViewport,
  rightPrimaryPanelHostRef,
  exporterPanelHostRef,
  layout,
  styles,
  activeBasemapConfig,
  visibleStatuses,
  statusDockRight,
  statusDockLeft,
  statusDockBottom,
  dashboardSearchVisible,
  dashboardSearchLeft,
  dashboardSearchRight: searchRightProp,
  onMapReady,
  onMapLoadStatusChange,
  onMapReloadChange,
  onMapViewportChange,
  onToggleMapFocusMode,
  onRestoreLeftPanel,
  onRestoreRightPanel,
  onRestoreCenterPanel,
  onCollapseLeftPanel,
  onCollapseRightPanel,
  onCollapseCenterPanel,
  onTraceStarted,
  onLeftResizeStart,
  onRightResizeStart,
  onCenterResizeStart,
  onProjectChange,
  onBackToBrowser,
  onSaveProject,
  onOverlayReload,
  onBasemapChange,
  onWeatherOverlayStatusChange,
  onWeatherOverlayReloadChange,
  onWindOverlayStatusChange,
  onWindOverlayReloadChange,
  onShadowOverlayStatusChange,
  onShadowOverlayReloadChange,
  onSunlightMapOverlayStatusChange,
  onSunlightMapOverlayReloadChange,
  onSlopeOverlayStatusChange,
  onAltitudeOverlayStatusChange,
  onItineraryRouteStatusChange,
}: DashboardEditorProps) {
  const { t } = useAppI18n();
  const [dashboardSearchActiveFilters, setDashboardSearchActiveFilters] = useState<Set<DashboardFilterId>>(
    () => new Set<DashboardFilterId>(['pois_route', 'favoris', 'pauses', 'waypoints']),
  );
  const [dashboardSearchSelectedPoiCategories, setDashboardSearchSelectedPoiCategories] = useState<Set<DashboardPoiOptionId>>(
    () => new Set<DashboardPoiOptionId>(DASHBOARD_POI_OPTIONS.map((opt) => opt.id)),
  );

  const globalTimelineFilters = useMemo<TimelineFilterState>(() => {
    return {
      etape: true,
      waypoint: dashboardSearchActiveFilters.has('waypoints'),
      poi: dashboardSearchActiveFilters.has('pois_route'),
      pause: dashboardSearchActiveFilters.has('pauses'),
      favorite: dashboardSearchActiveFilters.has('favoris'),
      categories:
        dashboardSearchSelectedPoiCategories.size === DASHBOARD_POI_OPTIONS.length
          ? undefined
          : (dashboardSearchSelectedPoiCategories as Set<string>),
    };
  }, [dashboardSearchActiveFilters, dashboardSearchSelectedPoiCategories]);
  const [contextMenuOverlayContext, setContextMenuOverlayContext] = useState<MapContextMenuOverlayContext>({
    weather: {
      enabled: false,
      tab: 'forecast',
      date: '',
      time: '',
      forecastDay: 0,
      activeLayers: [],
    },
    wind: {
      enabled: false,
      date: '',
      time: '',
      forecastDay: 0,
      terrainOverlayEnabled: false,
      particlesEnabled: false,
    },
    sunlight: {
      enabled: false,
      date: '',
      time: '',
      shadowEnabled: false,
      sunlightMapEnabled: false,
    },
  });
  // Genuine, rich glassmorphism showing the blurred 3D map through panels.
  const shouldRenderPanelMapBlurMirrors = true;
  const shouldRenderToolbarMapBlurMirror = true;

  const routeSlopeLegendTitle = useMemo(() => {
    const project = activeProjectInitial;
    if (!project) return null;

    const activeSlopeItinerary = project.itineraries.find(
      (itinerary) => itinerary.id === project.activeItineraryId && itinerary.renderMode === 'slope' && itinerary.visible !== false,
    );
    const fallbackSlopeItinerary = project.itineraries.find(
      (itinerary) => itinerary.renderMode === 'slope' && itinerary.visible !== false,
    );
    const itinerary = activeSlopeItinerary ?? fallbackSlopeItinerary ?? null;
    if (!itinerary) return null;
    return `${itinerary.name} (${t('Pente').toLocaleLowerCase()})`;
  }, [activeProjectInitial, t]);

  // Bords de la carte couverts par l'interface : le menu contextuel, la fiche
  // POI et toutes les popups de la carte (`keepPopupInVisibleMap`) s'ouvrent
  // dans la carte visible — ni sous le panneau du bas, ni sous les panneaux
  // latéraux, la colonne d'outils de carte ou la barre de recherche.
  const dashboardSearchRight = searchRightProp ?? (statusDockRight + 40 + PANEL_PADDING);
  const leftInset = leftPanelOpen ? PANEL_PADDING + leftPanelWidth : 0;
  const rightInset = Math.max(isRightPanelCollapsed ? 0 : panelWidth + PANEL_PADDING, dashboardSearchRight);
  const topInset = dashboardSearchVisible ? PANEL_PADDING + DASHBOARD_SEARCH_BAR_HEIGHT : 0;
  const bottomInset = layout.centerToolbarVisible ? Math.max(0, layout.designH - layout.centerToolbarTop) : 0;
  const mapOverlayInsets = useMemo(
    () => ({ top: topInset, right: rightInset, bottom: bottomInset, left: leftInset }),
    [bottomInset, leftInset, rightInset, topInset],
  );

  const handleLidarSelectionDisable = useCallback(() => {
    setLidarModeEnabled(false);
  }, [setLidarModeEnabled]);

  const handleToggleLidarDownloadMode = useCallback(() => {
    setLidarModeEnabled((value) => !value);
  }, [setLidarModeEnabled]);



  return (
    <ProjectProvider
        key={activeProjectId ?? 'no-project'}
        initialProject={activeProjectInitial ?? undefined}
        onProjectChange={onProjectChange}
      >
        <MapView
          onMapReady={onMapReady}
          onMapLoadStatusChange={onMapLoadStatusChange}
          onMapReloadChange={onMapReloadChange}
          lidarSelectionEnabled={lidarModeEnabled}
          onLidarSelectionDisable={handleLidarSelectionDisable}
          initialViewport={projectMapViewport}
          onViewportChange={onMapViewportChange}
          basemapConfig={activeBasemapConfig}
          contextMenuOverlayContext={contextMenuOverlayContext}
          overlayInsets={mapOverlayInsets}
        />

      <MapCursorLoader
        loading={visibleStatuses.some((s) => s.id === 'itinerary' && s.state === 'loading')}
      />

      <MapOverlayStatusDock
        statuses={visibleStatuses}
        right={statusDockRight}
        left={statusDockLeft}
        bottom={statusDockBottom}
        align={statusDockLeft == null ? 'end' : 'center'}
        transform={statusDockLeft == null ? undefined : 'translateX(-50%)'}
        hidden={false}
        onReload={onOverlayReload}
      />

      <div style={styles.mapViewportControlsStyle}>
        <MapViewportControls
          map={mapInstance}
          isMapLoaded={mapLoaded}
          immersiveMode={isAllPanelsCollapsed}
          onToggleImmersiveMode={onToggleMapFocusMode}
          compact={layout.isShortCanvas}
          isRightPanelVisible={!isRightPanelCollapsed}
          onToggleRightPanel={isRightPanelCollapsed ? onRestoreRightPanel : onCollapseRightPanel}
          routeSlopeLegendTitle={routeSlopeLegendTitle}
        />
      </div>

      <DashboardPlaceSearch
        map={mapInstance}
        basemapConfig={activeBasemapConfig}
        visible={dashboardSearchVisible}
        left={dashboardSearchLeft}
        right={dashboardSearchRight}
        maxWidth={Math.max(0, layout.designW - dashboardSearchLeft - dashboardSearchRight)}
        top={PANEL_PADDING}
        isResizing={isResizing || isLeftResizing}
        activeFilters={dashboardSearchActiveFilters}
        onFilterChange={setDashboardSearchActiveFilters}
        selectedPoiCategories={dashboardSearchSelectedPoiCategories}
        onSelectedPoiCategoriesChange={setDashboardSearchSelectedPoiCategories}
        isLeftPanelCollapsed={isLeftPanelCollapsed}
        onRestoreLeftPanel={onRestoreLeftPanel}
        onCollapseLeftPanel={onCollapseLeftPanel}
      />





      {mapLoaded && shouldRenderPanelMapBlurMirrors && leftPanelOpen && (
        <MapBlurMirror
          map={mapInstance}
          top={PANEL_PADDING}
          left={PANEL_PADDING}
          width={leftPanelWidth}
          height={Math.max(0, layout.designH - PANEL_PADDING * 2)}
          blur={30}
          saturate={1.3}
          borderRadius={8}
        />
      )}
      {mapLoaded && shouldRenderPanelMapBlurMirrors && !isRightPanelCollapsed && (
        <MapBlurMirror
          map={mapInstance}
          top={PANEL_PADDING}
          left={Math.max(0, layout.designW - panelWidth - PANEL_PADDING)}
          width={panelWidth}
          height={Math.max(0, layout.designH - PANEL_PADDING * 2)}
          blur={30}
          saturate={1.3}
          borderRadius={8}
        />
      )}
      {mapLoaded && shouldRenderToolbarMapBlurMirror && layout.centerToolbarVisible && (
        <MapBlurMirror
          map={mapInstance}
          top={layout.centerToolbarTop}
          left={layout.centerToolbarLeft}
          width={layout.centerToolbarWidth}
          height={CENTER_TOOLBAR_HEIGHT}
          blur={24}
          saturate={1.2}
          borderRadius={8}
        />
      )}
      {mapLoaded && shouldRenderPanelMapBlurMirrors && layout.centerPanelVisible && (
        <MapBlurMirror
          map={mapInstance}
          top={layout.centerPanelTop}
          left={layout.centerPanelLeft}
          width={layout.centerPanelWidth}
          height={layout.centerPanelHeight}
          blur={28}
          saturate={1.2}
          borderRadius={8}
        />
      )}

      <TraceRevealWatcher onTraceStarted={onTraceStarted} />
        <RouteSplitToolProvider map={mapInstance}>
          <RouteMergeToolProvider>
            <TraceToolProvider map={mapInstance}>
              <ForbiddenZoneToolProvider map={mapInstance}>
            <RouteDragWaypointProvider map={mapInstance}>
                <PredictionProvider>
                  <div style={styles.leftPanelStyle}>
                    <div data-rv-region="left-panel" style={styles.leftPanelContentStyle}>
                      <ItineraryPanel
                        projectId={activeProjectId}
                        map={mapInstance}
                        isMapLoaded={mapLoaded}
                        onRouteStatusChange={onItineraryRouteStatusChange}
                        onRevealCenterPanel={onRestoreCenterPanel}
                        // Live drag: the panel fills its host (CSS width 100%), so the
                        // memoized panel does not re-render on every resize frame.
                        width={isLeftResizing ? undefined : leftPanelWidth}
                        onResizeStart={onLeftResizeStart}
                        isResizing={isLeftResizing}
                        isReturningToBrowser={isClosingProject}
                        onBackToHome={onBackToBrowser}
                        onSaveProject={onSaveProject}
                        pausesEnabled={dashboardSearchActiveFilters.has('pauses')}
                        waypointsEnabled={dashboardSearchActiveFilters.has('waypoints')}
                        poisRouteEnabled={dashboardSearchActiveFilters.has('pois_route')}
                        favorisEnabled={dashboardSearchActiveFilters.has('favoris')}
                        selectedPoiCategories={dashboardSearchSelectedPoiCategories as Set<string>}
                        globalFilters={globalTimelineFilters}
                      />
                    </div>
                  </div>

                  <ChartPlacementToolProvider>
                  <AnalysisFlyoverProvider map={mapInstance}>
                    {layout.centerToolbarVisible ? (
                      <div data-rv-region="center-toolbar" style={styles.centerToolbarShellStyle}>
                        <CenterPanelToolbar
                          isPanelVisible={layout.centerPanelVisible}
                          onTogglePanel={isCenterPanelCollapsed ? onRestoreCenterPanel : onCollapseCenterPanel}
                        />
                      </div>
                    ) : null}

                    {layout.centerPanelVisible ? (
                      <div
                        aria-hidden="true"
                        onMouseDown={onCenterResizeStart}
                        style={styles.centerResizeHandleStyle}
                      />
                    ) : null}

                    {layout.centerToolbarVisible ? (
                      <div data-rv-region="center-panel" style={styles.centerPanelShellStyle}>
                        <CenterPanel map={mapInstance} globalFilters={globalTimelineFilters} compact={layout.isShortCanvas} />
                      </div>
                    ) : null}
                  </AnalysisFlyoverProvider>
                  </ChartPlacementToolProvider>

                  <div style={styles.rightPanelStyle}>
                    <div data-rv-region="right-panel" style={styles.rightPanelContentStyle}>
                      <div ref={rightPrimaryPanelHostRef} style={styles.rightPrimaryPanelStyle}>
                        <ControlPanelContainer
                          map={mapInstance}
                          isMapLoaded={mapLoaded}
                          onBasemapChange={onBasemapChange}
                          onWeatherOverlayStatusChange={onWeatherOverlayStatusChange}
                          onWeatherOverlayReloadChange={onWeatherOverlayReloadChange}
                          onWindOverlayStatusChange={onWindOverlayStatusChange}
                          onWindOverlayReloadChange={onWindOverlayReloadChange}
                          onShadowOverlayStatusChange={onShadowOverlayStatusChange}
                          onShadowOverlayReloadChange={onShadowOverlayReloadChange}
                          onSunlightMapOverlayStatusChange={onSunlightMapOverlayStatusChange}
                          onSunlightMapOverlayReloadChange={onSunlightMapOverlayReloadChange}
                          onSlopeOverlayStatusChange={onSlopeOverlayStatusChange}
                          onAltitudeOverlayStatusChange={onAltitudeOverlayStatusChange}
                          lidarDownloadModeActive={lidarModeEnabled}
                          onToggleLidarDownloadMode={handleToggleLidarDownloadMode}
                          onCancelLidarSelection={handleLidarSelectionDisable}
                          width={isResizing ? '100%' : panelWidth}
                          onResizeStart={onRightResizeStart}
                          isResizing={isResizing}
                          onContextMenuOverlayContextChange={setContextMenuOverlayContext}
                        />
                      </div>
                      <div ref={exporterPanelHostRef} style={{ flex: '0 0 auto' }}>
                        <ExporterPanel width={isResizing ? '100%' : panelWidth} />
                      </div>
                    </div>
                  </div>
                </PredictionProvider>
            </RouteDragWaypointProvider>
              </ForbiddenZoneToolProvider>
            </TraceToolProvider>
          </RouteMergeToolProvider>
        </RouteSplitToolProvider>
      </ProjectProvider>
  );
}
