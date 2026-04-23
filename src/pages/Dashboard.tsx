import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';
import { MapView, MapBlurMirror } from '@/features/map3d';
import { ControlPanelContainer } from '@/features/controlPanel';
import { ExporterPanel } from '@/features/controlPanel/ExporterPanel';
import { CenterPanel } from '@/features/centerPanel';
import { CenterPanelToolbar } from '@/features/centerPanel/components/CenterPanelToolbar';
import { ItineraryPanel } from '@/features/itineraryPanel';
import { ProjectProvider, PredictionProvider } from '@/features/itineraryPanel';
import type { ItineraryProject } from '@/features/itineraryPanel/types';
import { ProjectBrowserOverlay } from '@/features/projectBrowser';
import { LidarProvider } from '@/features/lidar/components/LidarContext';
import { getProject, saveProject, uploadProjectThumbnail } from '@/lib/projects';
import { replaceProjectLocation } from '@/lib/projectLocation';
import { captureMapThumbnail } from '@/lib/mapThumbnail';
import { loadViewport, type MapViewport } from '@/features/map3d/lib/viewport-persist';
import type { Map as MapboxMap } from 'mapbox-gl';

interface DashboardProps {
  email: string;
  onLogout: () => void;
  initialProjectId?: string | null;
}

function clampNumber(value: number, min: number, max: number) {
  return Math.min(max, Math.max(min, value));
}

const PANEL_WIDTH_KEY = 'rvc-panel-width';
const PANEL_WIDTH_MIN_FALLBACK = 260;
const PANEL_WIDTH_MAX = 560;
const PANEL_WIDTH_DEFAULT = 300;
const PANEL_PADDING = 12;
const CENTER_PANEL_HEIGHT_KEY = 'rvc-center-panel-height';

const LEFT_PANEL_WIDTH_KEY = 'rvi-panel-width';
// Hard minimum computed from the Rythme section's narrowest row:
//   [checkbox 16 + gap 4 + label min 28 + gap 4 + upload min 88]
// + gap 8
// + [checkbox 16 + gap 4 + label min 28 + gap 4 + chip min 64]
// = 264 px inner content, + 24 px panel padding + 8 px safety = 296.
// We round up to 320 so the scrollbar + browser rounding never push
// cells into overlap when the user drags the handle all the way left.
const LEFT_PANEL_WIDTH_MIN = 320;
const LEFT_PANEL_WIDTH_MAX = 520;
const LEFT_PANEL_WIDTH_DEFAULT = 360;
const CENTER_PANEL_MIN_WIDTH = 420;
const CENTER_PANEL_MIN_HEIGHT = 236;
const CENTER_PANEL_MIN_HEIGHT_RATIO = 0.3;
const CENTER_PANEL_DEFAULT_HEIGHT_RATIO = 0.46;
const CENTER_PANEL_MAX_HEIGHT_RATIO = 0.72;
const CENTER_PANEL_MIN_MAP_STAGE = 112;
const CENTER_TOOLBAR_HEIGHT = 48;
const CENTER_PANEL_STACK_GAP = PANEL_PADDING;
const CENTER_PANEL_RESIZE_HIT_AREA = 18;
// Adaptive UI scale.
// The whole dashboard is rendered as if the viewport had APP_SCALE_DESIGN_*
// dimensions, then transformed to fit the real viewport. This keeps the UI
// readable on small laptops (e.g. 13" / 14" MacBooks) without forcing the
// user to change browser zoom. Above the design size we never upscale.
const APP_SCALE_MIN = 0.7;
const APP_SCALE_DESIGN_WIDTH = 1920;
const APP_SCALE_DESIGN_HEIGHT = 1080;

function readStoredCenterPanelHeight(): number | null {
  try {
    const raw = localStorage.getItem(CENTER_PANEL_HEIGHT_KEY);
    if (!raw) return null;
    const n = parseInt(raw, 10);
    return Number.isFinite(n) ? n : null;
  } catch {
    return null;
  }
}

function readStoredLeftWidth(): number {
  try {
    const raw = localStorage.getItem(LEFT_PANEL_WIDTH_KEY);
    if (!raw) return LEFT_PANEL_WIDTH_DEFAULT;
    const n = parseInt(raw, 10);
    if (!Number.isFinite(n)) return LEFT_PANEL_WIDTH_DEFAULT;
    return Math.min(LEFT_PANEL_WIDTH_MAX, Math.max(LEFT_PANEL_WIDTH_MIN, n));
  } catch {
    return LEFT_PANEL_WIDTH_DEFAULT;
  }
}

function readStoredWidth(): number {
  try {
    const raw = localStorage.getItem(PANEL_WIDTH_KEY);
    if (!raw) return PANEL_WIDTH_DEFAULT;
    const n = parseInt(raw, 10);
    if (!Number.isFinite(n)) return PANEL_WIDTH_DEFAULT;
    return Math.min(PANEL_WIDTH_MAX, Math.max(PANEL_WIDTH_MIN_FALLBACK, n));
  } catch {
    return PANEL_WIDTH_DEFAULT;
  }
}

function clampLeftPanelWidth(value: number) {
  return Math.min(LEFT_PANEL_WIDTH_MAX, Math.max(LEFT_PANEL_WIDTH_MIN, value));
}

function clampPanelWidth(value: number, minWidth: number) {
  return Math.min(PANEL_WIDTH_MAX, Math.max(minWidth, value));
}

function measurePanelMinWidth(node: HTMLDivElement | null): number | null {
  if (!node || typeof document === 'undefined') return null;

  const panel = node.firstElementChild;
  if (!(panel instanceof HTMLElement)) return null;

  const clone = panel.cloneNode(true);
  if (!(clone instanceof HTMLElement)) return null;

  clone.removeAttribute('style');
  clone.style.position = 'fixed';
  clone.style.left = '-10000px';
  clone.style.top = '0';
  clone.style.width = 'max-content';
  clone.style.maxWidth = 'none';
  clone.style.minWidth = '0';
  clone.style.height = 'auto';
  clone.style.visibility = 'hidden';
  clone.style.pointerEvents = 'none';
  clone.style.overflow = 'visible';

  document.body.appendChild(clone);
  const width = Math.ceil(clone.getBoundingClientRect().width);
  clone.remove();

  return Number.isFinite(width) && width > 0 ? width : null;
}

function formatDisplayName(email: string): string {
  const localPart = email.split('@')[0] ?? 'Utilisateur';
  return localPart
    .split(/[._-]+/)
    .filter(Boolean)
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join(' ');
}

export default function Dashboard({ email, onLogout, initialProjectId }: DashboardProps) {
  const [mapInstance, setMapInstance] = useState<MapboxMap | null>(null);
  const [mapLoaded, setMapLoaded] = useState(false);
  const [lidarModeEnabled, setLidarModeEnabled] = useState(false);
  const [projectMapViewport, setProjectMapViewport] = useState<MapViewport | null>(
    () => loadViewport(),
  );

  // ── Active project (Supabase-backed) ────────────────────────────
  // The browser overlay is force-open until the user picks or creates
  // a project. Once selected, we load `data` from the projects table
  // and seed the editor; subsequent state changes are auto-saved.
  const [activeProjectId, setActiveProjectId] = useState<string | null>(null);
  const [activeProjectInitial, setActiveProjectInitial] =
    useState<ItineraryProject | null>(null);
  const [projectLoading, setProjectLoading] = useState(false);
  const [projectBrowserOpen, setProjectBrowserOpen] = useState(true);
  const activeProjectSnapshotRef = useRef<ItineraryProject | null>(null);

  const handleOpenProject = useCallback(async (projectId: string) => {
    setProjectLoading(true);
    try {
      const row = await getProject(projectId);
      if (!row) throw new Error('Project not found');
      activeProjectSnapshotRef.current = row.data;
      setActiveProjectId(row.id);
      setActiveProjectInitial(row.data);
      setProjectBrowserOpen(false);
      replaceProjectLocation({ id: row.id, name: row.name || row.data.name || 'project' });
    } catch (e) {
      console.error('[Dashboard] failed to open project', e);
      if (activeProjectIdRef.current == null) {
        replaceProjectLocation(null);
      }
    } finally {
      setProjectLoading(false);
    }
  }, []);

  useEffect(() => {
    if (!initialProjectId || activeProjectId != null || projectLoading) return;
    void handleOpenProject(initialProjectId);
  }, [activeProjectId, handleOpenProject, initialProjectId, projectLoading]);

  // Debounced autosave. Every project mutation pushes the latest snapshot
  // into a ref; a 1s timer flushes it to Supabase. We also flush on
  // unmount / pagehide so closing the tab can't drop unsaved edits.
  const pendingSaveRef = useRef<ItineraryProject | null>(null);
  const saveTimerRef = useRef<number | null>(null);
  const activeProjectIdRef = useRef<string | null>(null);
  activeProjectIdRef.current = activeProjectId;

  const flushSave = useCallback(async () => {
    const id = activeProjectIdRef.current;
    const payload = pendingSaveRef.current;
    if (!id || !payload) return;
    pendingSaveRef.current = null;
    try {
      await saveProject(id, payload);
    } catch (e) {
      console.error('[Dashboard] autosave failed', e);
    }
  }, []);

  const queueProjectSave = useCallback(
    (next: ItineraryProject) => {
      activeProjectSnapshotRef.current = next;
      pendingSaveRef.current = next;
      const id = activeProjectIdRef.current;
      if (id) {
        replaceProjectLocation({ id, name: next.name || 'project' });
      }
      if (saveTimerRef.current != null) {
        window.clearTimeout(saveTimerRef.current);
      }
      saveTimerRef.current = window.setTimeout(() => {
        saveTimerRef.current = null;
        void flushSave();
      }, 1000);
    },
    [flushSave],
  );

  const handleProjectChange = useCallback(
    (next: ItineraryProject) => {
      queueProjectSave(next);
    },
    [queueProjectSave],
  );

  const updatePersistedDashboard = useCallback(
    (mut: (dashboard: NonNullable<ItineraryProject['dashboard']>) => void) => {
      if (!activeProjectIdRef.current) return;
      const current = activeProjectSnapshotRef.current;
      if (!current) return;

      const next = structuredClone(current);
      const dashboard = structuredClone(next.dashboard ?? {});
      mut(dashboard);
      next.dashboard = dashboard;
      queueProjectSave(next);
    },
    [queueProjectSave],
  );

  // Flush on tab close / refresh.
  useEffect(() => {
    const onPageHide = () => { void flushSave(); };
    window.addEventListener('pagehide', onPageHide);
    window.addEventListener('beforeunload', onPageHide);
    return () => {
      window.removeEventListener('pagehide', onPageHide);
      window.removeEventListener('beforeunload', onPageHide);
      if (saveTimerRef.current != null) {
        window.clearTimeout(saveTimerRef.current);
        void flushSave();
      }
    };
  }, [flushSave]);

  const handleBackToBrowser = useCallback(async () => {
    // Force-flush any pending edits before showing the picker so the
    // updated_at / size_bytes columns reflect the freshest state.
    await flushSave();
    // Capture a thumbnail of the current map view BEFORE remounting the
    // editor (otherwise the canvas would already be torn down). Best-effort:
    // failures (no map, read-back blocked) just keep the previous thumbnail.
    const id = activeProjectIdRef.current;
    if (id) {
      try {
        const blob = await captureMapThumbnail(mapInstance);
        if (blob) await uploadProjectThumbnail(id, blob);
      } catch (e) {
        console.warn('[Dashboard] thumbnail upload failed', e);
      }
    }
    setProjectBrowserOpen(true);
    replaceProjectLocation(null);
  }, [flushSave, mapInstance]);

  const [panelWidth, setPanelWidth] = useState<number>(() => readStoredWidth());
  const [isResizing, setIsResizing] = useState(false);
  const leftPanelOpen = true;
  const [leftPanelWidth, setLeftPanelWidth] = useState<number>(() =>
    readStoredLeftWidth(),
  );
  const [isLeftResizing, setIsLeftResizing] = useState(false);
  const [centerPanelHeightOverride, setCenterPanelHeightOverride] = useState<number | null>(() =>
    readStoredCenterPanelHeight(),
  );
  const [exporterPanelHeight, setExporterPanelHeight] = useState(0);
  const [panelMinWidth, setPanelMinWidth] = useState(PANEL_WIDTH_DEFAULT);
  const [viewport, setViewport] = useState(() => ({
    w: window.innerWidth,
    h: window.innerHeight,
  }));
  const rightPrimaryPanelHostRef = useRef<HTMLDivElement | null>(null);
  const exporterPanelHostRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    const onResize = () =>
      setViewport({ w: window.innerWidth, h: window.innerHeight });
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
  }, [activeProjectId, activeProjectInitial]);

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

  const measureRightDockMinWidth = useCallback(() => {
    const measuredWidths = [
      measurePanelMinWidth(rightPrimaryPanelHostRef.current),
      measurePanelMinWidth(exporterPanelHostRef.current),
    ].filter((value): value is number => value != null);

    if (measuredWidths.length === 0) return PANEL_WIDTH_DEFAULT;

    return clampPanelWidth(
      Math.max(PANEL_WIDTH_MIN_FALLBACK, ...measuredWidths),
      PANEL_WIDTH_MIN_FALLBACK,
    );
  }, []);

  useLayoutEffect(() => {
    const primaryHost = rightPrimaryPanelHostRef.current;
    const exporterHost = exporterPanelHostRef.current;
    if (!primaryHost && !exporterHost) return;

    // Coalesce many observer callbacks into a single RAF-batched layout pass.
    // The previous version invoked a full re-measure synchronously on every
    // ResizeObserver AND MutationObserver event (subtree+characterData), which
    // caused a layout-thrash storm whenever any panel child changed text.
    let rafId = 0;
    let pending = false;
    const syncRightPanelWidth = () => {
      const nextWidth = measureRightDockMinWidth();
      setPanelMinWidth((current) => (current === nextWidth ? current : nextWidth));
      setPanelWidth((current) => clampPanelWidth(current, nextWidth));
    };
    const scheduleSync = () => {
      if (pending) return;
      pending = true;
      rafId = window.requestAnimationFrame(() => {
        pending = false;
        rafId = 0;
        syncRightPanelWidth();
      });
    };

    syncRightPanelWidth();

    const resizeObserver =
      typeof ResizeObserver !== 'undefined' ? new ResizeObserver(scheduleSync) : null;
    if (resizeObserver && primaryHost) resizeObserver.observe(primaryHost);
    if (resizeObserver && exporterHost) resizeObserver.observe(exporterHost);

    return () => {
      resizeObserver?.disconnect();
      if (rafId !== 0) window.cancelAnimationFrame(rafId);
    };
  }, [measureRightDockMinWidth]);

  useEffect(() => {
    try { localStorage.setItem(PANEL_WIDTH_KEY, String(panelWidth)); } catch { /* ignore */ }
    updatePersistedDashboard((dashboard) => {
      dashboard.rightPanelWidth = panelWidth;
    });
  }, [panelWidth, updatePersistedDashboard]);

  useEffect(() => {
    try {
      localStorage.setItem(LEFT_PANEL_WIDTH_KEY, String(leftPanelWidth));
    } catch {
      /* ignore */
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
        localStorage.setItem(CENTER_PANEL_HEIGHT_KEY, String(centerPanelHeightOverride));
      }
    } catch {
      /* ignore */
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

  const appScale = clampNumber(
    Math.min(
      viewport.w / APP_SCALE_DESIGN_WIDTH,
      viewport.h / APP_SCALE_DESIGN_HEIGHT,
    ),
    APP_SCALE_MIN,
    1,
  );
  const scaledViewportWidth = viewport.w / appScale;
  const scaledViewportHeight = viewport.h / appScale;

  const handleResizeStart = (ev: React.MouseEvent<HTMLDivElement>) => {
    ev.preventDefault();
    setIsResizing(true);
    const onMove = (e: MouseEvent) => {
      const raw = scaledViewportWidth - e.clientX / appScale - PANEL_PADDING;
      const clamped = clampPanelWidth(raw, panelMinWidth);
      setPanelWidth(clamped);
    };
    const onUp = () => {
      setIsResizing(false);
      document.removeEventListener('mousemove', onMove);
      document.removeEventListener('mouseup', onUp);
    };
    document.addEventListener('mousemove', onMove);
    document.addEventListener('mouseup', onUp);
  };

  const handleLeftResizeStart = (ev: React.MouseEvent<HTMLDivElement>) => {
    ev.preventDefault();
    setIsLeftResizing(true);
    const onMove = (e: MouseEvent) => {
      const raw = e.clientX / appScale - PANEL_PADDING;
      const clamped = Math.min(
        LEFT_PANEL_WIDTH_MAX,
        Math.max(LEFT_PANEL_WIDTH_MIN, raw),
      );
      setLeftPanelWidth(clamped);
    };
    const onUp = () => {
      setIsLeftResizing(false);
      document.removeEventListener('mousemove', onMove);
      document.removeEventListener('mouseup', onUp);
    };
    document.addEventListener('mousemove', onMove);
    document.addEventListener('mouseup', onUp);
  };

  const handleCenterPanelResizeStart = (ev: React.MouseEvent<HTMLDivElement>) => {
    ev.preventDefault();
    const onMove = (e: MouseEvent) => {
      const raw = scaledViewportHeight - PANEL_PADDING - e.clientY / appScale;
      setCenterPanelHeightOverride(raw);
    };
    const onUp = () => {
      document.removeEventListener('mousemove', onMove);
      document.removeEventListener('mouseup', onUp);
    };
    document.addEventListener('mousemove', onMove);
    document.addEventListener('mouseup', onUp);
  };

  const handleMapReady = (map: MapboxMap) => {
    setMapInstance(map);
    setMapLoaded(true);
  };

  const rightPanelStyle: React.CSSProperties = {
    position: 'absolute',
    top: 0,
    right: 0,
    bottom: 0,
    width: panelWidth + PANEL_PADDING * 2,
    zIndex: 25,
    padding: PANEL_PADDING,
    boxSizing: 'border-box',
    display: 'flex',
    flexDirection: 'column',
    gap: PANEL_PADDING,
    overflow: 'hidden',
  };

  const leftPanelStyle: React.CSSProperties = {
    position: 'absolute',
    top: 0,
    left: 0,
    bottom: 0,
    width: leftPanelWidth + PANEL_PADDING * 2,
    zIndex: 25,
    padding: PANEL_PADDING,
    boxSizing: 'border-box',
    display: leftPanelOpen ? 'flex' : 'none',
    flexDirection: 'column',
    overflow: 'hidden',
  };

  // IMPORTANT: every layout calculation below MUST be expressed in the
  // dashboard's *design* coordinate space (the wrapper is sized to
  // `scaledViewportWidth` x `scaledViewportHeight` and then transformed by
  // `appScale`). Mixing raw `viewport.w`/`viewport.h` (real device pixels)
  // with values that are then placed inside the scaled wrapper offsets
  // every panel + blur mirror by `1 - appScale` — visible on Mac laptops
  // (1440x900 -> appScale ~0.75) but invisible on >=1920x1080 displays
  // where appScale === 1.
  const designW = scaledViewportWidth;
  const designH = scaledViewportHeight;
  const rightDockContentHeight = Math.max(0, designH - PANEL_PADDING * 2);
  const rightPrimaryPanelHeight = Math.max(
    0,
    rightDockContentHeight - exporterPanelHeight - PANEL_PADDING,
  );
  const rightPrimaryPanelStyle: React.CSSProperties = {
    height: `${rightPrimaryPanelHeight}px`,
    minHeight: 0,
    display: 'flex',
    transition: 'height 360ms cubic-bezier(0.22, 1, 0.36, 1), transform 360ms cubic-bezier(0.22, 1, 0.36, 1), filter 280ms ease',
    willChange: 'height, transform',
    transform: exporterPanelHeight > 80 ? 'translateY(0)' : 'translateY(-2px)',
    filter: exporterPanelHeight > 80 ? 'saturate(1)' : 'saturate(0.96)',
  };

  const centerPanelRegionLeft =
    (leftPanelOpen ? leftPanelWidth + PANEL_PADDING * 2 : 0) + PANEL_PADDING;
  const centerPanelRegionRight = panelWidth + PANEL_PADDING * 2 + PANEL_PADDING;
  const centerPanelAvailableWidth = Math.max(
    0,
    designW - centerPanelRegionLeft - centerPanelRegionRight,
  );
  const centerPanelVisible =
    centerPanelAvailableWidth >= CENTER_PANEL_MIN_WIDTH;
  const centerPanelWidth = centerPanelAvailableWidth;
  const centerPanelAvailableHeight = Math.max(
    0,
    designH - PANEL_PADDING * 2 - CENTER_TOOLBAR_HEIGHT - CENTER_PANEL_STACK_GAP,
  );
  const centerPanelMinHeight = Math.min(
    centerPanelAvailableHeight,
    Math.max(
      CENTER_PANEL_MIN_HEIGHT,
      Math.round(centerPanelAvailableHeight * CENTER_PANEL_MIN_HEIGHT_RATIO),
    ),
  );
  const centerPanelReservedMapHeight = clampNumber(
    Math.round(designH * 0.16),
    CENTER_PANEL_MIN_MAP_STAGE,
    180,
  );
  const centerPanelMaxHeight = Math.max(
    centerPanelMinHeight,
    Math.min(
      centerPanelAvailableHeight,
      Math.min(
        Math.round(centerPanelAvailableHeight * CENTER_PANEL_MAX_HEIGHT_RATIO),
        centerPanelAvailableHeight - centerPanelReservedMapHeight,
      ),
    ),
  );
  const centerPanelDesiredHeight = clampNumber(
    Math.round(centerPanelAvailableHeight * CENTER_PANEL_DEFAULT_HEIGHT_RATIO),
    centerPanelMinHeight,
    centerPanelMaxHeight,
  );
  const centerPanelTargetHeight = centerPanelHeightOverride ?? centerPanelDesiredHeight;
  const centerPanelHeight = clampNumber(
    centerPanelTargetHeight,
    centerPanelMinHeight,
    centerPanelMaxHeight,
  );
  const centerPanelLeft = centerPanelRegionLeft;
  const centerPanelTop = designH - PANEL_PADDING - centerPanelHeight;
  const centerToolbarTop = centerPanelTop - CENTER_PANEL_STACK_GAP - CENTER_TOOLBAR_HEIGHT;
  const centerPanelResizeHitTop =
    centerToolbarTop +
    CENTER_TOOLBAR_HEIGHT -
    Math.max(0, Math.round((CENTER_PANEL_RESIZE_HIT_AREA - CENTER_PANEL_STACK_GAP) / 2));

  const logoutStyle: React.CSSProperties = {
    position: 'absolute',
    top: 12,
    right: panelWidth + PANEL_PADDING * 2 + 12,
    zIndex: 20,
    background: 'rgba(17,17,17,0.7)',
    color: 'rgba(255,255,255,0.8)',
    border: '1px solid rgba(255,255,255,0.15)',
    borderRadius: 6,
    padding: '6px 14px',
    fontSize: 12,
    cursor: 'pointer',
    backdropFilter: 'blur(8px)',
  };
  const displayName = formatDisplayName(email);

  return (
    <LidarProvider>
    <div style={{ position: 'relative', width: '100vw', height: '100dvh', overflow: 'hidden' }}>
      <div
        style={{
          position: 'absolute',
          top: 0,
          left: 0,
          width: `${scaledViewportWidth}px`,
          height: `${scaledViewportHeight}px`,
          overflow: 'hidden',
          transform: `scale(${appScale})`,
          transformOrigin: 'top left',
          ['--app-scale' as string]: String(appScale),
        }}
      >
      <MapView
        onMapReady={handleMapReady}
        lidarSelectionEnabled={lidarModeEnabled}
        onLidarSelectionDisable={() => setLidarModeEnabled(false)}
        initialViewport={projectMapViewport}
        onViewportChange={handleMapViewportChange}
      />

      {/*
        Glass-effect blur backdrops. Each one is a 2D canvas that mirrors
        a slice of the Mapbox WebGL canvas every frame with a CSS
        `filter: blur()` applied. This works around the fact that CSS
        `backdrop-filter` does not reliably sample a sibling WebGL canvas
        in Chromium / Safari (compositor-layer boundaries break backdrop
        sampling). The mirror sits BELOW the panel (z-index 24 vs 25), so
        the panel only needs a translucent tint as background — no
        `backdrop-filter` required.
      */}
      {mapLoaded && leftPanelOpen && (
        <MapBlurMirror
          map={mapInstance}
          top={PANEL_PADDING}
          left={PANEL_PADDING}
          width={leftPanelWidth}
          height={Math.max(0, designH - PANEL_PADDING * 2)}
          borderRadius={8}
        />
      )}
      {mapLoaded && (
        <MapBlurMirror
          map={mapInstance}
          top={PANEL_PADDING}
          left={Math.max(
            0,
            designW - panelWidth - PANEL_PADDING,
          )}
          width={panelWidth}
          height={Math.max(0, designH - PANEL_PADDING * 2)}
          borderRadius={8}
        />
      )}
      {mapLoaded && centerPanelVisible && (
        <MapBlurMirror
          map={mapInstance}
          top={centerToolbarTop}
          left={centerPanelLeft}
          width={centerPanelWidth}
          height={CENTER_TOOLBAR_HEIGHT}
          borderRadius={8}
        />
      )}
      {mapLoaded && centerPanelVisible && (
        <MapBlurMirror
          map={mapInstance}
          top={centerPanelTop}
          left={centerPanelLeft}
          width={centerPanelWidth}
          height={centerPanelHeight}
          borderRadius={8}
        />
      )}

      <ProjectProvider
        key={activeProjectId ?? 'no-project'}
        initialProject={activeProjectInitial ?? undefined}
        onProjectChange={handleProjectChange}
      >
      <PredictionProvider>
      <div style={leftPanelStyle}>
        <ItineraryPanel
          map={mapInstance}
          isMapLoaded={mapLoaded}
          width={leftPanelWidth}
          onResizeStart={handleLeftResizeStart}
          isResizing={isLeftResizing}
          onBackToHome={handleBackToBrowser}
        />
      </div>
      {centerPanelVisible ? (
        <div
          style={{
            position: 'absolute',
            top: centerToolbarTop,
            left: centerPanelLeft,
            width: centerPanelWidth,
            height: CENTER_TOOLBAR_HEIGHT,
            zIndex: 25,
            overflow: 'hidden',
          }}
        >
          <CenterPanelToolbar />
        </div>
      ) : null}

      {centerPanelVisible ? (
        <div
          aria-hidden="true"
          onMouseDown={handleCenterPanelResizeStart}
          style={{
            position: 'absolute',
            top: centerPanelResizeHitTop,
            left: centerPanelLeft,
            width: centerPanelWidth,
            height: CENTER_PANEL_RESIZE_HIT_AREA,
            zIndex: 26,
            cursor: 'row-resize',
            userSelect: 'none',
            touchAction: 'none',
          }}
        />
      ) : null}

      {centerPanelVisible ? (
        <div
          style={{
            position: 'absolute',
            top: centerPanelTop,
            left: centerPanelLeft,
            width: centerPanelWidth,
            height: centerPanelHeight,
            zIndex: 25,
            overflow: 'hidden',
          }}
        >
          <CenterPanel />
        </div>
      ) : null}

      <button onClick={onLogout} style={logoutStyle}>
        Logout
      </button>

      <div style={rightPanelStyle}>
        <div ref={rightPrimaryPanelHostRef} style={rightPrimaryPanelStyle}>
          <ControlPanelContainer
            map={mapInstance}
            isMapLoaded={mapLoaded}
            lidarDownloadModeActive={lidarModeEnabled}
            onToggleLidarDownloadMode={() => setLidarModeEnabled((v) => !v)}
            width={panelWidth}
            onResizeStart={handleResizeStart}
            isResizing={isResizing}
          />
        </div>
        <div ref={exporterPanelHostRef} style={{ flex: '0 0 auto' }}>
          <ExporterPanel width={panelWidth} />
        </div>
      </div>
      </PredictionProvider>
      </ProjectProvider>

      <ProjectBrowserOverlay
        open={projectBrowserOpen || activeProjectId == null}
        displayName={displayName}
        canClose={activeProjectId != null && !projectLoading}
        onOpenProject={handleOpenProject}
        onRequestClose={() => setProjectBrowserOpen(false)}
      />
      </div>
    </div>
    </LidarProvider>
  );
}

