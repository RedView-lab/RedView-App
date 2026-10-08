import { useCallback, useEffect, useRef, useState } from 'react';
import { readRootAppScale } from '@/shared/lib/appScale';

const PANEL_STORAGE_WIDTH_KEY = 'rv-viewer-right-panel-width-v2';
const PANEL_STORAGE_COLLAPSED_KEY = 'rv-viewer-right-panel-collapsed-v2';
const PANEL_WIDTH_DEFAULT = 380;
const PANEL_WIDTH_MIN = 350;
const PANEL_WIDTH_MAX = 600;
const PANEL_COLLAPSE_DRAG_THRESHOLD = 48;

/** Largeur (stockée), état replié (stocké) et redimensionnement par glisser du panneau de droite du viewer. */
export function useRightPanelLayout() {
  const [panelWidth, setPanelWidth] = useState<number>(() => {
    try {
      const stored = localStorage.getItem(PANEL_STORAGE_WIDTH_KEY);
      if (stored) {
        const parsed = parseFloat(stored);
        if (!Number.isNaN(parsed) && parsed >= PANEL_WIDTH_MIN && parsed <= PANEL_WIDTH_MAX) {
          return parsed;
        }
      }
    } catch {
      // ignore
    }
    return PANEL_WIDTH_DEFAULT;
  });

  const [isCollapsed, setIsCollapsed] = useState<boolean>(() => {
    try {
      return localStorage.getItem(PANEL_STORAGE_COLLAPSED_KEY) === 'true';
    } catch {
      return false;
    }
  });

  const [isResizing, setIsResizing] = useState(false);
  const lastExpandedWidthRef = useRef<number>(panelWidth);

  useEffect(() => {
    if (!isCollapsed) {
      lastExpandedWidthRef.current = panelWidth;
    }
  }, [isCollapsed, panelWidth]);

  useEffect(() => {
    try {
      localStorage.setItem(PANEL_STORAGE_WIDTH_KEY, String(panelWidth));
    } catch {
      // ignore
    }
  }, [panelWidth]);

  useEffect(() => {
    try {
      localStorage.setItem(PANEL_STORAGE_COLLAPSED_KEY, String(isCollapsed));
    } catch {
      // ignore
    }
  }, [isCollapsed]);

  const handleResizeStart = useCallback(
    (event: React.MouseEvent<HTMLDivElement>) => {
      event.preventDefault();
      setIsResizing(true);
      const startX = event.clientX;
      const startWidth = panelWidth;
      // Le panneau est zoomé par --app-scale : px écran -> px du panneau.
      const uiScale = readRootAppScale();

      const onMove = (nextEvent: MouseEvent) => {
        const delta = (startX - nextEvent.clientX) / uiScale;
        const raw = startWidth + delta;
        const maxAllowed = Math.min(PANEL_WIDTH_MAX, (window.innerWidth - 32) / uiScale);
        const minAllowed = Math.min(PANEL_WIDTH_MIN, maxAllowed);

        if (raw <= minAllowed - PANEL_COLLAPSE_DRAG_THRESHOLD) {
          setIsCollapsed(true);
          return;
        }

        setIsCollapsed(false);
        const clamped = Math.max(minAllowed, Math.min(maxAllowed, raw));
        lastExpandedWidthRef.current = clamped;
        setPanelWidth(clamped);
      };

      const onUp = () => {
        setIsResizing(false);
        document.removeEventListener('mousemove', onMove);
        document.removeEventListener('mouseup', onUp);
      };

      document.addEventListener('mousemove', onMove);
      document.addEventListener('mouseup', onUp);
    },
    [panelWidth],
  );

  const handleRestore = useCallback(() => {
    const nextWidth = Math.max(
      PANEL_WIDTH_MIN,
      Math.min(PANEL_WIDTH_MAX, lastExpandedWidthRef.current || PANEL_WIDTH_DEFAULT),
    );
    setPanelWidth(nextWidth);
    setIsCollapsed(false);
  }, []);

  return { panelWidth, isCollapsed, isResizing, handleResizeStart, handleRestore };
}
