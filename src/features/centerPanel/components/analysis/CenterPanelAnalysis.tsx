import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useAnalysisFlyover } from '../../flyover';
import { useRouteSplitToolOptional } from '../../routeSplit';
import {
  CHART_CLICK_CAMERA_DURATION_MS,
  CHART_CLICK_FOCUS_PITCH,
  CHART_CLICK_FOCUS_ZOOM,
  type CenterPanelAnalysisProps,
  DEFAULT_ANALYSIS_AXIS_COLORS,
  findSplitIndexForChartX,
  type FilterKey,
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
  const [showDayNightRequirementHint, setShowDayNightRequirementHint] = useState(false);

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
  const axis2Value = analysisState.axis2 as AxisMetricId;
  const xMode = analysisState.xMode as AxisMode;
  const filters = analysisState.filters;

  const {
    detailZoom,
    detailOffset,
    handleZoomIn,
    handleZoomOut,
    handleOffsetChange,
  } = useAnalysisViewportSync({
    projectStore,
    storedDetailZoom: analysisState.detailZoom,
    storedDetailOffset: analysisState.detailOffset,
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
  });

  const { updateHoverPoint } = useAnalysisHoverPointMarker({
    map,
    visibleChartNodes,
    activeItinerary,
    xMode,
    predictions,
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
      };
      mut(next);
      return { ...prev, analysis: next };
    });
  };

  const toggleFilter = (key: FilterKey) => {
    if (key === 'jourNuit') {
      const wantsEnabled = !filters.jourNuit;
      if (wantsEnabled && !dayNightStartReady) {
        setShowDayNightRequirementHint(true);
        return;
      }
      setShowDayNightRequirementHint(false);
    }

    updateAnalysis((draft) => {
      if (key === 'poi') {
        const wantsPoi = !draft.filters.poi;
        draft.filters.poi = wantsPoi;
        if (wantsPoi) draft.filters.pente = true;
        return;
      }

      if (key === 'pente' && draft.filters.pente && draft.filters.poi) {
        draft.filters.pente = false;
        draft.filters.poi = false;
        return;
      }

      draft.filters[key] = !draft.filters[key];
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

  const dayNightWarning =
    (filters.jourNuit || showDayNightRequirementHint) && !dayNightStartReady
      ? t('Renseigne une date et une heure de départ pour activer Jour/nuit.')
      : null;

  const handleChartClick = (xValue: number) => {
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

    map.easeTo({
      center: [point.lon, point.lat],
      zoom: Math.max(map.getZoom(), CHART_CLICK_FOCUS_ZOOM),
      pitch: targetPitch,
      duration: CHART_CLICK_CAMERA_DURATION_MS,
      essential: true,
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
        detailZoom={detailZoom}
        onZoomIn={handleZoomIn}
        onZoomOut={handleZoomOut}
        openAxis={openAxis}
        onToggleAxis={(axis) => setOpenAxis((curr) => (curr === axis ? null : axis))}
        axis1Value={axis1Value}
        axis2Value={axis2Value}
        axis1Color={axis1Color}
        axis2Color={axis2Color}
        onAxis1Select={(val) => { updateAnalysis((d) => { d.axis1 = val.replace('__bis', '') as AxisMetricId; }); setOpenAxis(null); }}
        onAxis2Select={(val) => { updateAnalysis((d) => { d.axis2 = val.replace('__bis', '') as AxisMetricId; }); setOpenAxis(null); }}
        onAxis1ColorChange={(col) => updateAnalysis((d) => { d.axis1Color = col; })}
        onAxis2ColorChange={(col) => updateAnalysis((d) => { d.axis2Color = col; })}
        filters={filters}
        onToggleFilter={toggleFilter}
      />

      {dayNightWarning ? (
        <div className="rvc-center-analysis__warning" role="status" aria-live="polite">
          {dayNightWarning}
        </div>
      ) : null}

      <div className="rvc-center-analysis__results" aria-label={t("Graphique d'analyse")}>
        <AnalysisChart
          series={series}
          backdropProfiles={altitudeBackdropProfiles}
          poiAnnotations={poiAnnotations}
          alertAnnotations={alertAnnotations}
          dayNightOverlay={dayNightOverlay}
          axis1Metric={axis1Value}
          axis2Metric={axis2Value}
          xMode={xMode}
          detailZoom={detailZoom}
          detailOffset={detailOffset}
          xDomainClamp={routeXDomainClamp}
          onViewportChange={({ detailOffset: o }) => {
            handleOffsetChange(o);
          }}
          onDetailOffsetChange={handleOffsetChange}
          onHoverXValueChange={handleHoverXValueChange}
          controlledHoverXValue={controlledHoverXValue}
          onPlotClick={handleChartClick}
          showSeriesRows={false}
        />
      </div>
    </section>
  );
}
