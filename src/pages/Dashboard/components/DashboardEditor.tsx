import type {
  Dispatch,
  MouseEvent as ReactMouseEvent,
  RefObject,
  SetStateAction,
} from 'react';
import type { Map as MapboxMap } from 'mapbox-gl';
import {
  MapBlurMirror,
  MapOverlayStatusDock,
  MapView,
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
import { TraceToolProvider } from '@/features/centerPanel/tracer';
import { ForbiddenZoneToolProvider } from '@/features/centerPanel/forbiddenZones';
import { ItineraryPanel, PredictionProvider, ProjectProvider } from '@/features/itineraryPanel';
import type { ItineraryProject } from '@/features/itineraryPanel/types';
import { IconArrowLeft } from '@/features/itineraryPanel/components/icons';
import { MapViewportControls } from '@/features/mapViewportControls';
import type { MapViewport } from '@/features/map3d/lib/viewport-persist';
import { SvgV2Icon } from '@/shared/components/SvgV2Icon';
import { DashboardPlaceSearch } from './DashboardPlaceSearch';
import { CENTER_TOOLBAR_HEIGHT, PANEL_PADDING } from '../lib/constants';
import { getDashboardStyles } from '../lib/dashboardStyles';
import { getDashboardLayout } from '../lib/layout';

interface DashboardEditorProps {
  activeProjectId: string | null;
  activeProjectInitial: ItineraryProject | null;
  isClosingProject: boolean;
  mapInstance: MapboxMap | null;
  mapLoaded: boolean;
  lidarModeEnabled: boolean;
  setLidarModeEnabled: Dispatch<SetStateAction<boolean>>;
  isMapFocusMode: boolean;
  leftPanelOpen: boolean;
  panelWidth: number;
  leftPanelWidth: number;
  isRightPanelCollapsed: boolean;
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
  onMapReady: (map: MapboxMap) => void;
  onMapLoadStatusChange: OverlayStatusReporter;
  onMapReloadChange: OverlayReloadRegistrar;
  onMapViewportChange: (viewport: MapViewport) => void;
  onToggleMapFocusMode: () => void;
  onRestoreLeftPanel: () => void;
  onRestoreRightPanel: () => void;
  onRestoreCenterPanel: () => void;
  onLeftResizeStart: (ev: ReactMouseEvent<HTMLDivElement>) => void;
  onRightResizeStart: (ev: ReactMouseEvent<HTMLDivElement>) => void;
  onCenterResizeStart: (ev: ReactMouseEvent<HTMLDivElement>) => void;
  onProjectChange: (next: ItineraryProject) => void;
  onBackToBrowser: () => void;
  onOverlayReload: (id: OverlayStatusId) => void;
  onBasemapChange: (id: BasemapId) => void;
  onWeatherOverlayStatusChange: OverlayStatusReporter;
  onWeatherOverlayReloadChange: OverlayReloadRegistrar;
  onWindOverlayStatusChange: OverlayStatusReporter;
  onWindOverlayReloadChange: OverlayReloadRegistrar;
  onShadowOverlayStatusChange: OverlayStatusReporter;
  onShadowOverlayReloadChange: OverlayReloadRegistrar;
  onSlopeOverlayStatusChange: OverlayStatusReporter;
  onAltitudeOverlayStatusChange: OverlayStatusReporter;
  onItineraryRouteStatusChange: OverlayStatusReporter;
}

export function DashboardEditor({
  activeProjectId,
  activeProjectInitial,
  isClosingProject,
  mapInstance,
  mapLoaded,
  lidarModeEnabled,
  setLidarModeEnabled,
  isMapFocusMode,
  leftPanelOpen,
  panelWidth,
  leftPanelWidth,
  isRightPanelCollapsed,
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
  onMapReady,
  onMapLoadStatusChange,
  onMapReloadChange,
  onMapViewportChange,
  onToggleMapFocusMode,
  onRestoreLeftPanel,
  onRestoreRightPanel,
  onRestoreCenterPanel,
  onLeftResizeStart,
  onRightResizeStart,
  onCenterResizeStart,
  onProjectChange,
  onBackToBrowser,
  onOverlayReload,
  onBasemapChange,
  onWeatherOverlayStatusChange,
  onWeatherOverlayReloadChange,
  onWindOverlayStatusChange,
  onWindOverlayReloadChange,
  onShadowOverlayStatusChange,
  onShadowOverlayReloadChange,
  onSlopeOverlayStatusChange,
  onAltitudeOverlayStatusChange,
  onItineraryRouteStatusChange,
}: DashboardEditorProps) {
  return (
    <>
      <MapView
        onMapReady={onMapReady}
        onMapLoadStatusChange={onMapLoadStatusChange}
        onMapReloadChange={onMapReloadChange}
        lidarSelectionEnabled={lidarModeEnabled}
        onLidarSelectionDisable={() => setLidarModeEnabled(false)}
        initialViewport={projectMapViewport}
        onViewportChange={onMapViewportChange}
        basemapConfig={activeBasemapConfig}
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
          immersiveMode={isMapFocusMode}
          onToggleImmersiveMode={onToggleMapFocusMode}
        />
      </div>

      <div style={styles.leftCollapsedRailStyle}>
        <button
          type="button"
          aria-label="Rouvrir le panneau de gauche"
          onClick={onRestoreLeftPanel}
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
          onClick={onRestoreRightPanel}
          style={styles.collapsedPanelRailButtonStyle}
        >
          <IconArrowLeft size={18} />
        </button>
      </div>

      <div style={styles.centerCollapsedRailStyle}>
        <button
          type="button"
          aria-label="Rouvrir le panneau central"
          onClick={onRestoreCenterPanel}
          style={styles.centerCollapsedRailButtonStyle}
        >
          <SvgV2Icon name="chevron-down.svg" size={18} />
        </button>
      </div>

      <DashboardPlaceSearch
        map={mapInstance}
        basemapConfig={activeBasemapConfig}
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
        onProjectChange={onProjectChange}
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
                        onRouteStatusChange={onItineraryRouteStatusChange}
                        width={leftPanelWidth}
                        onResizeStart={onLeftResizeStart}
                        isResizing={isLeftResizing}
                        isReturningToBrowser={isClosingProject}
                        onBackToHome={onBackToBrowser}
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
                        onMouseDown={onCenterResizeStart}
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
                          onBasemapChange={onBasemapChange}
                          onWeatherOverlayStatusChange={onWeatherOverlayStatusChange}
                          onWeatherOverlayReloadChange={onWeatherOverlayReloadChange}
                          onWindOverlayStatusChange={onWindOverlayStatusChange}
                          onWindOverlayReloadChange={onWindOverlayReloadChange}
                          onShadowOverlayStatusChange={onShadowOverlayStatusChange}
                          onShadowOverlayReloadChange={onShadowOverlayReloadChange}
                          onSlopeOverlayStatusChange={onSlopeOverlayStatusChange}
                          onAltitudeOverlayStatusChange={onAltitudeOverlayStatusChange}
                          lidarDownloadModeActive={lidarModeEnabled}
                          onToggleLidarDownloadMode={() => setLidarModeEnabled((value) => !value)}
                          width={panelWidth}
                          onResizeStart={onRightResizeStart}
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
  );
}
