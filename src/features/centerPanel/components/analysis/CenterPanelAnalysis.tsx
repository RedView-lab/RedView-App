import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { useFlyoverSeek, useFlyoverSessionActive } from '../../flyover';
import { useRouteSplitToolOptional } from '../../routeSplit';
import { useTraceToolOptional } from '../../tracer';
import { useChartPlacementToolOptional } from '../../chartPlacement';
import {
  axis2Options,
  axisOptions,
  CHART_CLICK_FOCUS_PITCH,
  CHART_CLICK_FOCUS_ZOOM,
  type CenterPanelAnalysisProps,
  DEFAULT_ANALYSIS_AXIS_COLORS,
  detailOffsetForCenter,
  detailZoomToVisibleFraction,
  extractRouteSegmentPoints,
  filterAxisOptionsForDiscipline,
  findSplitIndexForChartX,
  lightenColor,
  mapAxisMetricForDiscipline,
  normalizeAnalysisState,
  normalizeUnitInterval,
  selectInteractiveItineraryForChartX,
} from './shared';
import {
  getRoutePointDistances,
  interpolateRoutePointAtDistance,
  isWeatherMetric,
  locateRoutePointAtX,
  projectXToDistanceM,
  SlopeLegend,
  type AxisMetricId,
  type AxisMode,
  listItinerarySteepAlerts,
  type ChartAlertWindow,
  type ChartPoiAnnotation,
  type ItinerarySteepAlert,
} from '../chart';
import {
  dispatchOpenPoiOnMap,
  findChartXForPoi,
  listenSelectPoiOnChart,
} from '@/features/poi/lib/chartPoiSyncBridge';
import { flyToBounds, flyToLocation, flyToPoi } from '@/features/map3d';
import {
  clearAnalysisSelectedSegment,
  setAnalysisSelectedSegment,
} from '@/features/itineraryPanel/lib/route-layer';
import type { PredictionResult } from '@/features/fitPredictor';
import { buildPauseAwareSchedule } from '@/features/itineraryPanel/lib/schedule';
import { useRouteWeather } from '@/features/weather';
import {
  usePredictionStoreOptional,
  useProjectStoreOptional,
} from '@/features/itineraryPanel';
import { useAppI18n } from '@/shared/i18n';
import { getItineraryStartDistanceKm } from '@/features/itineraryPanel/lineage/itineraryLineage';
import type { AnalysisPanelState } from '@/features/itineraryPanel/types';

import { isFootDiscipline } from '@/shared/lib/discipline';
import { useAnalysisViewportSync } from './useAnalysisViewportSync';
import { useAnalysisChartData } from './useAnalysisChartData';
import { AnalysisChartWithFlyoverCursor } from './AnalysisChartWithFlyoverCursor';
import { useAnalysisHoverPointMarker } from './useAnalysisHoverPointMarker';
import { useAnalysisAlertMapMarkers } from './useAnalysisAlertMapMarkers';
import {
  AnalysisAlertSectionPopover,
  type AnalysisAlertSelection,
} from './AnalysisAlertSectionPopover';
import { resolveRoadTypeLabel } from './resolveRoadTypeLabel';
import { AnalysisToolbar, type ToolbarFilterKey } from './AnalysisToolbar';

/**
 * Panneau d'analyse centrale des itinéraires (graphique d'élévation, pente, vitesse, puissance, etc.).
 */
export function CenterPanelAnalysis({ map, globalFilters }: CenterPanelAnalysisProps) {
  const { t } = useAppI18n();
  const rootRef = useRef<HTMLElement | null>(null);
  const [openAxis, setOpenAxis] = useState<'axis1' | 'axis2' | null>(null);

  const projectStore = useProjectStoreOptional();
  const predictionStore = usePredictionStoreOptional();
  const routeSplitTool = useRouteSplitToolOptional();
  const traceTool = useTraceToolOptional();
  const chartPlacementTool = useChartPlacementToolOptional();
  const placementArmed = chartPlacementTool?.armedKind != null;
  const seekFlyoverToChartX = useFlyoverSeek();
  const flyoverSessionActive = useFlyoverSessionActive();
  const project = projectStore?.project ?? null;
  const itineraries = useMemo(() => project?.itineraries ?? [], [project?.itineraries]);
  const activeItineraryId = project?.activeItineraryId ?? null;
  const predictions = predictionStore?.predictions ?? null;

  const rawAnalysis = project?.analysis;
  const analysisState: AnalysisPanelState = rawAnalysis
    ? normalizeAnalysisState(rawAnalysis)
    : normalizeAnalysisState();
  const storedAxis1 = analysisState.axis1 as AxisMetricId;
  const storedAxis2 = analysisState.axis2 as AxisMetricId | null;
  const xMode = analysisState.xMode as AxisMode;
  const filters = analysisState.filters;

  const weatherControl = project?.controlPanel?.weather;
  const fallbackDate = weatherControl?.date;
  const fallbackTime = weatherControl?.time;

  const { weatherByItinerary, unavailableItineraryIds } = useRouteWeather({
    itineraries,
    fallbackDate,
    fallbackTime,
    enabled: Boolean(itineraries.length > 0),
    predictions,
  });

  const {
    detailZoom,
    detailOffset,
    yZoom,
    yOffset,
    handleOffsetChange,
    handleViewportChange,
    handleYViewportChange,
  } = useAnalysisViewportSync({
    projectStore,
    storedDetailZoom: analysisState.detailZoom,
    storedDetailOffset: analysisState.detailOffset,
    storedYZoom: analysisState.yZoom ?? 0,
    storedYOffset: analysisState.yOffset ?? 0,
  });

  const activeItinerary = useMemo(() => {
    if (itineraries.length === 0) return null;
    return (
      itineraries.find((itinerary) => itinerary.id === activeItineraryId) ??
      itineraries[0] ??
      null
    );
  }, [activeItineraryId, itineraries]);

  // Trail / Running: pace instead of speed, no power (display-only mapping).
  const footDiscipline = isFootDiscipline(activeItinerary?.discipline);
  const axis1Value = mapAxisMetricForDiscipline<AxisMetricId>(storedAxis1, footDiscipline, 'Altitude');
  const axis2Value = mapAxisMetricForDiscipline<AxisMetricId | null>(storedAxis2, footDiscipline, null);
  const axis1Options = useMemo(
    () => filterAxisOptionsForDiscipline(axisOptions, footDiscipline),
    [footDiscipline],
  );
  const axis2OptionList = useMemo(
    () => filterAxisOptionsForDiscipline(axis2Options, footDiscipline),
    [footDiscipline],
  );

  const axis1Color = analysisState.axis1Color ?? activeItinerary?.color ?? DEFAULT_ANALYSIS_AXIS_COLORS.axis1;
  const axis2Color = analysisState.axis2Color
    ?? (activeItinerary?.color ? lightenColor(activeItinerary.color, 0.4) : DEFAULT_ANALYSIS_AXIS_COLORS.axis2);

  // Métrique météo choisie mais aucune prévision réelle : avis explicite (la
  // courbe n'est pas tracée, jamais de valeurs estimées).
  const activeWeatherItineraryId = activeItinerary?.id ?? null;
  const weatherUnavailable = useMemo(() => {
    const weatherAxisSelected = isWeatherMetric(axis1Value)
      || (axis2Value != null && (axis2Value as string) !== 'none' && isWeatherMetric(axis2Value));
    return weatherAxisSelected
      && activeWeatherItineraryId != null
      && unavailableItineraryIds.includes(activeWeatherItineraryId);
  }, [activeWeatherItineraryId, axis1Value, axis2Value, unavailableItineraryIds]);

  const dayNightStartReady = Boolean(
    activeItinerary?.rhythm.startDate && activeItinerary?.rhythm.startTime,
  );

  const {
    preparedChartNodes,
    visibleChartNodes,
    series,
    altitudeBackdropProfiles,
    routeXDomainClamp,
    poiAnnotations,
    dayNightOverlay,
    pauseOverlay,
    alertOverlay,
    slopeOverlay,
  } = useAnalysisChartData({
    itineraries,
    predictions,
    axis1Value,
    axis2Value,
    axis1Color: analysisState.axis1Color,
    axis2Color: analysisState.axis2Color,
    xMode,
    detailZoom,
    filters,
    globalFilters,
    activeItinerary,
    weatherByItinerary,
  });

  // Span of the active itinerary's curve on the X axis (« Ajouter » only places on it).
  const activeChartXRange = useMemo(() => {
    let min = Number.POSITIVE_INFINITY;
    let max = Number.NEGATIVE_INFINITY;
    for (const entry of [...series, ...altitudeBackdropProfiles]) {
      if (entry.itineraryId !== activeItinerary?.id || entry.points.length === 0) continue;
      min = Math.min(min, entry.points[0].x);
      max = Math.max(max, entry.points[entry.points.length - 1].x);
    }
    return max > min ? { min, max } : null;
  }, [activeItinerary?.id, altitudeBackdropProfiles, series]);

  const isSplitArmed = Boolean(routeSplitTool?.armed);
  // Découpe et Tracer ont leur propre point de survol sur la trace : le survol
  // carte → graphique de l'analyse (second point, autres seuils) se met en retrait.
  const isMapEditToolArmed = isSplitArmed || Boolean(traceTool?.armed);
  const [mapHoverXValue, setMapHoverXValue] = useState<number | null>(null);
  const [selectedChartX, setSelectedChartX] = useState<number | null>(null);

  const handleMapHoverXValueChange = useCallback((xValue: number | null) => {
    setMapHoverXValue(xValue);
  }, []);

  const handleTraceClick = useCallback(
    (xValue: number) => {
      // Flyover ouvert : le clic sur la trace déplace la tête de lecture.
      if (seekFlyoverToChartX(xValue)) return;
      setSelectedChartX(xValue);
      setMapHoverXValue(xValue);
    },
    [seekFlyoverToChartX],
  );

  const alertMarkersEnabled = filters.alertes && (project?.controlPanel?.toggles?.routesEnabled ?? true);
  const [selectedAlert, setSelectedAlert] = useState<AnalysisAlertSelection | null>(null);
  const handleCloseAlert = useCallback(() => setSelectedAlert(null), []);
  const handleSelectAlert = useCallback(
    (alert: ItinerarySteepAlert) => {
      setSelectedAlert({
        itineraryId: alert.itineraryId,
        key: alert.key,
        roadTypeLabel: map ? resolveRoadTypeLabel(map, alert.mid.lon, alert.mid.lat) : null,
      });
    },
    [map],
  );

  useAnalysisAlertMapMarkers({
    map,
    itineraries,
    enabled: alertMarkersEnabled,
    onSelect: handleSelectAlert,
  });

  const { updateHoverPoint } = useAnalysisHoverPointMarker({
    map,
    visibleChartNodes,
    activeItinerary,
    xMode,
    predictions,
    onMapHoverXValueChange: handleMapHoverXValueChange,
    selectedXValue: flyoverSessionActive ? null : selectedChartX,
    onTraceClick: handleTraceClick,
    disabled: isMapEditToolArmed,
  });

  // Pendant un flyover, le curseur du graphique suit la tête de lecture
  // (AnalysisChartWithFlyoverCursor) et le point de la carte est la tête : ici
  // seulement le survol de la carte, plus la sélection hors lecture.
  const chartControlledHoverXValue = flyoverSessionActive ? mapHoverXValue : mapHoverXValue ?? selectedChartX;
  const chartControlledHoverXRef = useRef(chartControlledHoverXValue);
  useLayoutEffect(() => {
    chartControlledHoverXRef.current = chartControlledHoverXValue;
  });

  // Fin de survol du graphique : le point revient à la valeur imposée (ou disparaît).
  const handleHoverXValueChange = useCallback(
    (xValue: number | null) => {
      updateHoverPoint(xValue ?? chartControlledHoverXRef.current);
    },
    [updateHoverPoint],
  );

  useEffect(() => {
    if (flyoverSessionActive) updateHoverPoint(null);
  }, [flyoverSessionActive, updateHoverPoint]);

  useEffect(() => {
    if (Number.isFinite(chartControlledHoverXValue)) {
      updateHoverPoint(chartControlledHoverXValue);
    }
  }, [chartControlledHoverXValue, updateHoverPoint]);

  const updateAnalysis = (mut: (draft: AnalysisPanelState) => void) => {
    if (!projectStore) return;
    projectStore.setProject((prev) => {
      const current = normalizeAnalysisState(prev.analysis);
      const next: AnalysisPanelState = {
        xMode: current.xMode,
        axis1: current.axis1,
        axis2: current.axis2,
        axis1Color: current.axis1Color,
        axis2Color: current.axis2Color,
        filters: { ...current.filters },
        surfaceFilter: current.surfaceFilter,
        detailZoom: current.detailZoom,
        detailOffset: current.detailOffset,
        yZoom: current.yZoom ?? 0,
        yOffset: current.yOffset ?? 0,
      };
      mut(next);
      return { ...prev, analysis: next };
    });
  };

  useEffect(() => {
    if (!openAxis) return;
    const handlePointerDown = (event: PointerEvent) => {
      if (!rootRef.current) return;
      if (rootRef.current.contains(event.target as Node)) return;
      setOpenAxis(null);
    };
    document.addEventListener('pointerdown', handlePointerDown);
    return () => document.removeEventListener('pointerdown', handlePointerDown);
  }, [openAxis]);

  /**
   * Le calque Jour/nuit n'est calculable que si l'itinéraire actif possède une
   * date ET une heure de départ (voir useAnalysisChartData).
   */
  const dayNightUnavailable = !dayNightStartReady;

  /**
   * Aide affichée en tooltip au survol du chip Jour/nuit tant que la date/heure de
   * départ manque (`disabledFilters`).
   */
  const dayNightHint = t(
    'Renseigne une date et une heure de départ pour activer Jour/nuit.',
  );

  /**
   * La colorisation « Pente » s'applique à la courbe d'altitude : sans altitude
   * sur un axe ni profil d'altitude en fond, il n'y a rien à colorer.
   */
  const altitudeShown =
    axis1Value === 'Altitude' || axis2Value === 'Altitude' || Boolean(filters.pente);
  const slopeColorsHint = t('Affichez l’altitude (axe ou profil d’altitude) pour colorer la pente.');

  const disabledFilters = useMemo(() => {
    const hints: Partial<Record<ToolbarFilterKey, string>> = {};
    if (dayNightUnavailable) hints.jourNuit = dayNightHint;
    if (!altitudeShown) hints.slopeColors = slopeColorsHint;
    return Object.keys(hints).length > 0 ? hints : undefined;
  }, [altitudeShown, dayNightUnavailable, dayNightHint, slopeColorsHint]);

  // Par défaut l'option Jour/nuit est désactivée tant que le rythme n'a pas été édité.
  // Si un projet existant avait conservé l'ancien défaut `jourNuit: true`, on l'aligne sur `false`.
  useEffect(() => {
    if (!dayNightStartReady && rawAnalysis?.filters?.jourNuit) {
      updateAnalysis((draft) => {
        draft.filters.jourNuit = false;
      });
    }
  }, [dayNightStartReady]);

  const hasStartTime = Boolean(activeItinerary?.rhythm.startTime);
  const hourScaleHint = t(
    'Renseigne une heure de départ pour activer l’échelle heure.',
  );

  const disabledXModes = useMemo(
    () =>
      !hasStartTime
        ? {
            heure: hourScaleHint,
          }
        : undefined,
    [hasStartTime, hourScaleHint],
  );

  useEffect(() => {
    if (!hasStartTime && xMode === 'heure') {
      updateAnalysis((draft) => {
        draft.xMode = 'temps';
      });
    }
  }, [hasStartTime, xMode]);

  const [selectedXRange, setSelectedXRange] = useState<{ startX: number; endX: number } | null>(null);

  const handleClearSelectedXRange = useCallback(() => {
    setSelectedXRange(null);
    if (map) {
      clearAnalysisSelectedSegment(map);
      const points = activeItinerary?.gpxRoute?.points ?? [];
      if (points.length >= 2) {
        let minLon = Infinity;
        let maxLon = -Infinity;
        let minLat = Infinity;
        let maxLat = -Infinity;
        for (const pt of points) {
          if (pt.lon < minLon) minLon = pt.lon;
          if (pt.lon > maxLon) maxLon = pt.lon;
          if (pt.lat < minLat) minLat = pt.lat;
          if (pt.lat > maxLat) maxLat = pt.lat;
        }
        if (Number.isFinite(minLon) && Number.isFinite(maxLon)) {
          flyToBounds(map, [
            [minLon, minLat],
            [maxLon, maxLat],
          ]);
        }
      }
    }
  }, [activeItinerary, map]);

  const handlePlotRangeSelect = useCallback(
    (range: { startX: number; endX: number }) => {
      setSelectedXRange(range);
      if (!map) return;

      const targetItinerary =
        selectInteractiveItineraryForChartX(
          visibleChartNodes,
          activeItinerary?.id ?? null,
          xMode,
          range.startX,
        ) ?? activeItinerary;
      if (!targetItinerary) return;

      const points = targetItinerary.gpxRoute?.points ?? [];
      if (points.length < 2) return;

      const xOffset = xMode === 'distance' ? getItineraryStartDistanceKm(targetItinerary) : 0;
      const localStartX = xMode === 'distance' ? range.startX - xOffset : range.startX;
      const localEndX = xMode === 'distance' ? range.endX - xOffset : range.endX;

      const prediction =
        (predictions?.[targetItinerary.id] as PredictionResult | undefined) ??
        (targetItinerary.prediction as PredictionResult | null | undefined) ??
        null;

      const pauseSchedule = buildPauseAwareSchedule(targetItinerary, prediction);
      const segmentPoints = extractRouteSegmentPoints(
        points,
        prediction,
        xMode,
        localStartX,
        localEndX,
        targetItinerary.rhythm.startTime,
        pauseSchedule,
      );

      if (segmentPoints.length >= 2) {
        setAnalysisSelectedSegment(map, segmentPoints, '#ffffff');

        let minLon = Infinity;
        let maxLon = -Infinity;
        let minLat = Infinity;
        let maxLat = -Infinity;
        for (const pt of segmentPoints) {
          if (pt.lon < minLon) minLon = pt.lon;
          if (pt.lon > maxLon) maxLon = pt.lon;
          if (pt.lat < minLat) minLat = pt.lat;
          if (pt.lat > maxLat) maxLat = pt.lat;
        }

        const currentPitch = map.getPitch();
        const is2D = currentPitch <= 8;
        const targetPitch = is2D ? 0 : Math.max(currentPitch, CHART_CLICK_FOCUS_PITCH);

        flyToBounds(
          map,
          [
            [minLon, minLat],
            [maxLon, maxLat],
          ],
          {
            pitch: targetPitch,
            maxZoom: 13.8,
            padding: { top: 80, bottom: 80, left: 80, right: 80 },
          },
        );
      }
    },
    [activeItinerary, map, predictions, visibleChartNodes, xMode],
  );

  useEffect(() => {
    return () => {
      if (map) {
        clearAnalysisSelectedSegment(map);
      }
    };
  }, [map]);

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
    updateHoverPoint,
    visibleChartNodes,
    xMode,
  ]);

  const handlePoiAnnotationClick = useCallback(
    (annotation: ChartPoiAnnotation) => {
      setSelectedChartX(annotation.x);
      updateHoverPoint(annotation.x);

      const targetItinerary = selectInteractiveItineraryForChartX(
        visibleChartNodes,
        activeItinerary?.id ?? null,
        xMode,
        annotation.x,
      );
      if (targetItinerary && map) {
        const xOffset = xMode === 'distance' ? getItineraryStartDistanceKm(targetItinerary) : 0;
        const localXValue = xMode === 'distance' ? annotation.x - xOffset : annotation.x;
        const prediction = predictions?.[targetItinerary.id] ?? targetItinerary.prediction ?? null;
        const pauseSchedule = buildPauseAwareSchedule(targetItinerary, prediction);
        const routePoint = locateRoutePointAtX(
          targetItinerary.gpxRoute?.points ?? null,
          prediction,
          xMode,
          localXValue,
          targetItinerary.rhythm.startTime,
          pauseSchedule,
        );

        const targetLat = annotation.lat ?? routePoint?.lat;
        const targetLon = annotation.lon ?? routePoint?.lon;

        if (targetLat != null && targetLon != null) {
          flyToPoi(map, { lon: targetLon, lat: targetLat });

          dispatchOpenPoiOnMap({
            id: annotation.rowId ?? annotation.id,
            osmId: annotation.osmId,
            lat: targetLat,
            lon: targetLon,
            category: annotation.poiCategory,
            xValue: annotation.x,
            itineraryId: targetItinerary.id,
            source: 'chart',
          });
        }
      }
    },
    [activeItinerary, map, predictions, updateHoverPoint, visibleChartNodes, xMode],
  );

  // Icône « Alertes » du graphe : même fiche que l'icône de la carte, la carte
  // vole vers le tronçon (le type de voie se lit une fois la vue posée).
  const handleChartAlertClick = useCallback(
    (alertWindow: ChartAlertWindow) => {
      const itinerary = itineraries.find((it) => it.id === alertWindow.itineraryId);
      const alert = itinerary
        ? listItinerarySteepAlerts(itinerary).find((candidate) => candidate.id === alertWindow.id)
        : null;
      if (!alert) return;

      const midX = (alertWindow.startX + alertWindow.endX) / 2;
      setSelectedChartX(midX);
      updateHoverPoint(midX);
      handleSelectAlert(alert);
      if (!map) return;

      const { lon, lat } = alert.mid;
      flyToPoi(map, { lon, lat });
      map.once('moveend', () => {
        setSelectedAlert((prev) => {
          if (!prev || prev.itineraryId !== alert.itineraryId || prev.key !== alert.key || prev.roadTypeLabel) {
            return prev;
          }
          const roadTypeLabel = resolveRoadTypeLabel(map, lon, lat);
          return roadTypeLabel ? { ...prev, roadTypeLabel } : prev;
        });
      });
    },
    [handleSelectAlert, itineraries, map, updateHoverPoint],
  );

  // Latest-closure ref + stable wrapper: a fresh `onPlotClick` on every render
  // defeated `AnalysisChart`'s memo (re-rendering it on each map-hover /
  // flyover frame) and re-bound its window pointer listeners.
  const chartClickImplRef = useRef<(xValue: number) => void>(() => {});
  const handleChartClick = useCallback((xValue: number) => {
    chartClickImplRef.current(xValue);
  }, []);
  const flyMapToRoutePoint = (point: { lat: number; lon: number }) => {
    if (!map) return;
    const currentPitch = map.getPitch();
    const is2D = currentPitch <= 8;
    const targetPitch = is2D ? 0 : Math.max(currentPitch, CHART_CLICK_FOCUS_PITCH);

    flyToLocation(
      map,
      { lon: point.lon, lat: point.lat },
      {
        zoom: CHART_CLICK_FOCUS_ZOOM,
        pitch: targetPitch,
      },
    );
  };

  // « Ajouter » armé : le clic pose l'élément sur la trace de l'itinéraire actif,
  // au point du profil sous le curseur.
  const placeOnActiveRoute = (xValue: number) => {
    const points = activeItinerary?.gpxRoute?.points ?? null;
    if (!chartPlacementTool || !activeItinerary || !points || points.length < 2) return;
    if (activeChartXRange) {
      const margin = (activeChartXRange.max - activeChartXRange.min) * 0.002;
      if (xValue < activeChartXRange.min - margin || xValue > activeChartXRange.max + margin) {
        chartPlacementTool.rejectOutsideRoute();
        return;
      }
    }

    const distances = getRoutePointDistances(points);
    const totalM = distances[distances.length - 1] ?? 0;
    const localXValue = xMode === 'distance' ? xValue - getItineraryStartDistanceKm(activeItinerary) : xValue;
    const prediction = predictions?.[activeItinerary.id] ?? activeItinerary.prediction ?? null;
    const distanceM = projectXToDistanceM(
      points,
      prediction,
      xMode,
      localXValue,
      activeItinerary.rhythm.startTime,
      buildPauseAwareSchedule(activeItinerary, prediction),
    );
    // Hors du profil actif (portion d'une autre variante, au-delà de l'arrivée).
    const toleranceM = Math.max(25, totalM * 0.002);
    if (!Number.isFinite(distanceM) || distanceM < -toleranceM || distanceM > totalM + toleranceM) {
      chartPlacementTool.rejectOutsideRoute();
      return;
    }

    const routeDistanceM = Math.min(totalM, Math.max(0, distanceM));
    const point = interpolateRoutePointAtDistance(points, routeDistanceM);
    if (!point) return;

    setSelectedChartX(xValue);
    updateHoverPoint(xValue);
    flyMapToRoutePoint(point);
    chartPlacementTool.placeAt({ lat: point.lat, lon: point.lon, distanceM: routeDistanceM });
  };

  const handleChartClickImpl = (xValue: number) => {
    if (placementArmed) {
      placeOnActiveRoute(xValue);
      return;
    }
    // Flyover ouvert : le clic déplace la tête de lecture (la caméra suit), sauf découpe armée.
    if (!routeSplitTool?.armed && seekFlyoverToChartX(xValue)) return;
    setSelectedChartX(xValue);
    handleClearSelectedXRange();

    const targetItinerary = selectInteractiveItineraryForChartX(
      visibleChartNodes,
      activeItinerary?.id ?? null,
      xMode,
      xValue,
    );
    if (!targetItinerary) return;

    const xOffset = xMode === 'distance' ? getItineraryStartDistanceKm(targetItinerary) : 0;
    const localXValue = xMode === 'distance' ? xValue - xOffset : xValue;

    if (
      routeSplitTool?.armed
      && activeItinerary
      && activeItinerary.id === targetItinerary.id
      && (activeItinerary.gpxRoute?.points.length ?? 0) >= 4
    ) {
      const activePrediction = predictions?.[activeItinerary.id] ?? activeItinerary.prediction ?? null;
      const activePauseSchedule = buildPauseAwareSchedule(activeItinerary, activePrediction);
      const splitIndex = findSplitIndexForChartX(
        activeItinerary.gpxRoute?.points ?? null,
        activePrediction,
        xMode,
        localXValue,
        activeItinerary.rhythm.startTime,
        activePauseSchedule,
      );
      if (splitIndex != null && routeSplitTool.splitAtPointIndex(splitIndex)) {
        return;
      }
    }

    if (!map) return;
    const prediction = predictions?.[targetItinerary.id] ?? targetItinerary.prediction ?? null;
    const pauseSchedule = buildPauseAwareSchedule(targetItinerary, prediction);
    const point = locateRoutePointAtX(
      targetItinerary.gpxRoute?.points ?? null,
      prediction,
      xMode,
      localXValue,
      targetItinerary.rhythm.startTime,
      pauseSchedule,
    );
    if (!point) return;

    flyMapToRoutePoint(point);
    updateHoverPoint(xValue);
  };
  useLayoutEffect(() => {
    chartClickImplRef.current = handleChartClickImpl;
  });

  const toggleFilter = (key: ToolbarFilterKey) => {
    updateAnalysis((draft) => {
      draft.filters[key] = !draft.filters[key];
    });
  };

  return (
    <section
      ref={rootRef}
      className="rvc-center-analysis"
      aria-label={t('Analyse du parcours')}
    >
      <AnalysisToolbar
        xMode={xMode}
        onXModeChange={(mode) => updateAnalysis((d) => { d.xMode = mode; })}
        openAxis={openAxis}
        onToggleAxis={(axis) => setOpenAxis((curr) => (curr === axis ? null : axis))}
        axis1Value={axis1Value}
        axis2Value={axis2Value}
        axis1Color={axis1Color}
        axis2Color={axis2Color}
        onAxis1Select={(val) => { updateAnalysis((d) => { d.axis1 = val.replace('__bis', '') as AxisMetricId; }); setOpenAxis(null); }}
        onAxis2Select={(val) => {
          const nextVal = val === 'none' ? null : (val.replace('__bis', '') as AxisMetricId);
          updateAnalysis((d) => { d.axis2 = nextVal; });
          setOpenAxis(null);
        }}
        onAxis1ColorChange={(col) => updateAnalysis((d) => { d.axis1Color = col; })}
        onAxis2ColorChange={(col) => updateAnalysis((d) => { d.axis2Color = col; })}
        filters={filters}
        onToggleFilter={toggleFilter}
        surfaceFilter={analysisState.surfaceFilter ?? 'all'}
        onSurfaceFilterChange={(value) => updateAnalysis((d) => { d.surfaceFilter = value; })}
        disabledFilters={disabledFilters}
        disabledXModes={disabledXModes}
        axis1Options={axis1Options}
        axis2Options={axis2OptionList}
      />

      <div className="rvc-center-analysis__results" aria-label={t("Graphique d'analyse")}>
        <AnalysisChartWithFlyoverCursor
          series={series}
          chartNodes={preparedChartNodes}
          backdropProfiles={altitudeBackdropProfiles}
          poiAnnotations={poiAnnotations}
          dayNightOverlay={dayNightOverlay}
          pauseOverlay={pauseOverlay}
          alertOverlay={alertOverlay}
          slopeOverlay={slopeOverlay}
          axis1Metric={axis1Value}
          axis2Metric={axis2Value}
          xMode={xMode}
          detailZoom={detailZoom}
          detailOffset={detailOffset}
          yZoom={yZoom}
          yOffset={yOffset}
          xDomainClamp={routeXDomainClamp}
          onViewportChange={handleViewportChange}
          onYViewportChange={handleYViewportChange}
          onDetailOffsetChange={handleOffsetChange}
          onHoverXValueChange={handleHoverXValueChange}
          controlledHoverXValue={chartControlledHoverXValue}
          onPlotClick={handleChartClick}
          placementActive={placementArmed}
          onPoiClick={handlePoiAnnotationClick}
          onAlertClick={handleChartAlertClick}
          onPlotRangeSelect={handlePlotRangeSelect}
          selectedXRange={selectedXRange}
          onClearSelectedXRange={handleClearSelectedXRange}
          showSeriesRows={false}
        />
        {slopeOverlay && altitudeShown ? (
          <SlopeLegend overlay={slopeOverlay} itineraryName={activeItinerary?.name} />
        ) : null}
        {weatherUnavailable ? (
          <div className="rvc-center-analysis__notice" role="status">
            {t('Prévisions météo indisponibles pour ce départ (erreur ou date au-delà de 16 jours) : la courbe météo est masquée.')}
          </div>
        ) : null}
      </div>
      {map && selectedAlert && filters.alertes ? (
        <AnalysisAlertSectionPopover
          map={map}
          selection={selectedAlert}
          itineraries={itineraries}
          predictions={predictions}
          onClose={handleCloseAlert}
        />
      ) : null}
    </section>
  );
}

