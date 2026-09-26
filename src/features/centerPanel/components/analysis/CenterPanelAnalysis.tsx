import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useAnalysisFlyover } from '../../flyover';
import { useRouteSplitToolOptional } from '../../routeSplit';
import {
  CHART_CLICK_FOCUS_PITCH,
  CHART_CLICK_FOCUS_ZOOM,
  type CenterPanelAnalysisProps,
  DEFAULT_ANALYSIS_AXIS_COLORS,
  extractRouteSegmentCoordinates,
  findSplitIndexForChartX,
  lightenColor,
  normalizeAnalysisState,
  selectInteractiveItineraryForChartX,
} from './shared';
import {
  AnalysisChart,
  locateRoutePointAtX,
  type AxisMetricId,
  type AxisMode,
} from '../chart';
import { flyToBounds, flyToLocation } from '@/features/map3d';
import {
  clearAnalysisSelectedSegment,
  setAnalysisSelectedSegment,
} from '@/features/itineraryPanel/lib/route-layer';
import type { PredictionResult } from '@/features/fitPredictor';
import { useRouteWeather } from '@/features/weather';
import {
  usePredictionStoreOptional,
  useProjectStoreOptional,
} from '@/features/itineraryPanel';
import { useAppI18n } from '@/shared/i18n';
import { getItineraryStartDistanceKm } from '@/features/itineraryPanel/lineage/itineraryLineage';
import type { AnalysisPanelState } from '@/features/itineraryPanel/types';

import { useAnalysisViewportSync } from './useAnalysisViewportSync';
import { useAnalysisChartData } from './useAnalysisChartData';
import { useAnalysisHoverPointMarker } from './useAnalysisHoverPointMarker';
import { AnalysisToolbar } from './AnalysisToolbar';

/**
 * Panneau d'analyse centrale des itinéraires (graphique d'élévation, pente, vitesse, puissance, etc.).
 */
export function CenterPanelAnalysis({ map }: CenterPanelAnalysisProps) {
  const { t } = useAppI18n();
  const rootRef = useRef<HTMLElement | null>(null);
  const [openAxis, setOpenAxis] = useState<'axis1' | 'axis2' | null>(null);

  const projectStore = useProjectStoreOptional();
  const predictionStore = usePredictionStoreOptional();
  const routeSplitTool = useRouteSplitToolOptional();
  const { controlledHoverXValue, setManualHoverXValue } = useAnalysisFlyover();
  const project = projectStore?.project ?? null;
  const itineraries = useMemo(() => project?.itineraries ?? [], [project?.itineraries]);
  const activeItineraryId = project?.activeItineraryId ?? null;
  const predictions = predictionStore?.predictions ?? null;

  const rawAnalysis = project?.analysis;
  const analysisState: AnalysisPanelState = rawAnalysis
    ? normalizeAnalysisState(rawAnalysis)
    : normalizeAnalysisState();
  const axis1Value = analysisState.axis1 as AxisMetricId;
  const axis2Value = analysisState.axis2 as AxisMetricId | null;
  const xMode = analysisState.xMode as AxisMode;
  const filters = analysisState.filters;

  const weatherControl = project?.controlPanel?.weather;
  const fallbackDate = weatherControl?.date;
  const fallbackTime = weatherControl?.time;

  const { weatherByItinerary } = useRouteWeather({
    itineraries,
    fallbackDate,
    fallbackTime,
    enabled: Boolean(itineraries.length > 0),
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

  const axis1Color = analysisState.axis1Color ?? activeItinerary?.color ?? DEFAULT_ANALYSIS_AXIS_COLORS.axis1;
  const axis2Color = analysisState.axis2Color
    ?? (activeItinerary?.color ? lightenColor(activeItinerary.color, 0.4) : DEFAULT_ANALYSIS_AXIS_COLORS.axis2);

  const dayNightStartReady = Boolean(
    activeItinerary?.rhythm.startDate && activeItinerary?.rhythm.startTime,
  );

  const {
    visibleChartNodes,
    series,
    altitudeBackdropProfiles,
    routeXDomainClamp,
    poiAnnotations,
    alertAnnotations,
    dayNightOverlay,
    pauseOverlay,
  } = useAnalysisChartData({
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
    weatherByItinerary,
  });

  const isSplitArmed = Boolean(routeSplitTool?.armed);
  const [mapHoverXValue, setMapHoverXValue] = useState<number | null>(null);

  const handleMapHoverXValueChange = useCallback(
    (xValue: number | null) => {
      setMapHoverXValue(xValue);
      setManualHoverXValue(xValue);
    },
    [setManualHoverXValue],
  );

  const { updateHoverPoint } = useAnalysisHoverPointMarker({
    map,
    visibleChartNodes,
    activeItinerary,
    xMode,
    predictions,
    onMapHoverXValueChange: handleMapHoverXValueChange,
    disabled: isSplitArmed,
  });

  const handleHoverXValueChange = useCallback(
    (xValue: number | null) => {
      setManualHoverXValue(xValue);
      updateHoverPoint(xValue);
    },
    [setManualHoverXValue, updateHoverPoint],
  );

  useEffect(() => {
    if (Number.isFinite(controlledHoverXValue)) {
      updateHoverPoint(controlledHoverXValue);
    }
  }, [controlledHoverXValue, updateHoverPoint]);

  const chartControlledHoverXValue =
    Number.isFinite(controlledHoverXValue) ? controlledHoverXValue : mapHoverXValue;

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
   * Aide affichée en pop-in sur le chip Jour/nuit tant que la date/heure de
   * départ manque. Sert à deux choses :
   * - au survol du chip (`disabledFilters`) ;
   * - en continu dès que le filtre est ACTIVÉ sans ses prérequis
   *   (`pinnedFilters`) — l'utilisateur n'a donc pas besoin de survoler.
   *
   * Le chip reste volontairement COCHABLE/DÉCOCHABLE (pas de `disabled`) : sinon,
   * comme `filters.jourNuit` vaut `true` par défaut, le chip serait coché ET
   * désactivé — impossible à décocher, avec un pop-in qui se réaffiche à chaque
   * survol. C'est ce clic qui fait disparaître le pop-in épinglé.
   */
  const dayNightHint = t(
    'Renseigne une date et une heure de départ pour activer Jour/nuit.',
  );

  const disabledFilters = useMemo(
    () => (dayNightUnavailable ? { jourNuit: dayNightHint } : undefined),
    [dayNightUnavailable, dayNightHint],
  );

  const pinnedFilters = useMemo(
    () =>
      dayNightUnavailable && filters.jourNuit ? { jourNuit: dayNightHint } : undefined,
    [dayNightUnavailable, dayNightHint, filters.jourNuit],
  );

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

      const coords = extractRouteSegmentCoordinates(
        points,
        prediction,
        xMode,
        localStartX,
        localEndX,
        targetItinerary.rhythm.startTime,
      );

      if (coords.length >= 2) {
        setAnalysisSelectedSegment(map, coords, '#ffffff');

        let minLon = Infinity;
        let maxLon = -Infinity;
        let minLat = Infinity;
        let maxLat = -Infinity;
        for (const [lon, lat] of coords) {
          if (lon < minLon) minLon = lon;
          if (lon > maxLon) maxLon = lon;
          if (lat < minLat) minLat = lat;
          if (lat > maxLat) maxLat = lat;
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
          { pitch: targetPitch },
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

  const handleChartClick = (xValue: number) => {
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
      const splitIndex = findSplitIndexForChartX(
        activeItinerary.gpxRoute?.points ?? null,
        activePrediction,
        xMode,
        localXValue,
        activeItinerary.rhythm.startTime,
      );
      if (splitIndex != null && routeSplitTool.splitAtPointIndex(splitIndex)) {
        return;
      }
    }

    if (!map) return;
    const prediction = predictions?.[targetItinerary.id] ?? targetItinerary.prediction ?? null;
    const point = locateRoutePointAtX(
      targetItinerary.gpxRoute?.points ?? null,
      prediction,
      xMode,
      localXValue,
      targetItinerary.rhythm.startTime,
    );
    if (!point) return;

    const currentPitch = map.getPitch();
    const is2D = currentPitch <= 8;
    const targetPitch = is2D ? 0 : Math.max(currentPitch, CHART_CLICK_FOCUS_PITCH);

    flyToLocation(
      map,
      { lon: point.lon, lat: point.lat },
      {
        zoom: Math.max(map.getZoom(), CHART_CLICK_FOCUS_ZOOM),
        pitch: targetPitch,
      },
    );

    updateHoverPoint(xValue);
  };

  const toggleFilter = (key: 'pente' | 'jourNuit') => {
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
        disabledFilters={disabledFilters}
        pinnedFilters={pinnedFilters}
      />

      <div className="rvc-center-analysis__results" aria-label={t("Graphique d'analyse")}>
        <AnalysisChart
          series={series}
          backdropProfiles={altitudeBackdropProfiles}
          poiAnnotations={poiAnnotations}
          alertAnnotations={alertAnnotations}
          dayNightOverlay={dayNightOverlay}
          pauseOverlay={pauseOverlay}
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
          onPlotRangeSelect={handlePlotRangeSelect}
          selectedXRange={selectedXRange}
          onClearSelectedXRange={handleClearSelectedXRange}
          showSeriesRows={false}
        />
      </div>
    </section>
  );
}

