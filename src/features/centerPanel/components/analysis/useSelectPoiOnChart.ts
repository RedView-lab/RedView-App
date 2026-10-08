import { useEffect } from 'react';
import { findChartXForPoi, listenSelectPoiOnChart } from '@/features/poi/lib/chartPoiSyncBridge';
import { detailOffsetForCenter, detailZoomToVisibleFraction, normalizeUnitInterval } from './shared';

type PoiLookup = Omit<Parameters<typeof findChartXForPoi>[0], 'poi'>;

/**
 * POI choisi sur la carte → même point sur le graphique : sélection, point de
 * survol, et la fenêtre zoomée glisse s'il tombe près d'un bord ou hors d'elle.
 */
export function useSelectPoiOnChart(params: PoiLookup & {
  detailZoom: number;
  detailOffset: number;
  routeXDomainClamp: { min: number; max: number } | null;
  handleOffsetChange: (offset: number) => void;
  setSelectedChartX: (x: number) => void;
  updateHoverPoint: (x: number | null) => void;
}): void {
  const {
    poiAnnotations,
    activeItinerary,
    visibleChartNodes,
    xMode,
    predictions,
    detailZoom,
    detailOffset,
    routeXDomainClamp,
    handleOffsetChange,
    setSelectedChartX,
    updateHoverPoint,
  } = params;
  useEffect(() => {
    return listenSelectPoiOnChart((payload) => {
      const targetX = findChartXForPoi({
        poi: payload,
        poiAnnotations,
        activeItinerary,
        visibleChartNodes,
        xMode,
        predictions,
      });

      if (targetX != null && Number.isFinite(targetX)) {
        setSelectedChartX(targetX);
        updateHoverPoint(targetX);

        if (detailZoom > 0 && routeXDomainClamp) {
          const fullSpan = routeXDomainClamp.max - routeXDomainClamp.min;
          if (fullSpan > 0) {
            const visibleFraction = detailZoomToVisibleFraction(normalizeUnitInterval(detailZoom));
            const visibleSpan = fullSpan * visibleFraction;
            const currentMin = routeXDomainClamp.min + detailOffset * (fullSpan - visibleSpan);
            const currentMax = currentMin + visibleSpan;

            if (targetX < currentMin + visibleSpan * 0.08 || targetX > currentMax - visibleSpan * 0.08) {
              const centerNorm = (targetX - routeXDomainClamp.min) / fullSpan;
              const nextOffset = detailOffsetForCenter(centerNorm, visibleFraction);
              handleOffsetChange(nextOffset);
            }
          }
        }
      }
    });
  }, [
    activeItinerary,
    detailOffset,
    detailZoom,
    handleOffsetChange,
    poiAnnotations,
    predictions,
    routeXDomainClamp,
    setSelectedChartX,
    updateHoverPoint,
    visibleChartNodes,
    xMode,
  ]);
}
