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
import { RouteMergeToolProvider, useRouteMergeToolOptional } from '@/features/centerPanel/routeMerge';
import { RouteSplitToolProvider, useRouteSplitToolOptional } from '@/features/centerPanel/routeSplit';
import { ChartPlacementToolProvider, useChartPlacementToolOptional } from '@/features/centerPanel/chartPlacement';
import { RouteDragWaypointProvider } from '@/features/centerPanel/routeDragWaypoint';
import { TraceToolProvider, useTraceToolOptional } from '@/features/centerPanel/tracer';
import { ForbiddenZoneToolProvider, useForbiddenZoneToolOptional } from '@/features/centerPanel/forbiddenZones';
import {
  CommentShortcuts,
  CommentsPanel,
  CommentToolProvider,
  MapCommentsLayer,
  readCommentAuthor,
  useCommentToolOptional,
} from '@/features/comments';
import { useProjectShare } from '@/features/projectBrowser/queries/projectSharing';
import { ItineraryPanel, PredictionProvider, ProjectProvider, useProjectStore } from '@/features/itineraryPanel';
import { useMultiplayerAvailable } from '@/features/collab/queries/multiplayerHealth';
import { useCollabSession } from '@/features/collab/hooks/useCollabSession';
import type {
  CollaboratorAction,
  ItineraryProject,
  ProjectCollaborator,
  ProjectSessionStatus,
} from '@/features/itineraryPanel/types';
import { FollowingFrame, LivePresenceBridge, LivePresenceContext, useLivePresence } from '@/features/livePresence';
import { ShareProjectDialog } from '@/features/projectBrowser/components/projects/ShareProjectDialog';
import { useAppI18n } from '@/shared/i18n';
import { getSessionUserIdSync } from '@/shared/services/appwrite';
import { notify } from '@/shared/lib/notify';
import { hasProjectTracedContent } from '@/features/itineraryPanel/lib/project';
import { MapViewportControls } from '@/features/mapViewportControls';
import type { MapViewport } from '@/features/map3d/lib/viewport-persist';
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
  /** Projet partagé : co-édition en temps réel. */
  activeProjectShared: boolean;
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
  /** État complet du projet ouvert (vue carte et panneaux compris), pour l'export `.redview`. */
  getProjectSnapshot: () => ItineraryProject | null;
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
/**
 * Raccourcis des commentaires (C, Maj+C, Échap), placés sous les outils de la
 * carte : armer le mode commentaire désarme Tracer, Découper, Fusionner,
 * Interdire et Ajouter (un seul outil consomme les clics de la carte).
 */
function CommentShortcutsBridge() {
  const trace = useTraceToolOptional();
  const split = useRouteSplitToolOptional();
  const merge = useRouteMergeToolOptional();
  const forbidden = useForbiddenZoneToolOptional();
  const placement = useChartPlacementToolOptional();
  const handleBeforeArm = useCallback(() => {
    placement?.deactivate();
    merge?.deactivate();
    split?.deactivate();
    trace?.deactivate();
    forbidden?.deactivate();
  }, [forbidden, merge, placement, split, trace]);
  return <CommentShortcuts onBeforeArm={handleBeforeArm} />;
}

/**
 * Mode commentaire : la liste des commentaires prend la place du panneau droit
 * (la barre latérale de Figma). Le panneau reste monté dessous (ses couches de
 * carte restent actives) mais inerte ; replié, il s'ouvre pour la liste et se
 * replie de nouveau à la sortie du mode.
 */
function CommentModeRightPanel({
  contentRef,
  panelWidth,
  isCollapsed,
  onRestore,
  onCollapse,
}: {
  contentRef: RefObject<HTMLDivElement | null>;
  panelWidth: number;
  isCollapsed: boolean;
  onRestore: () => void;
  onCollapse: () => void;
}) {
  const armed = useCommentToolOptional()?.armed ?? false;

  // Monté (ses couches de carte restent actives) mais ni visible sous la liste en verre, ni atteignable.
  useEffect(() => {
    const content = contentRef.current;
    if (!content || !armed) return;
    content.inert = true;
    content.style.visibility = 'hidden';
    return () => {
      content.inert = false;
      content.style.visibility = '';
    };
  }, [armed, contentRef]);

  const previousArmedRef = useRef(armed);
  const openedForCommentsRef = useRef(false);
  useEffect(() => {
    const wasArmed = previousArmedRef.current;
    previousArmedRef.current = armed;
    if (armed && !wasArmed && isCollapsed) {
      openedForCommentsRef.current = true;
      onRestore();
    } else if (!armed && wasArmed && openedForCommentsRef.current) {
      openedForCommentsRef.current = false;
      if (!isCollapsed) onCollapse();
    }
  }, [armed, isCollapsed, onCollapse, onRestore]);

  if (!armed) return null;
  return <CommentsPanel style={{ top: PANEL_PADDING, right: PANEL_PADDING, bottom: PANEL_PADDING, width: panelWidth }} />;
}

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
  activeProjectShared,
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
  getProjectSnapshot,
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

  // Co-édition (projet partagé, ou `?collab=server` en développement) : pas de lien sans session.
  // Un projet partagé depuis cet écran passe en session après sa première invitation.
  const [sharedNowProjectId, setSharedNowProjectId] = useState<string | null>(null);
  const collabSession = useCollabSession(
    activeProjectId,
    getProjectSnapshot,
    activeProjectShared || (activeProjectId !== null && sharedNowProjectId === activeProjectId),
  );
  const { t } = useAppI18n();
  const collabState = collabSession.state;
  // Refus définitif : on le dit ; sans accès (retiré, projet supprimé), retour aux projets.
  const deniedReason = collabState?.status === 'denied' ? collabState.deniedReason ?? 'forbidden' : null;
  useEffect(() => {
    if (!deniedReason) return;
    switch (deniedReason) {
      case 'not-found':
        notify.error('Ce projet a été supprimé.');
        onBackToBrowser();
        break;
      case 'forbidden':
        notify.error('Vous n’avez plus accès à ce projet.');
        onBackToBrowser();
        break;
      case 'version':
        notify.info('Une nouvelle version de RedView est disponible : rechargez la page pour continuer à modifier ce projet partagé.');
        break;
      case 'unauthorized':
        notify.error('Session expirée : reconnectez-vous pour continuer à modifier ce projet partagé.');
        break;
    }
  }, [deniedReason, onBackToBrowser]);
  // Session refusée pour une raison passagère (version, session expirée) : les
  // modifications restent sur l'appareil, comme hors ligne.
  const sessionStatus: ProjectSessionStatus | undefined = collabState
    ? collabState.status === 'denied' ? 'offline' : collabState.status
    : collabSession.pending ? 'connecting' : undefined;
  const collabPeers = collabSession.state?.peers;
  // Présence en direct (comme Figma) : curseurs sur la carte, suivre un éditeur, présenter sa vue.
  const livePresence = useLivePresence({ map: mapInstance, realtime: collabSession.realtime, collabState });
  const selfUserId = collabState?.self?.userId ?? null;
  const collaborators = useMemo<ProjectCollaborator[] | undefined>(() => {
    if (!collabPeers) return undefined;
    const byUser = new Map<string, ProjectCollaborator>();
    for (const peer of collabPeers) {
      if (byUser.has(peer.userId)) continue;
      const isSelf = peer.userId === selfUserId;
      byUser.set(peer.userId, {
        userId: peer.userId,
        name: peer.presence.name || t('Éditeur'),
        isSelf,
        followed: isSelf ? !!livePresence?.presenting : livePresence?.following?.userId === peer.userId,
        presenting: !isSelf && !!livePresence?.peers.some((live) => live.userId === peer.userId && live.spotlight !== null),
        followsMe: !isSelf && !!livePresence?.followers.some((live) => live.userId === peer.userId),
      });
    }
    return [...byUser.values()];
  }, [collabPeers, livePresence, selfUserId, t]);
  const followUser = livePresence?.followUser;
  const stopFollowing = livePresence?.stopFollowing;
  const setPresenting = livePresence?.setPresenting;
  const handleCollaboratorAction = useCallback((userId: string, action: CollaboratorAction) => {
    switch (action) {
      case 'follow':
        followUser?.(userId);
        break;
      case 'unfollow':
        stopFollowing?.();
        break;
      case 'spotlight-start':
        setPresenting?.(true);
        break;
      case 'spotlight-stop':
        setPresenting?.(false);
        break;
    }
  }, [followUser, setPresenting, stopFollowing]);

  // Partager (comme Figma) : projets du cloud seulement (pas les projets locaux du compte démo).
  const [shareAnchor, setShareAnchor] = useState<HTMLElement | null>(null);
  // … et seulement quand le serveur temps réel répond (c'est lui qui enregistre un projet partagé).
  const multiplayerAvailable = useMultiplayerAvailable();
  const canShare = multiplayerAvailable && activeProjectId !== null && !activeProjectId.startsWith('local-');
  const handleShareProject = useCallback((anchor: HTMLElement) => setShareAnchor(anchor), []);
  // Avant la première invitation, le document part au cloud : le serveur temps
  // réel ouvrira la salle à partir de lui (ensuite, plus aucune écriture cloud ici).
  const handleBeforeFirstShare = useCallback(async () => {
    await onSaveProject().catch(() => null);
  }, [onSaveProject]);
  const handleProjectShared = useCallback(() => {
    if (activeProjectId) setSharedNowProjectId(activeProjectId);
  }, [activeProjectId]);

  // Commentaires : auteur de la session ; membres du projet partagé (mentions, noms) et éditeurs présents.
  const [commentAuthor] = useState(readCommentAuthor);
  const isSharedProject = activeProjectShared || (activeProjectId !== null && sharedNowProjectId === activeProjectId);
  const projectShare = useProjectShare(isSharedProject ? activeProjectId : null);
  const shareMembers = projectShare.data?.members;
  const commentMembers = useMemo(() => [
    ...(shareMembers ?? []).map((member) => ({ userId: member.userId, name: member.name || member.email })),
    ...(collaborators ?? []),
  ], [collaborators, shareMembers]);
  const rightPanelContentRef = useRef<HTMLDivElement>(null);

  return (
    <ProjectProvider
        key={activeProjectId ?? 'no-project'}
        initialProject={activeProjectInitial ?? undefined}
        onProjectChange={onProjectChange}
        collab={collabSession.link}
        collabPending={collabSession.pending}
      >
      <LivePresenceContext.Provider value={livePresence}>
      <LivePresenceBridge />
      <CommentToolProvider map={mapInstance} projectId={activeProjectId} me={commentAuthor} members={commentMembers}>
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

      <MapCommentsLayer map={mapInstance} overlayInsets={mapOverlayInsets} />

      <FollowingFrame insets={mapOverlayInsets} />

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
        />
      </div>

      {shareAnchor && activeProjectId ? (
        <ShareProjectDialog
          projectId={activeProjectId}
          projectName={getProjectSnapshot()?.name ?? activeProjectInitial?.name ?? ''}
          sharedWithMe={activeProjectShared}
          anchorEl={shareAnchor}
          userId={getSessionUserIdSync()}
          onClose={() => setShareAnchor(null)}
          onBeforeFirstShare={handleBeforeFirstShare}
          onShared={handleProjectShared}
          onLeft={onBackToBrowser}
        />
      ) : null}

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
                        onShareProject={canShare ? handleShareProject : undefined}
                        collaborators={collaborators}
                        onCollaboratorAction={livePresence ? handleCollaboratorAction : undefined}
                        sessionStatus={sessionStatus}
                        pausesEnabled={dashboardSearchActiveFilters.has('pauses')}
                        waypointsEnabled={dashboardSearchActiveFilters.has('waypoints')}
                        poisRouteEnabled={dashboardSearchActiveFilters.has('pois_route')}
                        favorisEnabled={dashboardSearchActiveFilters.has('favoris')}
                        selectedPoiCategories={dashboardSearchSelectedPoiCategories as Set<string>}
                        globalFilters={globalTimelineFilters}
                      />
                    </div>
                  </div>

                  {/* Le flyover couvre aussi le panneau de droite : l'export vidéo y lit la trace et le palier de vitesse. */}
                  <AnalysisFlyoverProvider map={mapInstance}>
                  <ChartPlacementToolProvider>
                    <CommentShortcutsBridge />
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
                  </ChartPlacementToolProvider>

                  <div style={styles.rightPanelStyle}>
                    <div ref={rightPanelContentRef} data-rv-region="right-panel" style={styles.rightPanelContentStyle}>
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
                        <ExporterPanel
                          width={isResizing ? '100%' : panelWidth}
                          projectId={activeProjectId}
                          map={mapInstance}
                          getProjectSnapshot={getProjectSnapshot}
                        />
                      </div>
                    </div>
                    <CommentModeRightPanel
                      contentRef={rightPanelContentRef}
                      panelWidth={panelWidth}
                      isCollapsed={isRightPanelCollapsed}
                      onRestore={onRestoreRightPanel}
                      onCollapse={onCollapseRightPanel}
                    />
                  </div>
                  </AnalysisFlyoverProvider>
                </PredictionProvider>
            </RouteDragWaypointProvider>
              </ForbiddenZoneToolProvider>
            </TraceToolProvider>
          </RouteMergeToolProvider>
        </RouteSplitToolProvider>
      </CommentToolProvider>
      </LivePresenceContext.Provider>
      </ProjectProvider>
  );
}
