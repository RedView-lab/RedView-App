import type {
  CSSProperties,
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
import { useAppI18n } from '@/shared/i18n';
import { DashboardPlaceSearch } from './DashboardPlaceSearch';
import { CENTER_TOOLBAR_HEIGHT, PANEL_PADDING } from '../lib/constants';
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
  isDemoAccount,
  offersUrl,
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
  const { t } = useAppI18n();
  const demoUpsellWidth = Math.min(
    330,
    Math.max(
      280,
      (layout.centerToolbarVisible
        ? layout.centerToolbarWidth
        : layout.designW - PANEL_PADDING * 2),
    ),
  );
  const demoUpsellStyle: CSSProperties = {
    position: 'absolute',
    left: layout.centerToolbarVisible ? layout.centerToolbarLeft : PANEL_PADDING,
    bottom: layout.centerToolbarVisible
      ? layout.designH - layout.centerToolbarTop + 14
      : PANEL_PADDING + 56,
    width: demoUpsellWidth,
    zIndex: 29,
    display: 'grid',
    gap: 12,
    padding: 12,
    borderRadius: 8,
    border: '1px solid rgba(255, 255, 255, 0.08)',
    background: 'rgba(0, 0, 0, 0.6)',
    color: '#ffffff',
    boxShadow: 'inset 0 1px 0 rgba(255, 255, 255, 0.04)',
    backdropFilter: 'blur(24px)',
  };

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

      {isDemoAccount ? (
        <aside style={demoUpsellStyle} aria-label={t('Découvrir les offres payantes')}>
          <p
            style={{
              margin: 0,
              fontSize: 13,
              lineHeight: 'normal',
              color: '#ffffff',
            }}
          >
            {t('Vous êtes sur une démo réduite de RedView. Pour activer l’interface, choisissez votre abonnement:')}
          </p>
          <a
            href={offersUrl}
            style={{
              minHeight: 40,
              display: 'inline-flex',
              alignItems: 'center',
              justifyContent: 'center',
              gap: 8,
              width: '100%',
              padding: '9px 10px',
              borderRadius: 6,
              background: '#890000',
              color: '#ffffff',
              textDecoration: 'none',
              fontSize: 16,
              fontWeight: 500,
            }}
          >
            <SvgV2Icon name="feedback-play.svg" size={18} />
            <span>{t('Découvrir les offres')}</span>
          </a>
        </aside>
      ) : null}

      {mapLoaded && leftPanelOpen && (
        <MapBlurMirror
          map={mapInstance}
          top={PANEL_PADDING}
          left={PANEL_PADDING}
          width={leftPanelWidth}
          height={Math.max(0, layout.designH - PANEL_PADDING * 2)}
          blur={24}
          saturate={1.05}
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
          blur={24}
          saturate={1.05}
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
