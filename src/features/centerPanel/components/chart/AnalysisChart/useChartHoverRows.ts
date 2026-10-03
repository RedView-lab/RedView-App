import { useMemo } from 'react';
import { readDocumentAppLocale, translateAppText } from '@/shared/i18n';
import type { AxisDomain, AxisMode, ChartBackdropProfile, ChartMetricId, ChartSeries } from '../series';
import { SLOPE_COLOR_CLASSES, slopeSegmentAtX, type ChartSlopeOverlay, type ChartSlopeSegment } from '../slope';
import type { ChartAlertOverlay } from '../alerts/buildSteepAlertOverlay';
import { withAlpha } from './color';
import { resolveItineraryHoverMetrics } from './hoverMetrics';
import { interpolateY, ratioFor } from './math';
import type { ChartItineraryNode, HoverCardRow } from './types';

function pointSeriesCoversX(points: Array<{ x: number; y: number }>, xValue: number): boolean {
  if (!Number.isFinite(xValue) || points.length === 0) return false;
  const firstPoint = points[0];
  const lastPoint = points[points.length - 1];
  if (!firstPoint || !lastPoint) return false;
  return xValue >= firstPoint.x && xValue <= lastPoint.x;
}

interface UseChartHoverRowsOptions {
  /** Abscisse sous le pointeur (ou pilotée de l'extérieur), null hors du graphe. */
  hoverXValue: number | null;
  hasActiveHover: boolean;
  series: ChartSeries[];
  chartNodes: ChartItineraryNode[];
  backdropProfiles: ChartBackdropProfile[];
  alertOverlay: ChartAlertOverlay | null;
  slopeOverlay: ChartSlopeOverlay | null;
  slopeSegments: ChartSlopeSegment[] | null;
  xMode: AxisMode;
  plotYDomain: AxisDomain;
  plotY2Domain: AxisDomain;
  backdropYDomain: AxisDomain | null;
}

/**
 * Carte de survol du graphe : une ligne par série / profil / itinéraire sous
 * le pointeur, alertes de pente et tronçon « Pente », plus les pastilles
 * posées sur chaque courbe.
 */
export function useChartHoverRows({
  hoverXValue,
  hasActiveHover,
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
}: UseChartHoverRowsOptions) {
  const hoverData = useMemo<HoverCardRow[] | null>(() => {
    if (hoverXValue == null || !series.length) return null;
    return series
      .map<HoverCardRow | null>((entry) => {
        if (!pointSeriesCoversX(entry.points, hoverXValue)) return null;
        const val = interpolateY(entry.points, hoverXValue);
        if (!Number.isFinite(val)) return null;

        const matchingNode = chartNodes.find(
          (n) => n.itinerary.id === entry.itineraryId || n.itinerary.name === entry.itineraryName,
        );
        const matchingProfile = backdropProfiles.find(
          (p) => p.itineraryName === entry.itineraryName || p.id.startsWith(entry.itineraryId),
        );
        const metrics = resolveItineraryHoverMetrics({
          hoverXValue,
          xMode,
          node: matchingNode,
          profilePoints: matchingProfile?.points ?? matchingNode?.altitudeShiftedPoints,
        });

        return {
          id: entry.id,
          itineraryName: entry.itineraryName,
          color: entry.color,
          axis: entry.axis,
          axisLabel: `Axe ${entry.axis}`,
          metric: entry.metricId,
          value: val,
          distanceFormatted: metrics.distanceFormatted,
          gainM: metrics.gainM,
          lossM: metrics.lossM,
          durationFormatted: metrics.durationFormatted,
          timeFormatted: metrics.timeFormatted,
        };
      })
      .filter((entry): entry is HoverCardRow => entry !== null);
  }, [backdropProfiles, chartNodes, hoverXValue, series, xMode]);

  const hoverBackdropData = useMemo<HoverCardRow[]>(() => {
    if (hoverXValue == null || !backdropProfiles.length) return [];
    const hasAltitudeSeries = series.some((entry) => entry.metricId === 'Altitude');
    if (hasAltitudeSeries) return [];

    return backdropProfiles
      .map<HoverCardRow | null>((profile) => {
        if (!pointSeriesCoversX(profile.points, hoverXValue)) return null;
        const value = interpolateY(profile.points, hoverXValue);
        if (!Number.isFinite(value)) return null;

        const matchingNode = chartNodes.find(
          (n) =>
            n.itinerary.id === profile.id.replace('::altitude-backdrop', '') ||
            n.itinerary.name === profile.itineraryName,
        );
        const metrics = resolveItineraryHoverMetrics({
          hoverXValue,
          xMode,
          node: matchingNode,
          profilePoints: profile.points,
        });

        return {
          id: `${profile.id}::hover-altitude`,
          itineraryName: profile.itineraryName,
          color: withAlpha(profile.color, 0.95),
          axis: null,
          axisLabel: "Profil d'altitude",
          metric: 'Altitude' as ChartMetricId,
          value,
          distanceFormatted: metrics.distanceFormatted,
          gainM: metrics.gainM,
          lossM: metrics.lossM,
          durationFormatted: metrics.durationFormatted,
          timeFormatted: metrics.timeFormatted,
        };
      })
      .filter((entry): entry is HoverCardRow => entry !== null);
  }, [backdropProfiles, chartNodes, hoverXValue, series, xMode]);

  const hoverChartNodesData = useMemo<HoverCardRow[]>(() => {
    if (hoverXValue == null || !chartNodes || chartNodes.length === 0) return [];
    const existingNames = new Set([
      ...(hoverData ?? []).map((r) => r.itineraryName),
      ...hoverBackdropData.map((r) => r.itineraryName),
    ]);

    return chartNodes
      .map<HoverCardRow | null>((node) => {
        if (existingNames.has(node.itinerary.name)) return null;
        const points = node.altitudeShiftedPoints || node.axis1ShiftedPoints || [];
        const covers =
          points.length > 0
            ? pointSeriesCoversX(points, hoverXValue)
            : hoverXValue >= node.startDistanceKm &&
              hoverXValue <= node.startDistanceKm + (node.itinerary.metrics?.distanceKm ?? 0);
        if (!covers) return null;

        const metrics = resolveItineraryHoverMetrics({
          hoverXValue,
          xMode,
          node,
          profilePoints: node.altitudeShiftedPoints,
        });

        return {
          id: `${node.itinerary.id}::hover-node`,
          itineraryName: node.itinerary.name,
          color: node.itinerary.color,
          axis: null,
          axisLabel: '',
          metric: 'Altitude' as ChartMetricId,
          value: 0,
          distanceFormatted: metrics.distanceFormatted,
          gainM: metrics.gainM,
          lossM: metrics.lossM,
          durationFormatted: metrics.durationFormatted,
          timeFormatted: metrics.timeFormatted,
        };
      })
      .filter((entry): entry is HoverCardRow => entry !== null);
  }, [chartNodes, hoverBackdropData, hoverData, hoverXValue, xMode]);

  const hoverAlertRows = useMemo<HoverCardRow[]>(() => {
    if (hoverXValue == null || !alertOverlay) return [];
    const rows: HoverCardRow[] = [];
    for (const window of alertOverlay.alertWindows) {
      if (hoverXValue < window.startX || hoverXValue > window.endX) continue;
      rows.push({
        id: `${window.id}::hover`,
        itineraryName: window.itineraryName,
        color: '#ff3b30',
        axis: null,
        axisLabel: '',
        metric: 'Altitude' as ChartMetricId,
        value: 0,
        alertLabel: `${translateAppText('Pente')} ${Math.round(window.maxGradientPct)} % · ${Math.round(window.lengthM)} m`,
      });
    }
    return rows;
  }, [alertOverlay, hoverXValue]);

  // Tronçon « Pente » sous le pointeur : même découpage que la couleur affichée.
  const hoverSlopeSegment = useMemo(
    () => (hoverXValue != null && slopeSegments ? slopeSegmentAtX(slopeSegments, hoverXValue) : null),
    [hoverXValue, slopeSegments],
  );

  const hoverSlopeRows = useMemo<HoverCardRow[]>(() => {
    if (!slopeOverlay) return [];
    const segment = hoverSlopeSegment;
    if (!segment) return [];
    const node = chartNodes.find((entry) => entry.itinerary.id === slopeOverlay.itineraryId);
    const seriesEntry = series.find((entry) => entry.itineraryId === slopeOverlay.itineraryId);
    const itineraryName = node?.itinerary.name ?? seriesEntry?.itineraryName;
    if (!itineraryName) return [];
    const locale = readDocumentAppLocale();
    const numberLocale = locale === 'fr' ? 'fr-FR' : 'en-US';
    const value = new Intl.NumberFormat(numberLocale, {
      minimumFractionDigits: 1,
      maximumFractionDigits: 1,
    }).format(segment.avgPct);
    const lengthKm = segment.lengthM / 1000;
    const length = segment.lengthM < 1000
      ? `${Math.round(segment.lengthM / 10) * 10} m`
      : `${new Intl.NumberFormat(numberLocale, { maximumFractionDigits: lengthKm < 10 ? 1 : 0 }).format(lengthKm)} km`;
    return [{
      id: `${slopeOverlay.itineraryId}::hover-slope`,
      itineraryName,
      color: node?.itinerary.color ?? seriesEntry?.color ?? '#ffffff',
      axis: null,
      axisLabel: '',
      metric: 'Altitude' as ChartMetricId,
      value: 0,
      slopeLabel: `${translateAppText('Pente moy.', undefined, locale)} ${value} % · ${length}`,
      slopeColor: SLOPE_COLOR_CLASSES[segment.classIndex]?.color,
    }];
  }, [chartNodes, hoverSlopeSegment, series, slopeOverlay]);

  const hoverRows = useMemo(
    () => [...(hoverData ?? []), ...hoverBackdropData, ...hoverChartNodesData, ...hoverAlertRows, ...hoverSlopeRows],
    [hoverAlertRows, hoverBackdropData, hoverChartNodesData, hoverData, hoverSlopeRows],
  );

  const hoverMarkers = useMemo(() => {
    if (hoverXValue == null || !hasActiveHover) return [];

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
  }, [hasActiveHover, backdropProfiles, backdropYDomain, hoverXValue, plotY2Domain, plotYDomain, series]);

  return { hoverRows, hoverMarkers, hoverSlopeSegment };
}
