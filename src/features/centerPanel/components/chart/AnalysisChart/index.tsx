import { useEffect, useMemo, useRef, useState, memo, type CSSProperties, type MouseEvent as ReactMouseEvent } from 'react';
import { useChartHover } from '../useChartHover';
import { computeDomain, computeXDomain, isInclinationMetric, type AxisDomain, type ChartMetricId } from '../series';
import '../chart.css';
import { AnalysisChartLayout } from './AnalysisChartLayout';
import { drawAnalysisChartCanvas } from './canvas';
import { buildResponsiveXAxisLabels } from './format';
import {
  buildInterpolatedTicks,
  buildNiceDomain,
  buildNiceXTicks,
  buildVisibleXDomain,
  clampXDomainToRoute,
  computeCumulativeElevationAtX,
  defaultDomainFor,
  detailZoomToVisibleFraction,
  interpolateY,
  normalizeMetricDomain,
  normalizeUnitInterval,
  ratioFor,
  selectPointsForPlotLod,
} from './math';
import { buildPoiMarkerGroups, buildViewportForPoiCluster } from './poi';
import {
  DEFAULT_TICK_COUNT,
  POI_CLUSTER_COMPACT_VISIBLE_FRACTION,
  Y_MAJOR_TARGET_PX,
  X_MAJOR_TARGET_PX,
  type AnalysisChartProps,
  type HoverCardRow,
  type PoiMarkerGroup,
} from './types';
import { usePlotAreaSize } from './usePlotAreaSize';

function pointSeriesCoversX(points: Array<{ x: number; y: number }>, xValue: number): boolean {
  if (!Number.isFinite(xValue) || points.length === 0) return false;
  const firstPoint = points[0];
  const lastPoint = points[points.length - 1];
  if (!firstPoint || !lastPoint) return false;
  return xValue >= firstPoint.x && xValue <= lastPoint.x;
}

export const AnalysisChart = memo(function AnalysisChart({
  series,
  backdropProfiles = [],
  poiAnnotations = [],
  alertAnnotations = [],
  dayNightOverlay = null,
  axis1Metric,
  axis2Metric,
  xMode,
  detailZoom = 0,
  detailOffset = 0,
  xDomainClamp = null,
  onViewportChange,
  onDetailOffsetChange,
  onHoverXValueChange,
  controlledHoverXValue = null,
  onPlotClick,
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
    if (Number.isFinite(controlledHoverXValue) && plotSize.width > 0) {
      const span = plotXDomain.max - plotXDomain.min;
      if (span > 0) {
        const clampedXValue = Math.max(
          plotXDomain.min,
          Math.min(plotXDomain.max, controlledHoverXValue as number),
        );
        const ratioX = (clampedXValue - plotXDomain.min) / span;
        return { x: ratioX * plotSize.width, ratioX };
      }
    }
    return hover;
  }, [controlledHoverXValue, hover, plotSize.width, plotXDomain]);

  const xNice = useMemo(() => {
    const target = Math.max(2, Math.round(plotSize.width / X_MAJOR_TARGET_PX));
    return buildNiceXTicks(plotXDomain.min, plotXDomain.max, target || DEFAULT_TICK_COUNT);
  }, [plotSize.width, plotXDomain.max, plotXDomain.min]);
  const xTicks = xNice;
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
    const domain = computeDomain(axis2Series.map((entry) => entry.points));
    if (!domain) return defaultDomainFor(axis2Metric);
    const range = Math.max(1, domain.max - domain.min);
    const withHeadroom = {
      min: domain.min,
      max: domain.max + (isInclinationMetric(axis2Metric) ? 0 : range * 0.14),
    };
    return normalizeMetricDomain(axis2Metric, withHeadroom);
  }, [axis2Metric, axis2Series]);

  const yNice = useMemo(() => {
    const target =
      plotSize.height > 0
        ? Math.max(2, Math.round(plotSize.height / Y_MAJOR_TARGET_PX))
        : DEFAULT_TICK_COUNT;
    const forceZero = axis1Metric !== 'Altitude' && !isInclinationMetric(axis1Metric);
    return buildNiceDomain(rawYDomain.min, rawYDomain.max, target, { forceZero });
  }, [axis1Metric, plotSize.height, rawYDomain]);

  const plotYDomain = yNice.domain;
  const yTicksAsc = yNice.ticks;
  const yTicks = useMemo(() => yTicksAsc.slice().reverse(), [yTicksAsc]);

  const y2Nice = useMemo(() => {
    const target = yTicks.length || DEFAULT_TICK_COUNT;
    const forceZero = axis2Metric !== 'Altitude' && !isInclinationMetric(axis2Metric);
    return buildNiceDomain(rawY2Domain.min, rawY2Domain.max, target, { forceZero });
  }, [axis2Metric, rawY2Domain, yTicks.length]);

  const plotY2Domain = y2Nice.domain;
  const y2Ticks = useMemo(
    () => buildInterpolatedTicks(plotY2Domain.max, plotY2Domain.min, yTicks.length),
    [plotY2Domain.max, plotY2Domain.min, yTicks.length],
  );

  const xPositions = useMemo(
    () => xTicks.map((value) => ({ value, ratio: ratioFor(value, plotXDomain) })),
    [plotXDomain, xTicks],
  );
  const xAxisLabels = useMemo(
    () => buildResponsiveXAxisLabels(xPositions, xMode, plotSize.width),
    [plotSize.width, xMode, xPositions],
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
      y2Ticks.map((value) => ({
        value,
        ratio: 1 - ratioFor(value, plotY2Domain),
      })),
    [plotY2Domain, y2Ticks],
  );

  const style = useMemo<CSSProperties>(
    () => ({ ['--rvchart-left' as string]: '95px', ['--rvchart-right' as string]: '60px' }),
    [],
  );

  const rawBackdropYDomain = useMemo<AxisDomain | null>(() => {
    const domain = computeDomain(backdropProfiles.map((profile) => profile.points));
    if (!domain) return null;
    const range = Math.max(1, domain.max - domain.min);
    return { min: domain.min, max: domain.max + range * 0.14 };
  }, [backdropProfiles]);

  const backdropYDomain = useMemo<AxisDomain | null>(() => {
    if (!rawBackdropYDomain) return null;
    const target =
      plotSize.height > 0
        ? Math.max(2, Math.round(plotSize.height / Y_MAJOR_TARGET_PX))
        : DEFAULT_TICK_COUNT;
    return buildNiceDomain(rawBackdropYDomain.min, rawBackdropYDomain.max, target).domain;
  }, [plotSize.height, rawBackdropYDomain]);

  const backdropSeries = useMemo(() => {
    if (!backdropYDomain) return [];
    return backdropProfiles.map((profile) => ({
      id: profile.id,
      fillColor: withAlpha(profile.color, 0.16),
      lineColor: withAlpha(profile.color, 0.72),
      points: selectPointsForPlotLod(profile.points, plotXDomain, plotSize.width),
    }));
  }, [backdropProfiles, backdropYDomain, plotSize.width, plotXDomain]);

  const altitudeDomainForAnnotations = useMemo(() => {
    if (axis1Metric === 'Altitude') return plotYDomain;
    return backdropYDomain ?? plotYDomain;
  }, [axis1Metric, backdropYDomain, plotYDomain]);

  const visiblePoiAnnotations = useMemo(() => {
    if (!altitudeDomainForAnnotations || poiAnnotations.length === 0) return [];
    return poiAnnotations
      .filter((annotation) => annotation.x >= plotXDomain.min && annotation.x <= plotXDomain.max)
      .map((annotation) => ({
        ...annotation,
        xRatio: ratioFor(annotation.x, plotXDomain),
        yRatio: 1 - ratioFor(annotation.y, altitudeDomainForAnnotations),
        xPx: ratioFor(annotation.x, plotXDomain) * plotSize.width,
        yPx: (1 - ratioFor(annotation.y, altitudeDomainForAnnotations)) * plotSize.height,
      }));
  }, [altitudeDomainForAnnotations, plotSize.height, plotSize.width, plotXDomain, poiAnnotations]);
  const poiMarkerGroups = useMemo(
    () => buildPoiMarkerGroups(visiblePoiAnnotations, visibleFraction),
    [visibleFraction, visiblePoiAnnotations],
  );
  const visibleAlertAnnotations = useMemo(() => {
    if (!altitudeDomainForAnnotations || alertAnnotations.length === 0) return [];
    return alertAnnotations
      .filter((annotation) => annotation.x >= plotXDomain.min && annotation.x <= plotXDomain.max)
      .map((annotation) => ({
        ...annotation,
        xRatio: ratioFor(annotation.x, plotXDomain),
        yRatio: 1 - ratioFor(annotation.y, altitudeDomainForAnnotations),
      }));
  }, [alertAnnotations, altitudeDomainForAnnotations, plotXDomain]);

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
    return frames.filter((frame) => frame.endRatio - frame.startRatio > 0.06);
  }, [dayNightBands]);

  const seriesLayers = useMemo(
    () =>
      series.map((entry) => ({
        id: entry.id,
        color: entry.color,
        lineWidth: 2.0,
        points: selectPointsForPlotLod(entry.points, plotXDomain, plotSize.width),
        yDomain: entry.axis === 2 ? plotY2Domain : plotYDomain,
      })),
    [plotSize.width, plotXDomain, plotY2Domain, plotYDomain, series],
  );

  useEffect(() => {
    drawAnalysisChartCanvas(seriesCanvasRef.current, {
      width: plotSize.width,
      height: plotSize.height,
      xDomain: plotXDomain,
      backdropYDomain,
      backdropSeries,
      seriesLayers,
    });
  }, [backdropSeries, backdropYDomain, plotSize.height, plotSize.width, plotXDomain, seriesLayers]);

  const hoverXValue = activeHover
    ? plotXDomain.min + activeHover.ratioX * (plotXDomain.max - plotXDomain.min)
    : null;
  const hoverData = useMemo<HoverCardRow[] | null>(() => {
    if (hoverXValue == null || !series.length) return null;
    return series
      .map<HoverCardRow | null>((entry) => {
        if (!pointSeriesCoversX(entry.points, hoverXValue)) return null;
        const val = interpolateY(entry.points, hoverXValue);
        if (!Number.isFinite(val)) return null;

        const matchingProfile = backdropProfiles.find(
          (p) => p.itineraryName === entry.itineraryName,
        );
        const { gainM, lossM } = matchingProfile
          ? computeCumulativeElevationAtX(matchingProfile.points, hoverXValue)
          : { gainM: undefined, lossM: undefined };

        return {
          id: entry.id,
          itineraryName: entry.itineraryName,
          color: entry.color,
          axis: entry.axis,
          axisLabel: `Axe ${entry.axis}`,
          metric: entry.metricId,
          value: val,
          gainM,
          lossM,
        };
      })
      .filter((entry): entry is HoverCardRow => entry !== null);
  }, [backdropProfiles, hoverXValue, series]);

  const hoverBackdropData = useMemo<HoverCardRow[]>(() => {
    if (hoverXValue == null || !backdropProfiles.length) return [];
    const hasAltitudeSeries = series.some((entry) => entry.metricId === 'Altitude');
    if (hasAltitudeSeries) return [];

    return backdropProfiles
      .map<HoverCardRow | null>((profile) => {
        if (!pointSeriesCoversX(profile.points, hoverXValue)) return null;
        const value = interpolateY(profile.points, hoverXValue);
        if (!Number.isFinite(value)) return null;
        const { gainM, lossM } = computeCumulativeElevationAtX(profile.points, hoverXValue);
        return {
          id: `${profile.id}::hover-altitude`,
          itineraryName: profile.itineraryName,
          color: withAlpha(profile.color, 0.95),
          axis: null,
          axisLabel: "Profil d'altitude",
          metric: 'Altitude' as ChartMetricId,
          value,
          gainM,
          lossM,
        };
      })
      .filter((entry): entry is HoverCardRow => entry !== null);
  }, [backdropProfiles, hoverXValue, series]);

  const hoverRows = useMemo(
    () => [...(hoverData ?? []), ...hoverBackdropData],
    [hoverBackdropData, hoverData],
  );

  const hoverMarkers = useMemo(() => {
    if (hoverXValue == null || !activeHover) return [];

    const markers: Array<{ id: string; topRatio: number; color: string; backdrop: boolean }> = [];
    const hasAltitudeSeries = series.some((entry) => entry.metricId === 'Altitude');

    if (!hasAltitudeSeries && backdropYDomain) {
      for (const profile of backdropProfiles) {
        if (!pointSeriesCoversX(profile.points, hoverXValue)) continue;
        const yValue = interpolateY(profile.points, hoverXValue);
        if (!Number.isFinite(yValue)) continue;
        const ratio = ratioFor(yValue, backdropYDomain);
        markers.push({
          id: `${profile.id}::backdrop-marker`,
          topRatio: 1 - ratio,
          color: withAlpha(profile.color, 0.98),
          backdrop: true,
        });
      }
    }

    for (const entry of series) {
      if (!pointSeriesCoversX(entry.points, hoverXValue)) continue;
      const yValue = interpolateY(entry.points, hoverXValue);
      if (!Number.isFinite(yValue)) continue;
      const domain = entry.axis === 2 ? plotY2Domain : plotYDomain;
      const ratio = ratioFor(yValue, domain);
      markers.push({
        id: `${entry.id}::series-marker`,
        topRatio: 1 - ratio,
        color: entry.color,
        backdrop: false,
      });
    }

    return markers;
  }, [activeHover, backdropProfiles, backdropYDomain, hoverXValue, plotY2Domain, plotYDomain, series]);

  useEffect(() => {
    if (!onHoverXValueChange) return;
    if (Number.isFinite(controlledHoverXValue)) return;
    onHoverXValueChange(hoverXValue);
  }, [controlledHoverXValue, hoverXValue, onHoverXValueChange]);

  const handlePlotClick = (event: ReactMouseEvent<HTMLDivElement>) => {
    if (!onPlotClick || event.button !== 0) return;
    const rect = event.currentTarget.getBoundingClientRect();
    if (rect.width <= 0) return;
    const x = Math.max(0, Math.min(rect.width, event.clientX - rect.left));
    const ratioX = x / rect.width;
    onPlotClick(plotXDomain.min + ratioX * (plotXDomain.max - plotXDomain.min));
  };

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

  return (
    <AnalysisChartLayout
      style={style}
      axis1Metric={axis1Metric}
      axis2Metric={axis2Metric}
      plotAreaRef={plotAreaRef}
      handlePlotClick={handlePlotClick}
      dayNightBands={dayNightBands}
      yPositions={yPositions}
      y2Positions={y2Positions}
      xPositions={xPositions}
      nightFrames={nightFrames}
      seriesCanvasRef={seriesCanvasRef}
      visibleAlertAnnotations={visibleAlertAnnotations}
      poiMarkerGroups={poiMarkerGroups}
      visibleFraction={visibleFraction}
      expandedPoiClusterId={effectiveExpandedPoiClusterId}
      onPoiClusterClick={handlePoiClusterClick}
      activeHover={activeHover}
      hoverMarkers={hoverMarkers}
      hoverXValue={hoverXValue}
      xMode={xMode}
      hoverRows={hoverRows}
      xAxisLabels={xAxisLabels}
      normalizedDetailOffset={normalizedDetailOffset}
      onDetailOffsetChange={onDetailOffsetChange}
      showSeriesRows={showSeriesRows}
      visibleSeries={visibleSeries}
    />
  );
});

function withAlpha(color: string, alpha: number): string {
  const normalizedAlpha = Math.max(0, Math.min(1, alpha));
  const hex = color.trim();
  const match = /^#([0-9a-f]{6}|[0-9a-f]{3})$/i.exec(hex);
  if (!match) return color;

  const raw = match[1];
  const expanded = raw.length === 3
    ? raw.split('').map((channel) => channel + channel).join('')
    : raw;
  const red = Number.parseInt(expanded.slice(0, 2), 16);
  const green = Number.parseInt(expanded.slice(2, 4), 16);
  const blue = Number.parseInt(expanded.slice(4, 6), 16);
  return `rgba(${red}, ${green}, ${blue}, ${normalizedAlpha})`;
}