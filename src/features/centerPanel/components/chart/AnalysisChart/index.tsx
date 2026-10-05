import { useEffect, useMemo, useRef, useState, useCallback, memo, type CSSProperties } from 'react';
import { useChartHover } from '../useChartHover';
import { computeDomain, computeXDomain, isInclinationMetric, type AxisDomain } from '../series';
import '../chart.css';
import { AnalysisChartLayout } from './AnalysisChartLayout';
import { drawAnalysisChartCanvas } from './canvas';
import { withAlpha } from './color';
import { buildResponsiveXAxisLabels, buildXAxisTicks } from './format';
import {
  buildInterpolatedTicks,
  buildNiceDomain,
  buildNiceTicks,
  buildVisibleXDomain,
  clampXDomainToRoute,
  defaultDomainFor,
  detailZoomToVisibleFraction,
  normalizeMetricDomain,
  normalizeUnitInterval,
  ratioFor,
  selectPointsForPlotLod,
  visibleFractionToDetailZoom,
} from './math';
import { buildPoiMarkerGroups, buildViewportForPoiCluster } from './poi';
import { hasChartPoiIcon } from './poiSprites';
import {
  DEFAULT_TICK_COUNT,
  POI_CLUSTER_COMPACT_VISIBLE_FRACTION,
  Y_MAJOR_TARGET_PX,
  X_MAJOR_TARGET_PX,
  type AnalysisChartProps,
  type PoiMarkerGroup,
  type VisiblePoiAnnotation,
} from './types';
import { usePlotAreaSize } from './usePlotAreaSize';
import { useChartHoverRows } from './useChartHoverRows';
import { usePlotRangeSelection } from './usePlotRangeSelection';
import { translateAppText } from '@/shared/i18n';
import { useAppTheme } from '@/shared/lib/appTheme';
import { pickSlopeLevel } from '../slope';

export const AnalysisChart = memo(function AnalysisChart({
  series,
  chartNodes = [],
  backdropProfiles = [],
  poiAnnotations = [],
  dayNightOverlay = null,
  pauseOverlay = null,
  alertOverlay = null,
  slopeOverlay = null,
  axis1Metric,
  axis2Metric,
  xMode,
  detailZoom = 0,
  detailOffset = 0,
  yZoom = 0,
  yOffset = 0,
  xDomainClamp = null,
  onViewportChange,
  onYViewportChange,
  onDetailOffsetChange,
  onHoverXValueChange,
  controlledHoverXValue = null,
  onPlotClick,
  placementActive = false,
  onPoiClick,
  onAlertClick,
  onPlotRangeSelect,
  selectedXRange: controlledSelectedXRange,
  onClearSelectedXRange,
  showSeriesRows = true,
}: AnalysisChartProps) {
  const { ref: plotAreaRef, hover } = useChartHover<HTMLDivElement>();
  const seriesCanvasRef = useRef<HTMLCanvasElement>(null);
  const [expandedPoiClusterId, setExpandedPoiClusterId] = useState<string | null>(null);
  const plotSize = usePlotAreaSize(plotAreaRef);

  const xDomain = useMemo<AxisDomain>(() => {
    const allSeriesPoints = [
      ...series.map((entry) => entry.points),
      ...backdropProfiles.map((profile) => profile.points),
    ];
    const domain = computeXDomain(allSeriesPoints, xMode);
    const clamped = clampXDomainToRoute(domain, xDomainClamp);
    if (clamped) return clamped;
    if (xMode === 'distance') return { min: 0, max: 90 };
    if (xMode === 'heure') return { min: 0, max: 24 };
    return { min: 0, max: 6 };
  }, [backdropProfiles, series, xDomainClamp, xMode]);

  const visibleFraction = useMemo(() => detailZoomToVisibleFraction(normalizeUnitInterval(detailZoom)), [detailZoom]);
  const normalizedDetailOffset = useMemo(() => normalizeUnitInterval(detailOffset), [detailOffset]);
  const plotXDomain = useMemo(
    () => buildVisibleXDomain(xDomain, visibleFraction, normalizedDetailOffset),
    [normalizedDetailOffset, visibleFraction, xDomain],
  );

  const activeHover = useMemo(() => {
    if (hover != null) {
      return hover;
    }
    if (Number.isFinite(controlledHoverXValue) && plotSize.width > 0) {
      const val = controlledHoverXValue as number;
      if (val < plotXDomain.min - 1e-4 || val > plotXDomain.max + 1e-4) {
        return null;
      }
      const span = plotXDomain.max - plotXDomain.min;
      if (span > 0) {
        const ratioX = (val - plotXDomain.min) / span;
        return { x: ratioX * plotSize.width, ratioX };
      }
    }
    return null;
  }, [controlledHoverXValue, hover, plotSize.width, plotXDomain]);

  const xAxis = useMemo(
    () => buildXAxisTicks(plotXDomain.min, plotXDomain.max, plotSize.width, xMode, X_MAJOR_TARGET_PX),
    [plotSize.width, plotXDomain.max, plotXDomain.min, xMode],
  );
  const xTicks = xAxis.ticks;
  const visibleSeries = useMemo(() => (showSeriesRows ? series : []), [series, showSeriesRows]);

  const axis1Series = useMemo(() => series.filter((entry) => entry.axis === 1), [series]);
  const axis2Series = useMemo(() => series.filter((entry) => entry.axis === 2), [series]);

  const rawYDomain = useMemo<AxisDomain>(() => {
    const domain = computeDomain(axis1Series.map((entry) => entry.points));
    if (!domain) return defaultDomainFor(axis1Metric);
    const range = Math.max(1, domain.max - domain.min);
    const withHeadroom = {
      min: domain.min,
      max: domain.max + (isInclinationMetric(axis1Metric) ? 0 : range * 0.14),
    };
    return normalizeMetricDomain(axis1Metric, withHeadroom);
  }, [axis1Metric, axis1Series]);

  const rawY2Domain = useMemo<AxisDomain>(() => {
    if (!axis2Metric) return { min: 0, max: 1 };
    const domain = computeDomain(axis2Series.map((entry) => entry.points));
    if (!domain) return defaultDomainFor(axis2Metric);
    const range = Math.max(1, domain.max - domain.min);
    const withHeadroom = {
      min: domain.min,
      max: domain.max + (isInclinationMetric(axis2Metric) ? 0 : range * 0.14),
    };
    return normalizeMetricDomain(axis2Metric, withHeadroom);
  }, [axis2Metric, axis2Series]);

  const yVisibleFraction = useMemo(() => {
    return detailZoomToVisibleFraction(yZoom);
  }, [yZoom]);

  const normalizedYOffset = useMemo(() => {
    return normalizeUnitInterval(yOffset);
  }, [yOffset]);

  const yNiceBase = useMemo(() => {
    const target =
      plotSize.height > 0
        ? Math.max(2, Math.round(plotSize.height / Y_MAJOR_TARGET_PX))
        : DEFAULT_TICK_COUNT;
    const forceZero = axis1Metric !== 'Altitude' && !isInclinationMetric(axis1Metric);
    return buildNiceDomain(rawYDomain.min, rawYDomain.max, target, { forceZero });
  }, [axis1Metric, plotSize.height, rawYDomain]);

  const { plotYDomain, yTicks } = useMemo(() => {
    if (yVisibleFraction >= 0.999) {
      return {
        plotYDomain: yNiceBase.domain,
        yTicks: yNiceBase.ticks.slice().reverse(),
      };
    }
    const fullSpan = yNiceBase.domain.max - yNiceBase.domain.min;
    const visibleSpan = Math.max(1, fullSpan * yVisibleFraction);
    const startRatio = normalizedYOffset * (1 - yVisibleFraction);
    const effectiveMin = yNiceBase.domain.min + startRatio * fullSpan;
    const effectiveMax = effectiveMin + visibleSpan;
    const target = yNiceBase.ticks.length || DEFAULT_TICK_COUNT;
    const ticks = buildNiceTicks(effectiveMin, effectiveMax, target);
    return {
      plotYDomain: { min: effectiveMin, max: effectiveMax },
      yTicks: ticks.slice().reverse(),
    };
  }, [normalizedYOffset, yNiceBase, yVisibleFraction]);

  const y2NiceBase = useMemo(() => {
    if (!axis2Metric) return { domain: { min: 0, max: 1 }, ticks: [] };
    const target = yTicks.length || DEFAULT_TICK_COUNT;
    const forceZero = axis2Metric !== 'Altitude' && !isInclinationMetric(axis2Metric);
    return buildNiceDomain(rawY2Domain.min, rawY2Domain.max, target, { forceZero });
  }, [axis2Metric, rawY2Domain, yTicks.length]);

  const { plotY2Domain, y2Ticks } = useMemo(() => {
    if (!axis2Metric) {
      return { plotY2Domain: { min: 0, max: 1 }, y2Ticks: [] };
    }
    if (yVisibleFraction >= 0.999) {
      return {
        plotY2Domain: y2NiceBase.domain,
        y2Ticks: buildInterpolatedTicks(y2NiceBase.domain.max, y2NiceBase.domain.min, yTicks.length),
      };
    }
    const fullSpan = y2NiceBase.domain.max - y2NiceBase.domain.min;
    const visibleSpan = Math.max(1, fullSpan * yVisibleFraction);
    const startRatio = normalizedYOffset * (1 - yVisibleFraction);
    const effectiveMin = y2NiceBase.domain.min + startRatio * fullSpan;
    const effectiveMax = effectiveMin + visibleSpan;
    return {
      plotY2Domain: { min: effectiveMin, max: effectiveMax },
      y2Ticks: buildInterpolatedTicks(effectiveMax, effectiveMin, yTicks.length),
    };
  }, [axis2Metric, normalizedYOffset, y2NiceBase, yTicks.length, yVisibleFraction]);

  const xPositions = useMemo(
    () => xTicks.map((value) => ({ value, ratio: ratioFor(value, plotXDomain) })),
    [plotXDomain, xTicks],
  );
  const xAxisLabels = useMemo(
    () => buildResponsiveXAxisLabels(xPositions, xMode, plotSize.width, xAxis.density),
    [plotSize.width, xAxis.density, xMode, xPositions],
  );

  const yPositions = useMemo(
    () =>
      yTicks.map((value) => ({
        value,
        ratio: 1 - ratioFor(value, plotYDomain),
      })),
    [plotYDomain, yTicks],
  );

  const y2Positions = useMemo(
    () =>
      axis2Metric
        ? y2Ticks.map((value) => ({
            value,
            ratio: 1 - ratioFor(value, plotY2Domain),
          }))
        : [],
    [axis2Metric, plotY2Domain, y2Ticks],
  );

  const style = useMemo<CSSProperties>(
    () => ({
      ['--rvchart-left' as string]: '80px',
      ['--rvchart-right' as string]: axis2Metric ? '48px' : '0px',
    }),
    [axis2Metric],
  );

  const rawBackdropYDomain = useMemo<AxisDomain | null>(() => {
    const domain = computeDomain(backdropProfiles.map((profile) => profile.points));
    if (!domain) return null;
    const range = Math.max(1, domain.max - domain.min);
    return { min: domain.min, max: domain.max + range * 0.14 };
  }, [backdropProfiles]);

  const backdropNiceBase = useMemo(() => {
    if (!rawBackdropYDomain) return null;
    const target =
      plotSize.height > 0
        ? Math.max(2, Math.round(plotSize.height / Y_MAJOR_TARGET_PX))
        : DEFAULT_TICK_COUNT;
    return buildNiceDomain(rawBackdropYDomain.min, rawBackdropYDomain.max, target);
  }, [plotSize.height, rawBackdropYDomain]);

  const backdropYDomain = useMemo<AxisDomain | null>(() => {
    if (!backdropNiceBase) return null;
    if (yVisibleFraction >= 0.999) {
      return backdropNiceBase.domain;
    }
    const fullSpan = backdropNiceBase.domain.max - backdropNiceBase.domain.min;
    const visibleSpan = Math.max(1, fullSpan * yVisibleFraction);
    const startRatio = normalizedYOffset * (1 - yVisibleFraction);
    return {
      min: backdropNiceBase.domain.min + startRatio * fullSpan,
      max: backdropNiceBase.domain.min + startRatio * fullSpan + visibleSpan,
    };
  }, [backdropNiceBase, normalizedYOffset, yVisibleFraction]);

  // Courbe colorée par la pente : la première courbe d'altitude de l'itinéraire
  // de l'overlay (série d'axe, sinon profil d'altitude en fond).
  const slopeSeriesId = useMemo(() => {
    if (!slopeOverlay) return null;
    return series.find(
      (entry) => entry.metricId === 'Altitude' && entry.itineraryId === slopeOverlay.itineraryId,
    )?.id ?? null;
  }, [series, slopeOverlay]);
  const slopeBackdropId = useMemo(() => {
    if (!slopeOverlay || slopeSeriesId) return null;
    return backdropProfiles.find((profile) => profile.itineraryId === slopeOverlay.itineraryId)?.id ?? null;
  }, [backdropProfiles, slopeOverlay, slopeSeriesId]);
  // Tronçons moyennés au niveau de détail du zoom : grands blocs en vue
  // d'ensemble, détail fin en zoomant.
  const slopeSegments = useMemo(
    () => (slopeOverlay ? pickSlopeLevel(slopeOverlay, plotXDomain, plotSize.width)?.segments ?? null : null),
    [plotSize.width, plotXDomain, slopeOverlay],
  );

  const backdropSeries = useMemo(() => {
    if (!backdropYDomain) return [];
    return backdropProfiles.map((profile) => ({
      id: profile.id,
      fillColor: withAlpha(profile.color, 0.16),
      lineColor: withAlpha(profile.color, 0.72),
      points: selectPointsForPlotLod(profile.points, plotXDomain, plotSize.width),
      slopeSegments: profile.id === slopeBackdropId ? slopeSegments ?? undefined : undefined,
    }));
  }, [backdropProfiles, backdropYDomain, plotSize.width, plotXDomain, slopeBackdropId, slopeSegments]);

  const altitudeDomainForAnnotations = useMemo(() => {
    if (axis1Metric === 'Altitude') return plotYDomain;
    if (axis2Metric === 'Altitude') return plotY2Domain;
    return backdropYDomain ?? plotYDomain;
  }, [axis1Metric, axis2Metric, backdropYDomain, plotY2Domain, plotYDomain]);

  const visiblePoiAnnotations = useMemo<VisiblePoiAnnotation[]>(() => {
    if (!altitudeDomainForAnnotations || poiAnnotations.length === 0) return [];
    const result: VisiblePoiAnnotation[] = [];
    for (const annotation of poiAnnotations) {
      if (annotation.x < plotXDomain.min || annotation.x > plotXDomain.max) continue;
      if (!hasChartPoiIcon(annotation)) continue;
      result.push({
        ...annotation,
        xRatio: ratioFor(annotation.x, plotXDomain),
        yRatio: 1 - ratioFor(annotation.y, altitudeDomainForAnnotations),
      });
    }
    return result;
  }, [altitudeDomainForAnnotations, plotXDomain, poiAnnotations]);
  const poiMarkerGroups = useMemo(
    () => buildPoiMarkerGroups(visiblePoiAnnotations, visibleFraction),
    [visibleFraction, visiblePoiAnnotations],
  );

  const effectiveExpandedPoiClusterId =
    visibleFraction >= POI_CLUSTER_COMPACT_VISIBLE_FRACTION ? null : expandedPoiClusterId;

  const dayNightBands = useMemo(
    () =>
      (dayNightOverlay?.dayWindows ?? [])
        .map((window) => ({
          id: window.id,
          startRatio: ratioFor(window.startX, plotXDomain),
          endRatio: ratioFor(window.endX, plotXDomain),
        }))
        .filter((window) => window.endRatio - window.startRatio > 1e-4),
    [dayNightOverlay, plotXDomain],
  );

  const pauseBands = useMemo(
    () =>
      (pauseOverlay?.pauseWindows ?? [])
        .map((window) => ({
          id: window.id,
          startRatio: ratioFor(window.startX, plotXDomain),
          endRatio: ratioFor(window.endX, plotXDomain),
          label: window.label,
          durationMin: window.durationMin,
        }))
        .filter(
          (window) =>
            window.endRatio > 0 &&
            window.startRatio < 1 &&
            window.endRatio - window.startRatio > 1e-4,
        ),
    [pauseOverlay, plotXDomain],
  );
  const alertBands = useMemo(
    () =>
      (alertOverlay?.alertWindows ?? [])
        .map((window) => ({
          id: window.id,
          startRatio: ratioFor(window.startX, plotXDomain),
          endRatio: ratioFor(window.endX, plotXDomain),
          label: `${translateAppText('Pente')} ${Math.round(window.maxGradientPct)} % · ${Math.round(window.lengthM)} m`,
        }))
        .filter((window) => window.endRatio > 0 && window.startRatio < 1),
    [alertOverlay, plotXDomain],
  );
  const handleAlertClick = useCallback(
    (alertId: string) => {
      const alertWindow = alertOverlay?.alertWindows.find((candidate) => candidate.id === alertId);
      if (alertWindow) onAlertClick?.(alertWindow);
    },
    [alertOverlay, onAlertClick],
  );

  const nightFrames = useMemo(() => {
    if (dayNightBands.length === 0) return [];

    const frames: Array<{ id: string; startRatio: number; endRatio: number }> = [];
    let cursor = 0;
    for (const band of dayNightBands) {
      if (band.startRatio - cursor > 1e-4) {
        frames.push({
          id: `night-${frames.length + 1}`,
          startRatio: cursor,
          endRatio: band.startRatio,
        });
      }
      cursor = Math.max(cursor, band.endRatio);
    }
    if (1 - cursor > 1e-4) {
      frames.push({ id: `night-${frames.length + 1}`, startRatio: cursor, endRatio: 1 });
    }
    return frames.filter((frame) => frame.endRatio - frame.startRatio > 0.02);
  }, [dayNightBands]);

  const seriesLayers = useMemo(
    () =>
      series.map((entry) => ({
        id: entry.id,
        color: entry.color,
        fillColor: withAlpha(entry.color, 0.12),
        lineWidth: 2.0,
        points: selectPointsForPlotLod(entry.points, plotXDomain, plotSize.width),
        yDomain: entry.axis === 2 ? plotY2Domain : plotYDomain,
        slopeSegments: entry.id === slopeSeriesId ? slopeSegments ?? undefined : undefined,
      })),
    [plotSize.width, plotXDomain, plotY2Domain, plotYDomain, series, slopeSegments, slopeSeriesId],
  );

  const theme = useAppTheme();
  useEffect(() => {
    drawAnalysisChartCanvas(seriesCanvasRef.current, {
      width: plotSize.width,
      height: plotSize.height,
      xDomain: plotXDomain,
      backdropYDomain,
      backdropSeries,
      seriesLayers,
      theme,
    });
  }, [backdropSeries, backdropYDomain, plotSize.height, plotSize.width, plotXDomain, seriesLayers, theme]);

  const hoverXValue = activeHover
    ? plotXDomain.min + activeHover.ratioX * (plotXDomain.max - plotXDomain.min)
    : null;
  const { hoverRows, hoverMarkers, hoverSlopeSegment } = useChartHoverRows({
    hoverXValue,
    hasActiveHover: activeHover != null,
    series,
    chartNodes,
    backdropProfiles,
    alertOverlay,
    slopeOverlay,
    slopeSegments,
    xMode,
    plotYDomain,
    plotY2Domain,
    backdropYDomain,
  });

  // Survol local terminé alors qu'une valeur est imposée (survol de la carte,
  // sélection, tête du flyover) : signalé une fois, sans renvoyer la valeur
  // imposée en écho.
  const hadLocalHoverRef = useRef(false);
  useEffect(() => {
    if (!onHoverXValueChange) return;
    if (Number.isFinite(controlledHoverXValue) && hover == null) {
      if (hadLocalHoverRef.current) {
        hadLocalHoverRef.current = false;
        onHoverXValueChange(null);
      }
      return;
    }
    hadLocalHoverRef.current = hover != null;
    onHoverXValueChange(hoverXValue);
  }, [controlledHoverXValue, hover, hoverXValue, onHoverXValueChange]);
  const { handlePointerDown, handleResetZoom, isZoomed, selectionBand } = usePlotRangeSelection({
    plotAreaRef,
    xDomain,
    plotXDomain,
    visibleFraction,
    detailZoom,
    slopeSegments: placementActive ? null : slopeSegments,
    controlledSelectedXRange,
    onViewportChange,
    onDetailOffsetChange,
    onPlotClick,
    onPlotRangeSelect,
    onClearSelectedXRange,
  });

  const handlePoiClusterClick = (group: PoiMarkerGroup) => {
    setExpandedPoiClusterId(group.id);
    const nextViewport = buildViewportForPoiCluster({
      members: group.members,
      count: group.count,
      xDomain,
      plotXDomain,
      plotWidth: plotSize.width,
    });
    if (nextViewport) onViewportChange?.(nextViewport);
  };

  const handleHorizontalNavigatorChange = useCallback(
    (next: { visibleFraction: number; offset: number }) => {
      const nextDetailZoom = visibleFractionToDetailZoom(next.visibleFraction);
      onViewportChange?.({ detailZoom: nextDetailZoom, detailOffset: next.offset });
      onDetailOffsetChange?.(next.offset);
    },
    [onDetailOffsetChange, onViewportChange],
  );

  const handleVerticalNavigatorChange = useCallback(
    (next: { visibleFraction: number; offset: number }) => {
      const nextYZoom = visibleFractionToDetailZoom(next.visibleFraction);
      onYViewportChange?.({ yZoom: nextYZoom, yOffset: next.offset });
    },
    [onYViewportChange],
  );

  return (
    <AnalysisChartLayout
      style={style}
      axis1Metric={axis1Metric}
      axis2Metric={axis2Metric}
      plotAreaRef={plotAreaRef}
      onPlotPointerDown={handlePointerDown}
      onPlotDoubleClick={handleResetZoom}
      plotPointerOverSegment={!placementActive && hoverSlopeSegment != null}
      onResetZoom={handleResetZoom}
      isZoomed={isZoomed}
      selectionBand={selectionBand}
      dayNightBands={dayNightBands}
      pauseBands={pauseBands}
      alertBands={alertBands}
      onAlertClick={handleAlertClick}
      yPositions={yPositions}
      y2Positions={y2Positions}
      xPositions={xPositions}
      nightFrames={nightFrames}
      seriesCanvasRef={seriesCanvasRef}
      plotWidth={plotSize.width}
      plotHeight={plotSize.height}
      poiMarkerGroups={poiMarkerGroups}
      visibleFraction={visibleFraction}
      expandedPoiClusterId={effectiveExpandedPoiClusterId}
      onPoiClusterClick={handlePoiClusterClick}
      onPoiClick={onPoiClick}
      activeHover={activeHover}
      hoverMarkers={hoverMarkers}
      hoverXValue={hoverXValue}
      xMode={xMode}
      hoverRows={hoverRows}
      xAxisLabels={xAxisLabels}
      normalizedDetailOffset={normalizedDetailOffset}
      yVisibleFraction={yVisibleFraction}
      normalizedYOffset={normalizedYOffset}
      onHorizontalNavigatorChange={handleHorizontalNavigatorChange}
      onVerticalNavigatorChange={handleVerticalNavigatorChange}
      showSeriesRows={showSeriesRows}
      visibleSeries={visibleSeries}
    />
  );
});
