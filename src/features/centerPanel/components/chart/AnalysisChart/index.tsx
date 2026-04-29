import { useEffect, useMemo, useRef, useState, type CSSProperties, type MouseEvent as ReactMouseEvent } from 'react';
import { useChartHover } from '../useChartHover';
import { computeDomain, computeXDomain, type AxisDomain, type ChartMetricId } from '../series';
import '../chart.css';
import { AnalysisChartLayout } from './AnalysisChartLayout';
import { drawAnalysisChartCanvas } from './canvas';
import { buildResponsiveXAxisLabels } from './format';
import {
  buildInterpolatedTicks,
  buildNiceTicks,
  buildVisibleXDomain,
  clampXDomainToRoute,
  clipPointsToXDomain,
  defaultDomainFor,
  detailZoomToVisibleFraction,
  interpolateY,
  normalizeMetricDomain,
  normalizeUnitInterval,
  ratioFor,
  selectPointsForPlotLod,
  sameOptionalNumber,
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

export function AnalysisChart({
  series,
  backdropProfiles = [],
  poiAnnotations = [],
  alertAnnotations = [],
  dayNightOverlay = null,
  axis1Metric,
  axis2Metric,
  xMode,
  detailZoom,
  detailOffset,
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
  const hoverCallbackFrameRef = useRef<number | null>(null);
  const pendingHoverXValueRef = useRef<number | null>(null);
  const lastEmittedHoverXValueRef = useRef<number | null>(null);
  const [expandedPoiClusterId, setExpandedPoiClusterId] = useState<string | null>(null);
  const plotSize = usePlotAreaSize(plotAreaRef);

  useEffect(
    () => () => {
      if (hoverCallbackFrameRef.current !== null) {
        window.cancelAnimationFrame(hoverCallbackFrameRef.current);
      }
    },
    [],
  );

  const xDomain = useMemo<AxisDomain>(() => {
    const domain = computeXDomain(series.map((entry) => entry.points), xMode);
    const clamped = clampXDomainToRoute(domain, xDomainClamp);
    if (clamped) return clamped;
    if (xMode === 'distance') return { min: 0, max: 90 };
    if (xMode === 'heure') return { min: 0, max: 24 };
    return { min: 0, max: 6 };
  }, [series, xDomainClamp, xMode]);

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

  const xTicks = useMemo(() => {
    const target = Math.max(2, Math.round(plotSize.width / X_MAJOR_TARGET_PX));
    return buildNiceTicks(plotXDomain.min, plotXDomain.max, target || DEFAULT_TICK_COUNT);
  }, [plotSize.width, plotXDomain.max, plotXDomain.min]);
  const visibleSeries = useMemo(
    () =>
      series.map((entry) => ({
        ...entry,
        points: clipPointsToXDomain(entry.points, plotXDomain),
      })),
    [plotXDomain, series],
  );

  const axis1Series = useMemo(() => series.filter((entry) => entry.axis === 1), [series]);
  const axis2Series = useMemo(() => series.filter((entry) => entry.axis === 2), [series]);
  const yDomain = useMemo<AxisDomain>(() => {
    const domain = computeDomain(axis1Series.map((entry) => entry.points));
    return domain ? normalizeMetricDomain(axis1Metric, domain) : defaultDomainFor(axis1Metric);
  }, [axis1Metric, axis1Series]);
  const y2Domain = useMemo<AxisDomain>(() => {
    const domain = computeDomain(axis2Series.map((entry) => entry.points));
    return domain ? normalizeMetricDomain(axis2Metric, domain) : defaultDomainFor(axis2Metric);
  }, [axis2Metric, axis2Series]);

  const yTicksAsc = useMemo(() => {
    const target =
      plotSize.height > 0
        ? Math.max(2, Math.round(plotSize.height / Y_MAJOR_TARGET_PX))
        : DEFAULT_TICK_COUNT;
    return buildNiceTicks(yDomain.min, yDomain.max, target);
  }, [plotSize.height, yDomain.max, yDomain.min]);
  const yTicks = useMemo(() => yTicksAsc.slice().reverse(), [yTicksAsc]);
  const plotYDomain = useMemo<AxisDomain>(() => {
    if (yTicksAsc.length === 0) return yDomain;
    return {
      min: yTicksAsc[0] ?? yDomain.min,
      max: yTicksAsc[yTicksAsc.length - 1] ?? yDomain.max,
    };
  }, [yDomain, yTicksAsc]);
  const y2Ticks = useMemo(
    () => buildInterpolatedTicks(y2Domain.max, y2Domain.min, yTicks.length),
    [y2Domain.max, y2Domain.min, yTicks.length],
  );
  const plotY2Domain = useMemo<AxisDomain>(() => {
    if (y2Ticks.length === 0) return y2Domain;
    return {
      min: y2Ticks[y2Ticks.length - 1] ?? y2Domain.min,
      max: y2Ticks[0] ?? y2Domain.max,
    };
  }, [y2Domain, y2Ticks]);

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
      yTicks.map((value, index) => ({
        value,
        ratio: yTicks.length > 1 ? index / (yTicks.length - 1) : 0,
      })),
    [yTicks],
  );
  const style = useMemo<CSSProperties>(
    () => ({ ['--rvchart-left' as string]: '95px', ['--rvchart-right' as string]: '60px' }),
    [],
  );

  const backdropYDomain = useMemo<AxisDomain | null>(
    () => computeDomain(backdropProfiles.map((profile) => profile.points)),
    [backdropProfiles],
  );
  const backdropSeries = useMemo(() => {
    if (!backdropYDomain) return [];
    return backdropProfiles.map((profile) => ({
      id: profile.id,
      fillColor: withAlpha(profile.color, 0.12),
      lineColor: withAlpha(profile.color, 0.46),
      points: selectPointsForPlotLod(profile.points, plotXDomain, plotSize.width),
    }));
  }, [backdropProfiles, backdropYDomain, plotSize.width, plotXDomain]);

  const visiblePoiAnnotations = useMemo(() => {
    if (!backdropYDomain || poiAnnotations.length === 0) return [];
    return poiAnnotations
      .filter((annotation) => annotation.x >= plotXDomain.min && annotation.x <= plotXDomain.max)
      .map((annotation) => ({
        ...annotation,
        xRatio: ratioFor(annotation.x, plotXDomain),
        yRatio: 1 - ratioFor(annotation.y, backdropYDomain),
        xPx: ratioFor(annotation.x, plotXDomain) * plotSize.width,
        yPx: (1 - ratioFor(annotation.y, backdropYDomain)) * plotSize.height,
      }));
  }, [backdropYDomain, plotSize.height, plotSize.width, plotXDomain, poiAnnotations]);
  const poiMarkerGroups = useMemo(
    () => buildPoiMarkerGroups(visiblePoiAnnotations, visibleFraction),
    [visibleFraction, visiblePoiAnnotations],
  );
  const visibleAlertAnnotations = useMemo(() => {
    if (!backdropYDomain || alertAnnotations.length === 0) return [];
    return alertAnnotations
      .filter((annotation) => annotation.x >= plotXDomain.min && annotation.x <= plotXDomain.max)
      .map((annotation) => ({
        ...annotation,
        xRatio: ratioFor(annotation.x, plotXDomain),
        yRatio: 1 - ratioFor(annotation.y, backdropYDomain),
      }));
  }, [alertAnnotations, backdropYDomain, plotXDomain]);

  useEffect(() => {
    if (visibleFraction >= POI_CLUSTER_COMPACT_VISIBLE_FRACTION) {
      setExpandedPoiClusterId(null);
    }
  }, [visibleFraction]);

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
        lineWidth: 1.4,
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
    if (hoverXValue == null || !visibleSeries.length) return null;
    return visibleSeries
      .map<HoverCardRow | null>((entry) => {
        if (!pointSeriesCoversX(entry.points, hoverXValue)) return null;
        return {
          id: entry.id,
          itineraryName: entry.itineraryName,
          color: entry.color,
          axis: entry.axis,
          axisLabel: `Axe ${entry.axis}`,
          metric: entry.metricId,
          value: interpolateY(entry.points, hoverXValue),
        };
      })
      .filter((entry): entry is HoverCardRow => entry !== null);
  }, [hoverXValue, visibleSeries]);
  const hoverBackdropData = useMemo<HoverCardRow[]>(() => {
    if (hoverXValue == null || !backdropProfiles.length) return [];
    return backdropProfiles
      .map<HoverCardRow | null>((profile) => {
        if (!pointSeriesCoversX(profile.points, hoverXValue)) return null;
        const value = interpolateY(profile.points, hoverXValue);
        if (!Number.isFinite(value)) return null;
        return {
          id: `${profile.id}::hover-altitude`,
          itineraryName: profile.itineraryName,
          color: withAlpha(profile.color, 0.92),
          axis: null,
          axisLabel: "Profil d'altitude",
          metric: 'Altitude' as ChartMetricId,
          value,
        };
      })
      .filter((entry): entry is HoverCardRow => entry !== null);
  }, [backdropProfiles, hoverXValue]);
  const hoverRows = useMemo(
    () => [...(hoverData ?? []), ...hoverBackdropData],
    [hoverBackdropData, hoverData],
  );

  const hoverMarkers = useMemo(() => {
    if (hoverXValue == null || !activeHover) return [];

    const seriesPoints = visibleSeries
      .map((entry) => {
        if (!pointSeriesCoversX(entry.points, hoverXValue)) return null;
        const yValue = interpolateY(entry.points, hoverXValue);
        if (!Number.isFinite(yValue)) return null;
        const domain = entry.axis === 2 ? plotY2Domain : plotYDomain;
        return {
          id: `${entry.id}::marker`,
          topPx: (1 - ratioFor(yValue, domain)) * plotSize.height,
          color: entry.color,
          backdrop: false,
        };
      })
      .filter((entry): entry is NonNullable<typeof entry> => Boolean(entry));

    const backdropPoints = backdropProfiles
      .map((profile) => {
        if (!backdropYDomain) return null;
        if (!pointSeriesCoversX(profile.points, hoverXValue)) return null;
        const yValue = interpolateY(profile.points, hoverXValue);
        if (!Number.isFinite(yValue)) return null;
        return {
          id: `${profile.id}::marker`,
          topPx: (1 - ratioFor(yValue, backdropYDomain)) * plotSize.height,
          color: withAlpha(profile.color, 0.96),
          backdrop: true,
        };
      })
      .filter((entry): entry is NonNullable<typeof entry> => Boolean(entry));

    return [...backdropPoints, ...seriesPoints];
  }, [activeHover, backdropProfiles, backdropYDomain, hoverXValue, plotSize.height, plotY2Domain, plotYDomain, visibleSeries]);

  useEffect(() => {
    if (!onHoverXValueChange) return;
    if (Number.isFinite(controlledHoverXValue)) return;
    pendingHoverXValueRef.current = hoverXValue;
    if (hoverCallbackFrameRef.current !== null) return;

    hoverCallbackFrameRef.current = window.requestAnimationFrame(() => {
      hoverCallbackFrameRef.current = null;
      const nextHoverXValue = pendingHoverXValueRef.current;
      pendingHoverXValueRef.current = null;
      if (sameOptionalNumber(lastEmittedHoverXValueRef.current, nextHoverXValue)) return;
      lastEmittedHoverXValueRef.current = nextHoverXValue;
      onHoverXValueChange(nextHoverXValue);
    });
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
      yTicks={yTicks}
      axis1Metric={axis1Metric}
      axis2Metric={axis2Metric}
      plotAreaRef={plotAreaRef}
      handlePlotClick={handlePlotClick}
      dayNightBands={dayNightBands}
      yPositions={yPositions}
      xPositions={xPositions}
      nightFrames={nightFrames}
      seriesCanvasRef={seriesCanvasRef}
      visibleAlertAnnotations={visibleAlertAnnotations}
      poiMarkerGroups={poiMarkerGroups}
      visibleFraction={visibleFraction}
      expandedPoiClusterId={expandedPoiClusterId}
      onPoiClusterClick={handlePoiClusterClick}
      activeHover={activeHover}
      hoverMarkers={hoverMarkers}
      hoverXValue={hoverXValue}
      xMode={xMode}
      hoverRows={hoverRows}
      y2Ticks={y2Ticks}
      xAxisLabels={xAxisLabels}
      normalizedDetailOffset={normalizedDetailOffset}
      onDetailOffsetChange={onDetailOffsetChange}
      showSeriesRows={showSeriesRows}
      visibleSeries={visibleSeries}
    />
  );
}

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