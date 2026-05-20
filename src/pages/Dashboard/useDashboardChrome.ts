import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type MouseEvent as ReactMouseEvent,
} from 'react';
import type { ItineraryProject } from '@/features/itineraryPanel/types';
import { loadViewport, type MapViewport } from '@/features/map3d/lib/viewport-persist';
import {
  CENTER_PANEL_HEIGHT_KEY,
  LEFT_PANEL_WIDTH_KEY,
  PANEL_COLLAPSE_DRAG_THRESHOLD,
  PANEL_WIDTH_KEY,
  PANEL_PADDING,
  PANEL_WIDTH_MIN_FALLBACK,
} from './lib/constants';

import { getDashboardLayout } from './lib/layout';
import type { DashboardPersistedMutator } from './useDashboardProjectState';
import {
  clampLeftPanelWidth,
  clampPanelWidth,
  readStoredCenterPanelHeight,
  readStoredLeftWidth,
  readStoredWidth,
} from './lib/utils';

interface UseDashboardChromeArgs {
  activeProjectInitial: ItineraryProject | null;
  updatePersistedDashboard: (mutateDashboard: DashboardPersistedMutator) => void;
}

export function useDashboardChrome({
  activeProjectInitial,
  updatePersistedDashboard,
}: UseDashboardChromeArgs) {

  const [lidarModeEnabled, setLidarModeEnabled] = useState(false);
  const [isMapFocusMode, setIsMapFocusMode] = useState(false);
  const [projectMapViewport, setProjectMapViewport] = useState<MapViewport | null>(
    () => loadViewport(),
  );
  const [panelWidth, setPanelWidth] = useState<number>(() => readStoredWidth());
  const [isRightPanelCollapsed, setIsRightPanelCollapsed] = useState(false);
  const [isResizing, setIsResizing] = useState(false);
  const [isLeftPanelCollapsed, setIsLeftPanelCollapsed] = useState(false);
  const leftPanelOpen = !isMapFocusMode && !isLeftPanelCollapsed;
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
    const dashboard = activeProjectInitial?.dashboard;

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
    setIsLeftPanelCollapsed(false);
    setIsCenterPanelCollapsed(false);
    setIsRightPanelCollapsed(false);
    setLidarModeEnabled(dashboard?.lidarDownloadModeEnabled ?? false);
    setProjectMapViewport(dashboard?.mapViewport ?? loadViewport());
  }, [activeProjectInitial]);

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
    try {
      localStorage.setItem(PANEL_WIDTH_KEY, String(panelWidth));
    } catch {
      // ignore
    }

    updatePersistedDashboard((dashboard) => {
      dashboard.rightPanelWidth = panelWidth;
    });
  }, [panelWidth, updatePersistedDashboard]);

  useEffect(() => {
    try {
      localStorage.setItem(LEFT_PANEL_WIDTH_KEY, String(leftPanelWidth));
    } catch {
      // ignore
    }

    updatePersistedDashboard((dashboard) => {
      dashboard.leftPanelWidth = leftPanelWidth;
    });
  }, [leftPanelWidth, updatePersistedDashboard]);

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
    isMapFocusMode,
    isLeftPanelCollapsed,
    isCenterPanelCollapsed,
    isRightPanelCollapsed,
  });

  useEffect(() => {
    if (isCenterPanelCollapsed) return;
    lastExpandedCenterPanelHeightRef.current = layout.centerPanelHeight;
  }, [isCenterPanelCollapsed, layout.centerPanelHeight]);

  const handleResizeStart = useCallback(
    (event: ReactMouseEvent<HTMLDivElement>) => {
      event.preventDefault();
      setIsResizing(true);

      const onMove = (nextEvent: MouseEvent) => {
        const raw = layout.scaledViewportWidth - nextEvent.clientX / layout.appScale - PANEL_PADDING;
        if (raw <= panelMinWidth - PANEL_COLLAPSE_DRAG_THRESHOLD) {
          setIsRightPanelCollapsed(true);
          return;
        }

        setIsRightPanelCollapsed(false);
        setPanelWidth(clampPanelWidth(raw, panelMinWidth));
      };
      const onUp = () => {
        setIsResizing(false);
        document.removeEventListener('mousemove', onMove);
        document.removeEventListener('mouseup', onUp);
      };

      document.addEventListener('mousemove', onMove);
      document.addEventListener('mouseup', onUp);
    },
    [layout.appScale, layout.scaledViewportWidth, panelMinWidth],
  );

  const restoreRightPanel = useCallback(() => {
    const nextWidth = clampPanelWidth(lastExpandedPanelWidthRef.current, panelMinWidth);
    lastExpandedPanelWidthRef.current = nextWidth;
    setPanelWidth(nextWidth);
    setIsRightPanelCollapsed(false);
  }, [panelMinWidth]);

  const handleLeftResizeStart = useCallback(
    (event: ReactMouseEvent<HTMLDivElement>) => {
      event.preventDefault();
      setIsLeftResizing(true);

      const onMove = (nextEvent: MouseEvent) => {
        const raw = nextEvent.clientX / layout.appScale - PANEL_PADDING;
        if (raw <= panelMinWidth - PANEL_COLLAPSE_DRAG_THRESHOLD) {
          setIsLeftPanelCollapsed(true);
          return;
        }

        setIsLeftPanelCollapsed(false);
        setLeftPanelWidth(clampLeftPanelWidth(raw));
      };
      const onUp = () => {
        setIsLeftResizing(false);
        document.removeEventListener('mousemove', onMove);
        document.removeEventListener('mouseup', onUp);
      };

      document.addEventListener('mousemove', onMove);
      document.addEventListener('mouseup', onUp);
    },
    [layout.appScale, panelMinWidth],
  );

  const restoreLeftPanel = useCallback(() => {
    const nextWidth = clampLeftPanelWidth(lastExpandedLeftPanelWidthRef.current);
    lastExpandedLeftPanelWidthRef.current = nextWidth;
    setLeftPanelWidth(nextWidth);
    setIsLeftPanelCollapsed(false);
  }, []);

  const handleCenterPanelResizeStart = useCallback(
    (event: ReactMouseEvent<HTMLDivElement>) => {
      event.preventDefault();
      setIsCenterResizing(true);

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

        setIsCenterPanelCollapsed(false);
        setCenterPanelHeightOverride((current) => (current === finalHeight ? current : finalHeight));
      };

      const onUp = () => {
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

      onMove(event.nativeEvent as MouseEvent);

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

  const handleToggleMapFocusMode = useCallback(() => {
    setIsMapFocusMode((current) => !current);
  }, []);

  return {
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
    restoreCenterPanel,
    restoreLeftPanel,
    restoreRightPanel,
  };
}