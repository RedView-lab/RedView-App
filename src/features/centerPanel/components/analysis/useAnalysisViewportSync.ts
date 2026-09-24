import { useCallback, useEffect, useState } from 'react';
import type { useProjectStoreOptional } from '@/features/itineraryPanel';
import {
  DETAIL_ZOOM_STEP,
  detailOffsetForCenter,
  detailZoomToVisibleFraction,
  normalizeAnalysisState,
  normalizeUnitInterval,
  sameViewportValue,
  VIEWPORT_COMMIT_DEBOUNCE_MS,
} from './shared';


interface UseAnalysisViewportSyncArgs {
  projectStore?: ReturnType<typeof useProjectStoreOptional>;
  storedDetailZoom: number;
  storedDetailOffset: number;
  storedYZoom?: number;
  storedYOffset?: number;
}

/**
 * Gère la synchronisation bidirectionnelle, le zoom et le défilement (offset)
 * de la vue détaillée du graphique d'analyse (horizontal et vertical) avec le store de projet.
 */
export function useAnalysisViewportSync({
  projectStore,
  storedDetailZoom,
  storedDetailOffset,
  storedYZoom = 0,
  storedYOffset = 0,
}: UseAnalysisViewportSyncArgs) {
  const [prevStoredZoom, setPrevStoredZoom] = useState(storedDetailZoom);
  const [prevStoredOffset, setPrevStoredOffset] = useState(storedDetailOffset);
  const [prevStoredYZoom, setPrevStoredYZoom] = useState(storedYZoom);
  const [prevStoredYOffset, setPrevStoredYOffset] = useState(storedYOffset);

  const [viewportState, setViewportState] = useState(() => ({
    detailZoom: storedDetailZoom,
    detailOffset: storedDetailOffset,
    yZoom: storedYZoom,
    yOffset: storedYOffset,
  }));

  if (
    !sameViewportValue(prevStoredZoom, storedDetailZoom) ||
    !sameViewportValue(prevStoredOffset, storedDetailOffset) ||
    !sameViewportValue(prevStoredYZoom, storedYZoom) ||
    !sameViewportValue(prevStoredYOffset, storedYOffset)
  ) {
    setPrevStoredZoom(storedDetailZoom);
    setPrevStoredOffset(storedDetailOffset);
    setPrevStoredYZoom(storedYZoom);
    setPrevStoredYOffset(storedYOffset);
    setViewportState({
      detailZoom: storedDetailZoom,
      detailOffset: storedDetailOffset,
      yZoom: storedYZoom,
      yOffset: storedYOffset,
    });
  }

  const detailZoom = viewportState.detailZoom;
  const detailOffset = viewportState.detailOffset;
  const yZoom = viewportState.yZoom;
  const yOffset = viewportState.yOffset;

  useEffect(() => {
    if (!projectStore) return;
    if (
      sameViewportValue(detailZoom, storedDetailZoom) &&
      sameViewportValue(detailOffset, storedDetailOffset) &&
      sameViewportValue(yZoom, storedYZoom) &&
      sameViewportValue(yOffset, storedYOffset)
    ) {
      return;
    }

    const timeoutId = window.setTimeout(() => {
      projectStore.setProject((prev) => {
        const current = normalizeAnalysisState(prev.analysis);
        if (
          sameViewportValue(current.detailZoom, detailZoom) &&
          sameViewportValue(current.detailOffset, detailOffset) &&
          sameViewportValue(current.yZoom ?? 0, yZoom) &&
          sameViewportValue(current.yOffset ?? 0, yOffset)
        ) {
          return prev;
        }
        return {
          ...prev,
          analysis: {
            ...current,
            detailZoom,
            detailOffset,
            yZoom,
            yOffset,
          },
        };
      });
    }, VIEWPORT_COMMIT_DEBOUNCE_MS);

    return () => window.clearTimeout(timeoutId);
  }, [
    detailOffset,
    detailZoom,
    projectStore,
    storedDetailOffset,
    storedDetailZoom,
    storedYOffset,
    storedYZoom,
    yOffset,
    yZoom,
  ]);

  const handleZoomIn = useCallback(() => {
    setViewportState((prev) => {
      const nextZoom = Math.min(1, Math.round((prev.detailZoom + DETAIL_ZOOM_STEP) * 100) / 100);
      if (nextZoom === prev.detailZoom) return prev;
      const prevVisible = detailZoomToVisibleFraction(prev.detailZoom);
      const nextVisible = detailZoomToVisibleFraction(nextZoom);
      const prevCenter = prev.detailOffset * (1 - prevVisible) + prevVisible / 2;
      return {
        ...prev,
        detailZoom: nextZoom,
        detailOffset: detailOffsetForCenter(prevCenter, nextVisible),
      };
    });
  }, []);

  const handleZoomOut = useCallback(() => {
    setViewportState((prev) => {
      const nextZoom = Math.max(0, Math.round((prev.detailZoom - DETAIL_ZOOM_STEP) * 100) / 100);
      if (nextZoom === prev.detailZoom) return prev;
      const prevVisible = detailZoomToVisibleFraction(prev.detailZoom);
      const nextVisible = detailZoomToVisibleFraction(nextZoom);
      const prevCenter = prev.detailOffset * (1 - prevVisible) + prevVisible / 2;
      return {
        ...prev,
        detailZoom: nextZoom,
        detailOffset: detailOffsetForCenter(prevCenter, nextVisible),
      };
    });
  }, []);

  const handleResetZoom = useCallback(() => {
    setViewportState((prev) => ({ ...prev, detailZoom: 0, detailOffset: 0 }));
  }, []);

  const handleOffsetChange = useCallback((nextOffset: number) => {
    setViewportState((prev) => ({
      ...prev,
      detailOffset: normalizeUnitInterval(nextOffset, detailZoomToVisibleFraction(prev.detailZoom)),
    }));
  }, []);

  const handleViewportChange = useCallback(
    (next: { detailZoom: number; detailOffset: number }) => {
      setViewportState((prev) => ({
        ...prev,
        detailZoom: normalizeUnitInterval(next.detailZoom, 0),
        detailOffset: normalizeUnitInterval(next.detailOffset, 0),
      }));
    },
    [],
  );

  const handleYViewportChange = useCallback(
    (next: { yZoom: number; yOffset: number }) => {
      setViewportState((prev) => ({
        ...prev,
        yZoom: normalizeUnitInterval(next.yZoom, 0),
        yOffset: normalizeUnitInterval(next.yOffset, 0),
      }));
    },
    [],
  );

  return {
    detailZoom,
    detailOffset,
    yZoom,
    yOffset,
    handleZoomIn,
    handleZoomOut,
    handleResetZoom,
    handleOffsetChange,
    handleViewportChange,
    handleYViewportChange,
  };
}
