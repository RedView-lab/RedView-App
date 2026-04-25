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
  PANEL_WIDTH_KEY,
  PANEL_PADDING,
  PANEL_WIDTH_MIN_FALLBACK,
} from './constants';
import { getDashboardLayout } from './layout';
import type { DashboardPersistedMutator } from './useDashboardProjectState';
import {
  clampLeftPanelWidth,
  clampPanelWidth,
  readStoredCenterPanelHeight,
  readStoredLeftWidth,
  readStoredWidth,
} from './utils';

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
  const [isResizing, setIsResizing] = useState(false);
  const leftPanelOpen = !isMapFocusMode;
  const [leftPanelWidth, setLeftPanelWidth] = useState<number>(() =>
    readStoredLeftWidth(),
  );
  const [isLeftResizing, setIsLeftResizing] = useState(false);
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
    setLidarModeEnabled(dashboard?.lidarDownloadModeEnabled ?? false);
    setProjectMapViewport(dashboard?.mapViewport ?? loadViewport());
  }, [activeProjectInitial]);

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
  }, [centerPanelHeightOverride, updatePersistedDashboard]);

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
    leftPanelOpen,
  });

  const handleResizeStart = useCallback(
    (event: ReactMouseEvent<HTMLDivElement>) => {
      event.preventDefault();
      setIsResizing(true);

      const onMove = (nextEvent: MouseEvent) => {
        const raw = layout.scaledViewportWidth - nextEvent.clientX / layout.appScale - PANEL_PADDING;
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

  const handleLeftResizeStart = useCallback(
    (event: ReactMouseEvent<HTMLDivElement>) => {
      event.preventDefault();
      setIsLeftResizing(true);

      const onMove = (nextEvent: MouseEvent) => {
        const raw = nextEvent.clientX / layout.appScale - PANEL_PADDING;
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
    [layout.appScale],
  );

  const handleCenterPanelResizeStart = useCallback(
    (event: ReactMouseEvent<HTMLDivElement>) => {
      event.preventDefault();

      const onMove = (nextEvent: MouseEvent) => {
        const raw = layout.scaledViewportHeight - PANEL_PADDING - nextEvent.clientY / layout.appScale;
        setCenterPanelHeightOverride(raw);
      };
      const onUp = () => {
        document.removeEventListener('mousemove', onMove);
        document.removeEventListener('mouseup', onUp);
      };

      document.addEventListener('mousemove', onMove);
      document.addEventListener('mouseup', onUp);
    },
    [layout.appScale, layout.scaledViewportHeight],
  );

  const handleToggleMapFocusMode = useCallback(() => {
    setIsMapFocusMode((current) => !current);
  }, []);

  return {
    lidarModeEnabled,
    setLidarModeEnabled,
    isMapFocusMode,
    leftPanelOpen,
    panelWidth,
    leftPanelWidth,
    isResizing,
    isLeftResizing,
    projectMapViewport,
    rightPrimaryPanelHostRef,
    exporterPanelHostRef,
    layout,
    handleMapViewportChange,
    handleResizeStart,
    handleLeftResizeStart,
    handleCenterPanelResizeStart,
    handleToggleMapFocusMode,
  };
}