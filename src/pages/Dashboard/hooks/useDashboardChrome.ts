import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type MouseEvent as ReactMouseEvent,
} from 'react';
import type { ItineraryProject } from '@/features/itineraryPanel/types';
import { hasProjectTracedContent } from '@/features/itineraryPanel/lib/project/defaultState';
import { DEFAULT_VIEW } from '@/features/map3d/lib/mapbox.config';
import type { MapViewport } from '@/features/map3d/lib/viewport-persist';
import { readAppScaleViewport, watchAppScaleViewport } from '@/shared/lib/appScale';
import {
  CENTER_PANEL_HEIGHT_KEY,
  LEFT_PANEL_WIDTH_KEY,
  PANEL_COLLAPSE_DRAG_THRESHOLD,
  PANEL_WIDTH_KEY,
  PANEL_PADDING,
  PANEL_WIDTH_MIN_FALLBACK,
} from '../lib/constants';

import { getDashboardLayout, type SidePanelSide } from '../lib/layout';
import type { DashboardPersistedMutator } from './useDashboardProjectState';
import {
  clampLeftPanelWidth,
  clampPanelWidth,
  readStoredCenterPanelHeight,
  readStoredLeftWidth,
  readStoredWidth,
} from '../lib/utils';

interface UseDashboardChromeArgs {
  activeProjectInitial: ItineraryProject | null;
  /** Vue de l'utilisateur (panneaux, vue carte) : enregistrée à part du projet. */
  updatePersistedDashboard: (mutateDashboard: DashboardPersistedMutator) => void;
}

/**
 * Caméra avec laquelle la carte doit se monter pour un projet donné.
 *
 * Un projet qui n'a jamais été déplacé / zoomé n'a pas encore de
 * `dashboard.mapViewport` ; on amorce alors la vue large de la France
 * (`DEFAULT_VIEW`) au lieu de se replier sur l'entrée localStorage GLOBALE
 * `redview-map-viewport` — cette entrée contient encore la caméra du projet
 * *ouvert précédemment*, et c'est exactement pourquoi un tout nouveau projet
 * apparaissait sur le village du dernier projet au lieu d'un plan de la
 * France. `null` (aucun projet ouvert) laisse le hook de carte garder son
 * propre repli ; aucune carte n'est montée dans cet état de toute façon.
 */
function resolveProjectViewport(project: ItineraryProject | null): MapViewport | null {
  if (!project) return null;

  const saved = project.dashboard?.mapViewport;
  if (saved) return saved;

  return {
    center: [...DEFAULT_VIEW.center],
    zoom: DEFAULT_VIEW.zoom,
    pitch: DEFAULT_VIEW.pitch,
    bearing: DEFAULT_VIEW.bearing,
  };
}

export function useDashboardChrome({
  activeProjectInitial,
  updatePersistedDashboard,
}: UseDashboardChromeArgs) {

  const [lidarModeEnabled, setLidarModeEnabled] = useState(false);
  const [projectMapViewport, setProjectMapViewport] = useState<MapViewport | null>(
    () => resolveProjectViewport(activeProjectInitial),
  );
  const [panelWidth, setPanelWidth] = useState<number>(() => readStoredWidth());
  const [isRightPanelCollapsed, setIsRightPanelCollapsed] = useState(false);
  const [isResizing, setIsResizing] = useState(false);
  const [isLeftPanelCollapsed, setIsLeftPanelCollapsed] = useState(false);
  // Panneau gardé quand le canvas est trop étroit pour les deux (lib/layout.ts).
  const [sidePanelPriority, setSidePanelPriority] = useState<SidePanelSide>('left');
  const [leftPanelWidth, setLeftPanelWidth] = useState<number>(() =>
    readStoredLeftWidth(),
  );
  const [isLeftResizing, setIsLeftResizing] = useState(false);
  const [isCenterResizing, setIsCenterResizing] = useState(false);
  const [isCenterPanelCollapsed, setIsCenterPanelCollapsed] = useState(false);
  const [centerPanelHeightOverride, setCenterPanelHeightOverride] = useState<number | null>(
    () => readStoredCenterPanelHeight(),
  );
  const [exporterPanelHeight, setExporterPanelHeight] = useState(0);
  const [viewport, setViewport] = useState(readAppScaleViewport);

  // ── Réinitialisation de l'habillage par projet, appliquée PENDANT LE RENDU ──
  // Tout ce qui suit découle du projet actif. Le faire dans un effet
  // s'exécuterait *après* que l'éditeur — et donc sa carte Mapbox — s'est déjà
  // monté sur l'état du projet précédent : la carte serait construite sur la
  // mauvaise caméra (le bogue « un nouveau projet apparaît sur l'emplacement
  // du dernier projet ») et les panneaux ancrés s'ouvriraient l'espace d'une
  // image. Le schéma React « ajuster l'état quand une prop change » garde le
  // changement de projet et cette réinitialisation dans le même rendu : la
  // toute première image montre déjà les bonnes valeurs par défaut.
  const [chromeProject, setChromeProject] = useState(activeProjectInitial);

  if (chromeProject !== activeProjectInitial) {
    const dashboard = activeProjectInitial?.dashboard;

    setChromeProject(activeProjectInitial);
    setProjectMapViewport(resolveProjectViewport(activeProjectInitial));
    setPanelWidth(
      typeof dashboard?.rightPanelWidth === 'number'
        ? clampPanelWidth(dashboard.rightPanelWidth, PANEL_WIDTH_MIN_FALLBACK)
        : readStoredWidth(),
    );
    setLeftPanelWidth(
      typeof dashboard?.leftPanelWidth === 'number'
        ? clampLeftPanelWidth(dashboard.leftPanelWidth)
        : readStoredLeftWidth(),
    );
    setCenterPanelHeightOverride(
      typeof dashboard?.centerPanelHeight === 'number'
        ? dashboard.centerPanelHeight
        : dashboard?.centerPanelHeight === null
          ? null
          : readStoredCenterPanelHeight(),
    );
    // Sur un tout nouveau projet (vide), l'utilisateur n'a pas encore commencé
    // à tracer : on écarte donc les panneaux ancrés — le dock de réglages de
    // droite et le tableau d'analyse central restent repliés. Ils apparaissent
    // dès que le premier point de trace est posé (voir `handleTraceStarted`
    // plus bas). Le dock de gauche « feuille de route » reste ouvert — c'est là
    // que le tracé commence.
    const isEmptyProject = !hasProjectTracedContent(activeProjectInitial);
    setIsLeftPanelCollapsed(false);
    setIsCenterPanelCollapsed(isEmptyProject);
    setIsRightPanelCollapsed(isEmptyProject);
    setSidePanelPriority('left');
    setLidarModeEnabled(dashboard?.lidarDownloadModeEnabled ?? false);
  }

  const rightPrimaryPanelHostRef = useRef<HTMLDivElement | null>(null);
  const exporterPanelHostRef = useRef<HTMLDivElement | null>(null);
  const lastExpandedPanelWidthRef = useRef(panelWidth);
  const lastExpandedLeftPanelWidthRef = useRef(leftPanelWidth);
  const lastExpandedCenterPanelHeightRef = useRef<number | null>(null);
  const panelMinWidth = PANEL_WIDTH_MIN_FALLBACK;

  useEffect(() => watchAppScaleViewport(() => setViewport(readAppScaleViewport())), []);

  useEffect(() => {
    if (isRightPanelCollapsed) return;
    lastExpandedPanelWidthRef.current = panelWidth;
  }, [isRightPanelCollapsed, panelWidth]);

  useEffect(() => {
    if (isLeftPanelCollapsed) return;
    lastExpandedLeftPanelWidthRef.current = leftPanelWidth;
  }, [isLeftPanelCollapsed, leftPanelWidth]);

  useEffect(() => {
    const node = exporterPanelHostRef.current;
    if (!node || typeof ResizeObserver === 'undefined') return;

    const updateHeight = () => {
      const next = Math.round(node.getBoundingClientRect().height);
      setExporterPanelHeight((current) => (current === next ? current : next));
    };

    updateHeight();
    const observer = new ResizeObserver(() => updateHeight());
    observer.observe(node);

    return () => observer.disconnect();
  }, []);

  useEffect(() => {
    if (isResizing) return;

    try {
      localStorage.setItem(PANEL_WIDTH_KEY, String(panelWidth));
    } catch {
      // ignore
    }

    updatePersistedDashboard((dashboard) => {
      dashboard.rightPanelWidth = panelWidth;
    });
  }, [isResizing, panelWidth, updatePersistedDashboard]);

  useEffect(() => {
    if (isLeftResizing) return;

    try {
      localStorage.setItem(LEFT_PANEL_WIDTH_KEY, String(leftPanelWidth));
    } catch {
      // ignore
    }

    updatePersistedDashboard((dashboard) => {
      dashboard.leftPanelWidth = leftPanelWidth;
    });
  }, [isLeftResizing, leftPanelWidth, updatePersistedDashboard]);

  useEffect(() => {
    if (isCenterResizing) return;

    try {
      if (centerPanelHeightOverride == null) {
        localStorage.removeItem(CENTER_PANEL_HEIGHT_KEY);
      } else {
        localStorage.setItem(
          CENTER_PANEL_HEIGHT_KEY,
          String(centerPanelHeightOverride),
        );
      }
    } catch {
      // ignore
    }

    updatePersistedDashboard((dashboard) => {
      dashboard.centerPanelHeight = centerPanelHeightOverride;
    });
  }, [centerPanelHeightOverride, isCenterResizing, updatePersistedDashboard]);

  useEffect(() => {
    updatePersistedDashboard((dashboard) => {
      dashboard.lidarDownloadModeEnabled = lidarModeEnabled;
    });
  }, [lidarModeEnabled, updatePersistedDashboard]);

  useEffect(() => {
    if (!projectMapViewport) return;

    // Vue carte : vue de l'utilisateur, copie locale tout de suite et envoi
    // cloud regroupé (projectViews.ts) ; le projet n'est jamais réécrit.
    updatePersistedDashboard((dashboard) => {
      dashboard.mapViewport = structuredClone(projectMapViewport);
    });
  }, [projectMapViewport, updatePersistedDashboard]);

  const handleMapViewportChange = useCallback((nextViewport: MapViewport) => {
    setProjectMapViewport((current) => {
      if (
        current
        && current.center[0] === nextViewport.center[0]
        && current.center[1] === nextViewport.center[1]
        && current.zoom === nextViewport.zoom
        && current.pitch === nextViewport.pitch
        && current.bearing === nextViewport.bearing
      ) {
        return current;
      }

      return nextViewport;
    });
  }, []);

  const layout = getDashboardLayout({
    viewport,
    panelWidth,
    leftPanelWidth,
    exporterPanelHeight,
    centerPanelHeightOverride,
    isLeftPanelCollapsed,
    isCenterPanelCollapsed,
    isRightPanelCollapsed,
    sidePanelPriority,
  });

  useEffect(() => {
    if (isCenterPanelCollapsed) return;
    lastExpandedCenterPanelHeightRef.current = layout.centerPanelHeight;
  }, [isCenterPanelCollapsed, layout.centerPanelHeight]);

  const handleResizeStart = useCallback(
    (event: ReactMouseEvent<HTMLDivElement>) => {
      event.preventDefault();
      setIsResizing(true);
      document.body.style.cursor = 'ew-resize';
      document.body.style.userSelect = 'none';

      let rafId: number | null = null;
      let lastRaw = 0;
      let pendingCollapse = false;

      const onMove = (nextEvent: MouseEvent) => {
        const raw = layout.scaledViewportWidth - nextEvent.clientX / layout.appScale - PANEL_PADDING;
        if (raw <= panelMinWidth - PANEL_COLLAPSE_DRAG_THRESHOLD) {
          pendingCollapse = true;
        } else {
          pendingCollapse = false;
          lastRaw = raw;
        }

        if (rafId !== null) return;
        rafId = window.requestAnimationFrame(() => {
          rafId = null;
          if (pendingCollapse) {
            setIsRightPanelCollapsed(true);
          } else {
            setIsRightPanelCollapsed(false);
            setPanelWidth(clampPanelWidth(Math.min(lastRaw, layout.rightPanelMaxWidth), panelMinWidth));
          }
        });
      };

      const onUp = () => {
        if (rafId !== null) {
          window.cancelAnimationFrame(rafId);
          rafId = null;
        }
        document.body.style.cursor = '';
        document.body.style.userSelect = '';
        setIsResizing(false);
        if (pendingCollapse) {
          setIsRightPanelCollapsed(true);
        } else if (lastRaw > 0) {
          const finalW = clampPanelWidth(Math.min(lastRaw, layout.rightPanelMaxWidth), panelMinWidth);
          setPanelWidth(finalW);
          lastExpandedPanelWidthRef.current = finalW;
        }
        document.removeEventListener('mousemove', onMove);
        document.removeEventListener('mouseup', onUp);
      };

      document.addEventListener('mousemove', onMove);
      document.addEventListener('mouseup', onUp);
    },
    [layout.appScale, layout.scaledViewportWidth, layout.rightPanelMaxWidth, panelMinWidth],
  );

  const restoreRightPanel = useCallback(() => {
    const nextWidth = clampPanelWidth(lastExpandedPanelWidthRef.current, panelMinWidth);
    lastExpandedPanelWidthRef.current = nextWidth;
    setPanelWidth(nextWidth);
    setIsRightPanelCollapsed(false);
    setSidePanelPriority('right');
  }, [panelMinWidth]);

  // Callbacks stables (sans dépendance à largeur / hauteur) : lastExpanded*Ref
  // est tenu à jour par les effets ci-dessus, donc les gestionnaires de repli
  // ne changent pas d'identité à chaque image de redimensionnement et les
  // consommateurs mémoïsés (barre d'outils, contrôles de carte) ne se
  // redessinent pas.
  const collapseRightPanel = useCallback(() => {
    setIsRightPanelCollapsed(true);
  }, []);

  const handleLeftResizeStart = useCallback(
    (event: ReactMouseEvent<HTMLDivElement>) => {
      event.preventDefault();
      setIsLeftResizing(true);
      document.body.style.cursor = 'ew-resize';
      document.body.style.userSelect = 'none';

      let rafId: number | null = null;
      let lastRaw = 0;
      let pendingCollapse = false;

      const onMove = (nextEvent: MouseEvent) => {
        const raw = nextEvent.clientX / layout.appScale - PANEL_PADDING;
        if (raw <= panelMinWidth - PANEL_COLLAPSE_DRAG_THRESHOLD) {
          pendingCollapse = true;
        } else {
          pendingCollapse = false;
          lastRaw = raw;
        }

        if (rafId !== null) return;
        rafId = window.requestAnimationFrame(() => {
          rafId = null;
          if (pendingCollapse) {
            setIsLeftPanelCollapsed(true);
          } else {
            setIsLeftPanelCollapsed(false);
            setLeftPanelWidth(clampLeftPanelWidth(Math.min(lastRaw, layout.leftPanelMaxWidth)));
          }
        });
      };

      const onUp = () => {
        if (rafId !== null) {
          window.cancelAnimationFrame(rafId);
          rafId = null;
        }
        document.body.style.cursor = '';
        document.body.style.userSelect = '';
        setIsLeftResizing(false);
        if (pendingCollapse) {
          setIsLeftPanelCollapsed(true);
        } else if (lastRaw > 0) {
          const finalW = clampLeftPanelWidth(Math.min(lastRaw, layout.leftPanelMaxWidth));
          setLeftPanelWidth(finalW);
          lastExpandedLeftPanelWidthRef.current = finalW;
        }
        document.removeEventListener('mousemove', onMove);
        document.removeEventListener('mouseup', onUp);
      };

      document.addEventListener('mousemove', onMove);
      document.addEventListener('mouseup', onUp);
    },
    [layout.appScale, layout.leftPanelMaxWidth, panelMinWidth],
  );

  const restoreLeftPanel = useCallback(() => {
    const nextWidth = clampLeftPanelWidth(lastExpandedLeftPanelWidthRef.current);
    lastExpandedLeftPanelWidthRef.current = nextWidth;
    setLeftPanelWidth(nextWidth);
    setIsLeftPanelCollapsed(false);
    setSidePanelPriority('left');
  }, []);

  const collapseLeftPanel = useCallback(() => {
    setIsLeftPanelCollapsed(true);
  }, []);

  const handleCenterPanelResizeStart = useCallback(
    (event: ReactMouseEvent<HTMLDivElement>) => {
      event.preventDefault();
      setIsCenterResizing(true);
      document.body.style.cursor = 'row-resize';
      document.body.style.userSelect = 'none';

      let rafId: number | null = null;
      let finalHeight = layout.centerPanelHeight;
      let shouldCollapse = false;

      const onMove = (nextEvent: MouseEvent) => {
        const raw = layout.scaledViewportHeight - PANEL_PADDING - nextEvent.clientY / layout.appScale;

        if (raw <= layout.centerPanelMinHeight - PANEL_COLLAPSE_DRAG_THRESHOLD) {
          shouldCollapse = true;
          finalHeight = layout.centerPanelMinHeight;
        } else {
          shouldCollapse = false;
          finalHeight = Math.max(layout.centerPanelMinHeight, Math.min(layout.centerPanelMaxHeight, raw));
        }

        if (rafId !== null) return;
        rafId = window.requestAnimationFrame(() => {
          rafId = null;
          setIsCenterPanelCollapsed(false);
          setCenterPanelHeightOverride((current) => (current === finalHeight ? current : finalHeight));
        });
      };

      const onUp = () => {
        if (rafId !== null) {
          window.cancelAnimationFrame(rafId);
          rafId = null;
        }
        document.body.style.cursor = '';
        document.body.style.userSelect = '';
        document.removeEventListener('mousemove', onMove);
        document.removeEventListener('mouseup', onUp);

        if (shouldCollapse) {
          setIsCenterPanelCollapsed(true);
        } else {
          setIsCenterPanelCollapsed(false);
          setCenterPanelHeightOverride(finalHeight);
        }
        setIsCenterResizing(false);
      };

      document.addEventListener('mousemove', onMove);
      document.addEventListener('mouseup', onUp);
    },
    [layout],
  );

  const restoreCenterPanel = useCallback(() => {
    const nextHeight = lastExpandedCenterPanelHeightRef.current;
    setCenterPanelHeightOverride(nextHeight);
    setIsCenterPanelCollapsed(false);
  }, []);

  const collapseCenterPanel = useCallback(() => {
    setCenterPanelHeightOverride(lastExpandedCenterPanelHeightRef.current);
    setIsCenterPanelCollapsed(true);
  }, []);

  // « Plein écran » n'est qu'un raccourci sur les états de repli de chaque
  // panneau, jamais un verrou : il ferme tous les panneaux (ou les rouvre tous
  // quand tout est déjà fermé), et chaque panneau reste ensuite basculable
  // indépendamment.
  const isAllPanelsCollapsed =
    isLeftPanelCollapsed &&
    isRightPanelCollapsed &&
    (isCenterPanelCollapsed || !layout.centerToolbarVisible);

  const handleToggleMapFocusMode = useCallback(() => {
    if (isAllPanelsCollapsed) {
      // Gauche en dernier : il garde la priorité sur un canvas trop étroit pour les deux.
      restoreRightPanel();
      restoreLeftPanel();
      restoreCenterPanel();
      return;
    }

    collapseLeftPanel();
    collapseRightPanel();
    collapseCenterPanel();
  }, [
    isAllPanelsCollapsed,
    restoreLeftPanel,
    restoreRightPanel,
    restoreCenterPanel,
    collapseLeftPanel,
    collapseRightPanel,
    collapseCenterPanel,
  ]);

  // Fait apparaître le tableau d'analyse central la première fois que
  // l'utilisateur pose un point de trace sur un projet parti vide. Idempotent :
  // sans effet si le panneau est déjà ouvert (p. ex. un projet existant, ou
  // l'utilisateur l'a déjà déplié à la main).
  const handleTraceStarted = useCallback(() => {
    setIsCenterPanelCollapsed((current) => {
      if (!current) return current;
      restoreCenterPanel();
      return false;
    });
  }, [restoreCenterPanel]);

  return {
    lidarModeEnabled,
    setLidarModeEnabled,
    isAllPanelsCollapsed,
    // Largeurs et états de repli des panneaux latéraux tels que rendus (ajustés
    // au canvas, voir resolveSidePanels) ; les préférences de l'utilisateur
    // restent dans l'état et dans le tableau de bord persisté.
    leftPanelOpen: !layout.isLeftPanelCollapsed,
    panelWidth: layout.rightPanelWidth,
    isLeftPanelCollapsed: layout.isLeftPanelCollapsed,
    isCenterPanelCollapsed,
    isRightPanelCollapsed: layout.isRightPanelCollapsed,
    leftPanelWidth: layout.leftPanelWidth,
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
  };
}