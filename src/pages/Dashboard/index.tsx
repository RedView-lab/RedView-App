import { lazy, Suspense, useCallback, useEffect, useLayoutEffect, useRef, useState, type PointerEvent } from 'react';
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
import { useDashboardChrome } from './hooks/useDashboardChrome';
import { useDashboardProjectState } from './hooks/useDashboardProjectState';
import { formatDisplayName } from './lib/utils';
import { EditorReadyMeter } from './lib/editorReadyMeter';
import { countBucket, roundTo, trackAnalyticsEvent, trackScreen } from '@/shared/lib/analytics';
import { trackNavigationImport } from '@/shared/lib/staleBuild';
import { loadDashboardEditor, prefetchDashboardEditor, prefetchDashboardEditorWhenIdle } from './editorLoader';

// Éditeur 3D chargé à la demande : le gestionnaire de projets s'affiche sans
// lui (carte, LiDAR, panneaux). Préchargé dès qu'un projet est visé.
const DashboardEditor = lazy(() => trackNavigationImport(loadDashboardEditor()).then((module) => ({ default: module.DashboardEditor })));

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
  /**
   * La carte pour les closures (écrite avec l'état, lue à sa place) : aucune
   * closure de ce composant ne doit capturer `mapInstance`. V8 donne à toutes
   * les closures d'un même rendu un seul contexte partagé, donc une closure
   * gardée par l'effet d'un enfant dont les dépendances n'avaient pas changé
   * (le `onRequestClose` en ligne du gestionnaire de projets) retenait la
   * dernière carte Mapbox retirée après la fermeture de l'éditeur
   * (`bench:dashboard -- --scenario leak`).
   */
  const mapInstanceRef = useRef<MapboxMap | null>(null);
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
    activeProjectShared,
    isClosingProject,
    projectLoading,
    projectBrowserOpen,
    setProjectBrowserOpen,
    handleOpenProject,
    handleBackToBrowser,
    handleProjectChange,
    handleSaveProject,
    updatePersistedDashboard,
    getActiveProjectSnapshot,
  } = useDashboardProjectState({
    initialProjectId,
    mapInstanceRef,
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

  // Rend les canvas (Mapbox, graphiques) à la résolution de l'écran malgré
  // l'échelle du canvas (`appScaleStyle`). Effet de layout : s'exécute avant
  // que l'effet passif de useMap crée la carte. La taille logique peut rester
  // constante pendant que appScale change (redimensionnement proportionnel de
  // la fenêtre), d'où un redimensionnement forcé de la carte.
  useLayoutEffect(() => {
    setDprLayoutScale(layout.appScale);
    mapInstanceRef.current?.resize();
  }, [layout.appScale, mapInstance]);

  // Reflète l'échelle sur :root pour les surcouches rendues en portail dans
  // <body> (hors du canvas mis à l'échelle) qui doivent garder la densité du
  // tableau de bord : `.rv-app-scaled-layer` dans src/index.css,
  // `appScaledOverlayStyle` dans shared/lib/appScale.ts.
  useLayoutEffect(() => publishRootAppScale(layout.appScale), [layout.appScale]);

  const handleMapReady = useCallback((map: MapboxMap) => {
    mapInstanceRef.current = map;
    setMapInstance(map);
    setMapLoaded(true);
  }, []);

  const rightDockWidth = isRightPanelCollapsed
    ? 0
    : panelWidth + PANEL_PADDING * 2;
  const rightDockOffset = isRightPanelCollapsed
    ? PANEL_PADDING
    : rightDockWidth + PANEL_PADDING;

  // Canvas court : le dock d'état ne tient plus sous les outils de la carte
  // dans la hauteur de la scène de carte, il passe à côté d'eux.
  const statusDockRight = layout.isShortCanvas
    ? rightDockOffset + layout.mapToolsWidth + PANEL_PADDING
    : rightDockOffset;
  const statusDockBottom = layout.centerToolbarVisible
    ? layout.designH - layout.centerToolbarTop + CENTER_PANEL_STACK_GAP
    : 88;

  const leftDockWidth = isLeftPanelCollapsed
    ? 0
    : leftPanelWidth + PANEL_PADDING * 2;

  // L'enveloppe de recherche commence juste après le tiroir de gauche et porte
  // la bascule de panneau en miroir comme premier enfant flex, si bien que la
  // ligne se lit :
  // [ tiroir ] PANEL_PADDING [ bascule ] PANEL_PADDING [ barre de recherche ]
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
  // Plein écran : gestionnaire de projets -> page de chargement -> éditeur 3D.
  // On garde le gestionnaire monté dessous pendant le chargement d'un projet
  // pour que son état survive à la transition, mais la page de chargement le
  // couvre entièrement.
  const loadingProject = projectLoading || isClosingProject;
  const projectBrowserVisible = (projectBrowserOpen || activeProjectId == null) && !loadingProject;

  // Éditeur fermé : plus de carte.
  if (!editorOpen && (mapLoaded || mapInstance)) {
    setMapLoaded(false);
    setMapInstance(null);
  }
  useEffect(() => {
    if (!editorOpen) mapInstanceRef.current = null;
  }, [editorOpen]);

  // Projet en cours d'ouverture (lien direct compris) : l'éditeur se charge
  // en parallèle du projet. Gestionnaire affiché : préchargement au repos.
  useEffect(() => {
    if (activeProjectId != null) prefetchDashboardEditor();
  }, [activeProjectId]);

  // Mesure d'audience : écran éditeur, et temps jusqu'à la première carte 3D
  // prête (`editor_ready` ; lien direct mesuré depuis la navigation).
  const [editorReadyMeter] = useState(() => new EditorReadyMeter());
  // Projet du lien direct au chargement de la page (la prop suit ensuite l'URL).
  const [bootProjectId] = useState(initialProjectId ?? null);
  const firstProjectOpenRef = useRef(true);
  useEffect(() => {
    if (activeProjectId == null) {
      editorReadyMeter.cancel();
      return;
    }
    const cold = firstProjectOpenRef.current && activeProjectId === bootProjectId;
    firstProjectOpenRef.current = false;
    editorReadyMeter.start(performance.now(), cold);
  }, [activeProjectId, bootProjectId, editorReadyMeter]);
  useEffect(() => {
    const onVisibility = () => {
      if (document.visibilityState === 'hidden') editorReadyMeter.markHidden();
    };
    document.addEventListener('visibilitychange', onVisibility);
    return () => document.removeEventListener('visibilitychange', onVisibility);
  }, [editorReadyMeter]);
  const activeItineraryCount = activeProjectInitial?.itineraries?.length ?? 0;
  const handleMapLoadStatusChangeMeasured = useCallback<typeof handleMapLoadStatusChange>((status) => {
    handleMapLoadStatusChange(status);
    const sample = editorReadyMeter.observe(status?.state, performance.now());
    if (sample) {
      trackAnalyticsEvent({
        name: 'editor_ready',
        data: { ms: roundTo(sample.ms, 100), cold: sample.cold, itineraries: countBucket(activeItineraryCount) },
      });
    }
  }, [activeItineraryCount, editorReadyMeter, handleMapLoadStatusChange]);
  useEffect(() => {
    if (editorOpen && !loadingProject) trackScreen('editor');
  }, [editorOpen, loadingProject]);
  useEffect(() => {
    if (!projectBrowserVisible) return;
    return prefetchDashboardEditorWhenIdle();
  }, [projectBrowserVisible]);

  return (
    <LidarProvider>
      {/* `clip`, pas `hidden` : une boîte cachée peut encore défiler par code
          (scrollIntoView, focus()) et décalerait toute l'interface vers le
          haut, en rendant son haut inaccessible. Une boîte clip ne défile jamais. */}
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
            // 1:1 jusqu'à la référence de conception, croissance douce au-delà
            // avec le `zoom` CSS (texte mis en page à sa taille finale, jamais
            // rééchantillonné).
            ...appScaleStyle(layout.appScale),
            // Canvas logique : `@container rv-canvas (...)` et les tailles
            // --rv-canvas-* remplacent les media queries de fenêtre et les
            // unités vw / vh, qui mesurent le vrai écran (src/index.css).
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
              activeProjectShared={activeProjectShared}
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
              onMapLoadStatusChange={handleMapLoadStatusChangeMeasured}
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
              getProjectSnapshot={getActiveProjectSnapshot}
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