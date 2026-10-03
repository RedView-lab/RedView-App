import { useCallback, useEffect, useMemo, useRef, useState, type PointerEvent as ReactPointerEvent, type RefObject } from 'react';
import type { AxisDomain } from '../series';
import { slopeSegmentAtX, type ChartSlopeSegment } from '../slope';
import {
  MIN_VISIBLE_FRACTION,
  normalizeUnitInterval,
  ratioFor,
  visibleFractionToDetailZoom,
} from './math';
import type { AnalysisChartProps } from './types';

interface UsePlotRangeSelectionOptions {
  plotAreaRef: RefObject<HTMLDivElement | null>;
  /** Domaine X complet (itinéraire entier). */
  xDomain: AxisDomain;
  /** Domaine X affiché (après zoom). */
  plotXDomain: AxisDomain;
  visibleFraction: number;
  detailZoom: number;
  slopeSegments: ChartSlopeSegment[] | null;
  controlledSelectedXRange: AnalysisChartProps['selectedXRange'];
  onViewportChange: AnalysisChartProps['onViewportChange'];
  onDetailOffsetChange: AnalysisChartProps['onDetailOffsetChange'];
  onPlotClick: AnalysisChartProps['onPlotClick'];
  onPlotRangeSelect: AnalysisChartProps['onPlotRangeSelect'];
  onClearSelectedXRange: AnalysisChartProps['onClearSelectedXRange'];
}

/**
 * Sélection d'une portion au glisser (zoom dessus, comme Komoot), clic simple
 * (centrage, ou tout le tronçon « Pente » cliqué), réinitialisation du zoom
 * (double-clic, Échap).
 */
export function usePlotRangeSelection({
  plotAreaRef,
  xDomain,
  plotXDomain,
  visibleFraction,
  detailZoom,
  slopeSegments,
  controlledSelectedXRange,
  onViewportChange,
  onDetailOffsetChange,
  onPlotClick,
  onPlotRangeSelect,
  onClearSelectedXRange,
}: UsePlotRangeSelectionOptions) {
  const [internalSelectedXRange, setInternalSelectedXRange] = useState<{ startX: number; endX: number } | null>(null);
  const selectedXRange = controlledSelectedXRange !== undefined ? controlledSelectedXRange : internalSelectedXRange;

  const [activeDragRange, setActiveDragRange] = useState<{ startX: number; endX: number } | null>(null);
  const dragStartRef = useRef<{ clientX: number; clientY: number; xValue: number } | null>(null);
  const isDraggingRef = useRef(false);

  const handlePointerDown = (event: ReactPointerEvent<HTMLDivElement>) => {
    if (event.button !== 0) return;
    const rect = plotAreaRef.current?.getBoundingClientRect();
    if (!rect || rect.width <= 0) return;

    const x = Math.max(0, Math.min(rect.width, event.clientX - rect.left));
    const ratioX = x / rect.width;
    const xValue = plotXDomain.min + ratioX * (plotXDomain.max - plotXDomain.min);

    dragStartRef.current = { clientX: event.clientX, clientY: event.clientY, xValue };
    isDraggingRef.current = false;
  };

  useEffect(() => {
    const handleWindowPointerMove = (e: PointerEvent) => {
      const dragStart = dragStartRef.current;
      if (!dragStart) return;

      const rect = plotAreaRef.current?.getBoundingClientRect();
      if (!rect || rect.width <= 0) return;

      const dx = Math.abs(e.clientX - dragStart.clientX);
      if (!isDraggingRef.current && dx >= 5) {
        isDraggingRef.current = true;
      }

      if (isDraggingRef.current) {
        const x = Math.max(0, Math.min(rect.width, e.clientX - rect.left));
        const ratioX = x / rect.width;
        const currentXVal = plotXDomain.min + ratioX * (plotXDomain.max - plotXDomain.min);
        setActiveDragRange({
          startX: dragStart.xValue,
          endX: currentXVal,
        });
      }
    };

    const handleWindowPointerUp = (e: PointerEvent) => {
      const dragStart = dragStartRef.current;
      if (!dragStart) return;

      const wasDragging = isDraggingRef.current;
      dragStartRef.current = null;
      isDraggingRef.current = false;

      const rect = plotAreaRef.current?.getBoundingClientRect();
      if (!rect || rect.width <= 0) {
        setActiveDragRange(null);
        return;
      }

      const x = Math.max(0, Math.min(rect.width, e.clientX - rect.left));
      const ratioX = x / rect.width;
      const currentXVal = plotXDomain.min + ratioX * (plotXDomain.max - plotXDomain.min);

      const selectRange = (minX: number, maxX: number) => {
        const range = {
          startX: minX,
          endX: maxX,
        };
        setActiveDragRange(null);
        setInternalSelectedXRange(range);
        onPlotRangeSelect?.(range);

        // Zoom in sur la portion sélectionnée dans le tableau / graphe d'altitude (comme sur Komoot)
        const fullSpan = xDomain.max - xDomain.min;
        const rangeSpan = maxX - minX;
        if (fullSpan > 0 && rangeSpan > 0) {
          const targetVisibleFraction = Math.max(MIN_VISIBLE_FRACTION, Math.min(1, rangeSpan / fullSpan));
          const targetSpan = fullSpan * targetVisibleFraction;
          const remainingSpan = Math.max(0, fullSpan - targetSpan);
          const start = Math.max(xDomain.min, Math.min(xDomain.max - targetSpan, minX));
          const nextOffset = remainingSpan <= 1e-6 ? 0 : Math.max(0, Math.min(1, (start - xDomain.min) / remainingSpan));
          const nextDetailZoom = visibleFractionToDetailZoom(targetVisibleFraction);

          onViewportChange?.({ detailZoom: nextDetailZoom, detailOffset: nextOffset });
          onDetailOffsetChange?.(nextOffset);
        }
      };

      if (wasDragging) {
        selectRange(Math.min(dragStart.xValue, currentXVal), Math.max(dragStart.xValue, currentXVal));
        return;
      }
      // Clic simple sur un tronçon « Pente » : comme un glisser sur tout le tronçon.
      const slopeSegment = slopeSegments ? slopeSegmentAtX(slopeSegments, dragStart.xValue) : null;
      if (slopeSegment && slopeSegment.endX > slopeSegment.startX) {
        selectRange(slopeSegment.startX, slopeSegment.endX);
        return;
      }
      // Clic simple sans glissement : centrage direct
      setActiveDragRange(null);
      onPlotClick?.(dragStart.xValue);
    };

    window.addEventListener('pointermove', handleWindowPointerMove);
    window.addEventListener('pointerup', handleWindowPointerUp);

    return () => {
      window.removeEventListener('pointermove', handleWindowPointerMove);
      window.removeEventListener('pointerup', handleWindowPointerUp);
    };
  }, [
    onDetailOffsetChange,
    onPlotClick,
    onPlotRangeSelect,
    onViewportChange,
    plotAreaRef,
    plotXDomain.max,
    plotXDomain.min,
    slopeSegments,
    xDomain.max,
    xDomain.min,
  ]);

  const handleResetZoom = useCallback(() => {
    onViewportChange?.({ detailZoom: 0, detailOffset: 0 });
    onDetailOffsetChange?.(0);
    setInternalSelectedXRange(null);
    setActiveDragRange(null);
    onClearSelectedXRange?.();
  }, [onClearSelectedXRange, onDetailOffsetChange, onViewportChange]);

  const isZoomed = useMemo(() => {
    return visibleFraction < 0.98 || normalizeUnitInterval(detailZoom) > 0.02;
  }, [detailZoom, visibleFraction]);

  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        if (isZoomed || selectedXRange || activeDragRange) {
          handleResetZoom();
        }
      }
    };
    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [activeDragRange, handleResetZoom, isZoomed, selectedXRange]);

  const selectionBand = useMemo(() => {
    const effectiveRange = activeDragRange;
    if (!effectiveRange) return null;

    const minX = Math.min(effectiveRange.startX, effectiveRange.endX);
    const maxX = Math.max(effectiveRange.startX, effectiveRange.endX);
    const startRatio = ratioFor(minX, plotXDomain);
    const endRatio = ratioFor(maxX, plotXDomain);

    if (endRatio <= 0 || startRatio >= 1) return null;

    return {
      startRatio,
      endRatio,
      startX: minX,
      endX: maxX,
      isDragging: true,
    };
  }, [activeDragRange, plotXDomain]);

  return { handlePointerDown, handleResetZoom, isZoomed, selectionBand };
}
