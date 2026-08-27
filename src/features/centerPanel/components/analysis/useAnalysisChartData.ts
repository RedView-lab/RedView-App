import { useMemo } from 'react';
import type { Itinerary } from '@/features/itineraryPanel/types';
import {
  buildItineraryVisualNodes,
  shiftChartPoints,
  shiftChartX,
} from '@/features/itineraryPanel/lineage/itineraryLineage';
import {
  buildChartDayNightOverlay,
  buildPoiAnnotationsForItinerary,
  buildRouteAuditAnnotationsForItinerary,
  buildSeriesFromPrediction,
  computeXDomain,
  isInclinationMetric,
  type AxisDomain,
  type AxisMetricId,
  type AxisMode,
  type ChartAlertAnnotation,
  type ChartBackdropProfile,
  type ChartDayNightOverlay,
  type ChartPoiAnnotation,
  type ChartSeries,
} from '../chart';
import { lightenColor, type FilterKey, type PreparedChartNode } from './shared';

interface UseAnalysisChartDataArgs {
  itineraries: Itinerary[];
  predictions: Record<string, unknown> | null;
  axis1Value: AxisMetricId;
  axis2Value: AxisMetricId;
  axis1Color: string;
  axis2Color: string;
  xMode: AxisMode;
  detailZoom: number;
  filters: Record<FilterKey, boolean>;
  activeItinerary: Itinerary | null;
}

/**
 * Prépare et calcule les séries, annotations, overlay jour/nuit et domaines d'axe pour le graphique d'analyse.
 */
export function useAnalysisChartData({
  itineraries,
  predictions,
  axis1Value,
  axis2Value,
  axis1Color,
  axis2Color,
  xMode,
  detailZoom,
  filters,
  activeItinerary,
}: UseAnalysisChartDataArgs) {
  const visualNodes = useMemo(
    () => buildItineraryVisualNodes(itineraries),
    [itineraries],
  );

  const preparedChartNodes = useMemo<PreparedChartNode[]>(() => {
    const result: PreparedChartNode[] = [];
    for (const node of visualNodes) {
      const itinerary = node.itinerary;
      if (itinerary.analysisVisible === false) continue;
      if ((itinerary.gpxRoute?.points.length ?? 0) === 0) continue;

      const prediction = (predictions?.[itinerary.id] as never) ?? itinerary.prediction ?? null;
      const routePoints = itinerary.gpxRoute?.points ?? null;
      const routeSource = itinerary.gpxRoute?.source;
      const startTime = itinerary.rhythm.startTime;
      const xOffset = xMode === 'distance' ? node.startDistanceKm : 0;
      const axis1Points = buildSeriesFromPrediction(
        prediction,
        axis1Value,
        xMode,
        routePoints,
        routeSource,
        startTime,
        itinerary,
        detailZoom,
      );
      const axis2Points = buildSeriesFromPrediction(
        prediction,
        axis2Value,
        xMode,
        routePoints,
        routeSource,
        startTime,
        itinerary,
        detailZoom,
      );
      const altitudePoints = buildSeriesFromPrediction(
        prediction,
        'Altitude',
        xMode,
        routePoints,
        routeSource,
        startTime,
        itinerary,
        detailZoom,
      );

      result.push({
        itinerary,
        startDistanceKm: node.startDistanceKm,
        prediction,
        xOffset,
        axis1Points,
        axis1ShiftedPoints: axis1Points ? shiftChartPoints(axis1Points, xOffset) : null,
        axis2Points,
        axis2ShiftedPoints: axis2Points ? shiftChartPoints(axis2Points, xOffset) : null,
        altitudePoints,
        altitudeShiftedPoints: altitudePoints ? shiftChartPoints(altitudePoints, xOffset) : null,
      });
    }
    return result;
  }, [axis1Value, axis2Value, detailZoom, predictions, visualNodes, xMode]);

  const visibleChartNodes = useMemo(
    () => preparedChartNodes.map(({ itinerary, startDistanceKm }) => ({ itinerary, startDistanceKm })),
    [preparedChartNodes],
  );

  const series = useMemo<ChartSeries[]>(() => {
    const result: ChartSeries[] = [];
    for (const node of preparedChartNodes) {
      const { itinerary, axis1ShiftedPoints, axis2ShiftedPoints } = node;
      if (axis1ShiftedPoints) {
        result.push({
          id: `${itinerary.id}::axis1`,
          itineraryId: itinerary.id,
          itineraryName: itinerary.name,
          metricId: axis1Value,
          color: axis1Color ?? itinerary.color,
          axis: 1,
          unit: '',
          points: axis1ShiftedPoints,
        });
      }

      if (axis2ShiftedPoints) {
        result.push({
          id: `${itinerary.id}::axis2`,
          itineraryId: itinerary.id,
          itineraryName: itinerary.name,
          metricId: axis2Value,
          color: axis2Color ?? lightenColor(itinerary.color, 0.4),
          axis: 2,
          unit: '',
          points: axis2ShiftedPoints,
        });
      }
    }
    return result;
  }, [axis1Color, axis2Color, axis1Value, axis2Value, preparedChartNodes]);

  const showAltitudeBackdrop =
    filters.pente ||
    isInclinationMetric(axis1Value) ||
    isInclinationMetric(axis2Value);

  const altitudeBackdropProfiles = useMemo<ChartBackdropProfile[]>(() => {
    if (!showAltitudeBackdrop) return [];

    const result: ChartBackdropProfile[] = [];
    for (const node of preparedChartNodes) {
      const { itinerary, altitudeShiftedPoints } = node;
      const points = altitudeShiftedPoints;
      if (!points) continue;
      result.push({
        id: `${itinerary.id}::altitude-backdrop`,
        itineraryId: itinerary.id,
        itineraryName: itinerary.name,
        color: itinerary.color,
        points,
      });
    }
    return result;
  }, [preparedChartNodes, showAltitudeBackdrop]);

  const routeXDomainClamp = useMemo<AxisDomain | null>(() => {
    const routeProfiles = preparedChartNodes
      .map(({ altitudeShiftedPoints }) => altitudeShiftedPoints ?? null)
      .filter((points): points is NonNullable<typeof points> => Boolean(points));

    return computeXDomain(routeProfiles, xMode);
  }, [preparedChartNodes, xMode]);

  const poiAnnotations = useMemo<ChartPoiAnnotation[]>(() => {
    const includePoi = Boolean(filters.poi);
    const includePause = Boolean(filters.pause);
    const includeWaypoint = Boolean(filters.waypoint);

    if (!includePoi && !includePause && !includeWaypoint) return [];

    const result: ChartPoiAnnotation[] = [];
    for (const node of preparedChartNodes) {
      const { itinerary, prediction, xOffset } = node;
      result.push(
        ...buildPoiAnnotationsForItinerary(itinerary, prediction, xMode, {
          includePoi,
          includePause,
          includeWaypoint,
        }).map((annotation) => shiftChartX(annotation, xOffset)),
      );
    }
    return result;
  }, [filters.pause, filters.poi, filters.waypoint, preparedChartNodes, xMode]);

  const alertAnnotations = useMemo<ChartAlertAnnotation[]>(() => {
    if (!filters.alertes) return [];

    const result: ChartAlertAnnotation[] = [];
    for (const node of preparedChartNodes) {
      const { itinerary, prediction, xOffset } = node;
      result.push(
        ...buildRouteAuditAnnotationsForItinerary(itinerary, prediction, xMode).map((annotation) =>
          shiftChartX(annotation, xOffset),
        ),
      );
    }
    return result;
  }, [filters.alertes, preparedChartNodes, xMode]);

  const dayNightStartReady = Boolean(
    activeItinerary?.rhythm.startDate && activeItinerary?.rhythm.startTime,
  );

  const dayNightOverlay = useMemo<ChartDayNightOverlay | null>(() => {
    if (!filters.jourNuit || !dayNightStartReady || !activeItinerary) return null;
    if (activeItinerary.analysisVisible === false) return null;

    const prediction =
      (predictions?.[activeItinerary.id] as never) ?? activeItinerary.prediction ?? null;
    if (!prediction) return null;

    const anchorPoint =
      activeItinerary.gpxRoute?.points?.find(
        (point) => Number.isFinite(point.lat) && Number.isFinite(point.lon),
      ) ?? null;
    if (!anchorPoint) return null;

    return buildChartDayNightOverlay({
      prediction,
      startDate: activeItinerary.rhythm.startDate as string,
      startTime: activeItinerary.rhythm.startTime as string,
      latitude: anchorPoint.lat,
      longitude: anchorPoint.lon,
      xMode,
    });
  }, [activeItinerary, dayNightStartReady, filters.jourNuit, predictions, xMode]);

  return {
    preparedChartNodes,
    visibleChartNodes,
    series,
    altitudeBackdropProfiles,
    routeXDomainClamp,
    poiAnnotations,
    alertAnnotations,
    dayNightOverlay,
  };
}
