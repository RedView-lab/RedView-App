import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type MouseEvent as ReactMouseEvent,
} from 'react';
import type { ItineraryProject } from '@/features/itineraryPanel/types';
import { hasProjectTracedContent } from '@/features/itineraryPanel/lib/project';
import { DEFAULT_VIEW } from '@/features/map3d/lib/mapbox.config';
import type { MapViewport } from '@/features/map3d/lib/viewport-persist';
import {
  CENTER_PANEL_HEIGHT_KEY,
  LEFT_PANEL_WIDTH_KEY,
  PANEL_COLLAPSE_DRAG_THRESHOLD,
  PANEL_WIDTH_KEY,
  PANEL_PADDING,
  PANEL_WIDTH_MIN_FALLBACK,
} from './lib/constants';

import { getDashboardLayout, type SidePanelSide } from './lib/layout';
import type { DashboardPersistedMutator, DashboardPersistOptions } from './useDashboardProjectState';
import {
  clampLeftPanelWidth,
  clampPanelWidth,
  readStoredCenterPanelHeight,
  readStoredLeftWidth,
  readStoredWidth,
} from './lib/utils';

interface UseDashboardChromeArgs {
  activeProjectInitial: ItineraryProject | null;
  updatePersistedDashboard: (
    mutateDashboard: DashboardPersistedMutator,
    options?: DashboardPersistOptions,
  ) => void;
}

/**
 * Camera the map must mount with for a given project.
 *
 * A project that has never been panned/zoomed has no `dashboard.mapViewport`
 * yet; we then seed the wide-France overview (`DEFAULT_VIEW`) instead of
 * falling back to the GLOBAL `redview-map-viewport` localStorage entry — that
 * entry still holds the camera of the *previously opened* project, which is
 * exactly why a brand-new project used to spawn on the last project's village
 * instead of a France-wide plan. `null` (no project open) lets the map hook
 * keep its own fallback; no map is mounted in that state anyway.
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
  // Panel kept when the canvas is too narrow for both (lib/layout.ts).
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
  const [viewport, setViewport] = useState(() => ({
    w: window.innerWidth,
    h: window.innerHeight,
  }));

  // ── Per-project chrome reset, applied DURING RENDER ────────────────────
  // Everything below is derived from the active project. Doing this in an
  // effect would run *after* the editor — and therefore its Mapbox map — has
  // already mounted on the previous project's state: the map would be
  // constructed on the wrong camera (the "new project spawns on the last
  // project's location" bug) and the docked panels would flash open for a
  // frame. React's "adjusting state when a prop changes" pattern keeps the
  // project switch and this reset in the same render, so the very first frame
  // already shows the correct defaults.
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
    // On a brand-new (empty) project the user hasn't started tracing yet, so we
    // keep the docked panels out of the way: the right settings dock and the
    // center analysis table stay collapsed. They reveal themselves as soon as
    // the first trace point lands (see `handleTraceStarted` below). The left
    // "feuille de route" dock stays open — that's where tracing starts.
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

  useEffect(() => {
    const onResize = () => {
      setViewport({ w: window.innerWidth, h: window.innerHeight });
    };

    window.addEventListener('resize', onResize);
    return () => window.removeEventListener('resize', onResize);
  }, []);

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

    // Vue carte : cache local seulement, incluse dans la prochaine vraie sauvegarde
    // (un déplacement de carte ne déclenche plus de sauvegarde cloud à lui seul).
    updatePersistedDashboard((dashboard) => {
      dashboard.mapViewport = structuredClone(projectMapViewport);
    }, { localOnly: true });
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

  // Stable callbacks (no width/height deps): lastExpanded*Ref is kept in sync by
  // the effects above, so collapse handlers don't change identity on every
  // resize frame and memoized consumers (toolbar, map controls) don't re-render.
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

  // "Plein écran" is only a shortcut over the per-panel collapse states, never
  // a lock: it closes every panel (or reopens them all when everything is
  // already closed), and each panel stays independently toggleable afterwards.
  const isAllPanelsCollapsed =
    isLeftPanelCollapsed &&
    isRightPanelCollapsed &&
    (isCenterPanelCollapsed || !layout.centerToolbarVisible);

  const handleToggleMapFocusMode = useCallback(() => {
    if (isAllPanelsCollapsed) {
      // Left last: it keeps the priority on a canvas too narrow for both.
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

  // Auto-reveal the center analysis table the first time
  // the user drops a trace point on a project that started empty. Idempotent:
  // no-op if the panel is already open (e.g. an existing project, or the user
  // already expanded it manually).
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
    // Widths and side-panel collapse states as rendered (fitted to the canvas,
    // see resolveSidePanels); the user's preferences stay in state and in the
    // persisted dashboard.
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