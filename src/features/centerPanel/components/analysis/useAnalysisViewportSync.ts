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
}

/**
 * Gère la synchronisation bidirectionnelle, le zoom et le défilement (offset)
 * de la vue détaillée du graphique d'analyse avec le store de projet.
 */
export function useAnalysisViewportSync({
  projectStore,
  storedDetailZoom,
  storedDetailOffset,
}: UseAnalysisViewportSyncArgs) {
  const [prevStoredZoom, setPrevStoredZoom] = useState(storedDetailZoom);
  const [prevStoredOffset, setPrevStoredOffset] = useState(storedDetailOffset);
  const [viewportState, setViewportState] = useState(() => ({
    detailZoom: storedDetailZoom,
    detailOffset: storedDetailOffset,
  }));

  if (
    !sameViewportValue(prevStoredZoom, storedDetailZoom) ||
    !sameViewportValue(prevStoredOffset, storedDetailOffset)
  ) {
    setPrevStoredZoom(storedDetailZoom);
    setPrevStoredOffset(storedDetailOffset);
    setViewportState({
      detailZoom: storedDetailZoom,
      detailOffset: storedDetailOffset,
    });
  }

  const detailZoom = viewportState.detailZoom;
  const detailOffset = viewportState.detailOffset;

  useEffect(() => {
    if (!projectStore) return;
    if (
      sameViewportValue(detailZoom, storedDetailZoom) &&
      sameViewportValue(detailOffset, storedDetailOffset)
    ) {
      return;
    }

    const timeoutId = window.setTimeout(() => {
      projectStore.setProject((prev) => {
        const current = normalizeAnalysisState(prev.analysis);
        if (
          sameViewportValue(current.detailZoom, detailZoom) &&
          sameViewportValue(current.detailOffset, detailOffset)
        ) {
          return prev;
        }
        return {
          ...prev,
          analysis: {
            ...current,
            detailZoom,
            detailOffset,
          },
        };
      });
    }, VIEWPORT_COMMIT_DEBOUNCE_MS);

    return () => window.clearTimeout(timeoutId);
  }, [detailOffset, detailZoom, projectStore, storedDetailOffset, storedDetailZoom]);

  const handleZoomIn = useCallback(() => {
    setViewportState((prev) => {
      const nextZoom = Math.min(1, Math.round((prev.detailZoom + DETAIL_ZOOM_STEP) * 100) / 100);
      if (nextZoom === prev.detailZoom) return prev;
      const prevVisible = detailZoomToVisibleFraction(prev.detailZoom);
      const nextVisible = detailZoomToVisibleFraction(nextZoom);
      const prevCenter = prev.detailOffset * (1 - prevVisible) + prevVisible / 2;
      return {
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
        detailZoom: nextZoom,
        detailOffset: detailOffsetForCenter(prevCenter, nextVisible),
      };
    });
  }, []);

  const handleResetZoom = useCallback(() => {
    setViewportState({ detailZoom: 0, detailOffset: 0 });
  }, []);

  const handleOffsetChange = useCallback((nextOffset: number) => {
    setViewportState((prev) => ({
      ...prev,
      detailOffset: normalizeUnitInterval(nextOffset, detailZoomToVisibleFraction(prev.detailZoom)),
    }));
  }, []);

  return {
    detailZoom,
    detailOffset,
    handleZoomIn,
    handleZoomOut,
    handleResetZoom,
    handleOffsetChange,
  };
}
