import { useEffect, useMemo, useRef, useState } from 'react';
import { IconCheck, IconMinus, IconPlus } from '../CenterPanelIcons';
import { AxisDropdown } from './AxisDropdown';
import { useAnalysisFlyover } from '../../flyover';
import { useRouteSplitToolOptional } from '../../routeSplit';
import {
  axisOptions,
  CHART_CLICK_CAMERA_DURATION_MS,
  CHART_CLICK_FOCUS_PITCH,
  CHART_CLICK_FOCUS_ZOOM,
  type CenterPanelAnalysisProps,
  DETAIL_ZOOM_STEP,
  detailOffsetForCenter,
  detailZoomToVisibleFraction,
  filterDefs,
  findSplitIndexForChartX,
  type FilterKey,
  lightenColor,
  normalizeAnalysisState,
  normalizeUnitInterval,
  type PreparedChartNode,
  sameViewportValue,
  selectInteractiveItineraryForChartX,
  VIEWPORT_COMMIT_DEBOUNCE_MS,
} from './shared';
import {
  AnalysisChart,
  buildChartDayNightOverlay,
  buildSeriesFromPrediction,
  isInclinationMetric,
  buildPoiAnnotationsForItinerary,
  buildRouteAuditAnnotationsForItinerary,
  computeXDomain,
  locateRoutePointAtX,
  type AxisMetricId,
  type AxisMode,
  type AxisDomain,
  type ChartAlertAnnotation,
  type ChartBackdropProfile,
  type ChartDayNightOverlay,
  type ChartPoiAnnotation,
  type ChartSeries,
} from '../chart';
import {
  usePredictionStoreOptional,
  useProjectStoreOptional,
} from '@/features/itineraryPanel';
import { useAppI18n } from '@/shared/i18n';
import {
  buildItineraryVisualNodes,
  getItineraryStartDistanceKm,
  shiftChartPoints,
  shiftChartX,
} from '@/features/itineraryPanel/lineage/itineraryLineage';
import type {
  AnalysisPanelState,
} from '@/features/itineraryPanel/types';

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
  const itineraries = project?.itineraries ?? [];
  const activeItineraryId = project?.activeItineraryId ?? null;
  const predictions = predictionStore?.predictions ?? null;

  // Persisted analysis UI state (axis selections, X-axis mode, filter
  // chips). Read from the project so reopening it restores the chart.
  // Migrate legacy axis labels so projects saved before the rename keep
  // rendering without exposing the removed "Altitude" metric anymore.
  const rawAnalysis = project?.analysis;
  const analysisState: AnalysisPanelState = rawAnalysis
    ? normalizeAnalysisState(rawAnalysis)
    : normalizeAnalysisState();
  const axis1Value = analysisState.axis1 as AxisMetricId;
  const axis2Value = analysisState.axis2 as AxisMetricId;
  const xMode = analysisState.xMode as AxisMode;
  const filters = analysisState.filters;
  const storedDetailZoom = analysisState.detailZoom;
  const storedDetailOffset = analysisState.detailOffset;
  const [viewportState, setViewportState] = useState(() => ({
    detailZoom: storedDetailZoom,
    detailOffset: storedDetailOffset,
  }));
  const detailZoom = viewportState.detailZoom;
  const detailOffset = viewportState.detailOffset;

  useEffect(() => {
    setViewportState((prev) =>
      sameViewportValue(prev.detailZoom, storedDetailZoom) &&
      sameViewportValue(prev.detailOffset, storedDetailOffset)
        ? prev
        : { detailZoom: storedDetailZoom, detailOffset: storedDetailOffset },
    );
  }, [storedDetailOffset, storedDetailZoom]);

  useEffect(() => {
    if (!projectStore) return;
    if (
      sameViewportValue(detailZoom, storedDetailZoom) &&
      sameViewportValue(detailOffset, storedDetailOffset)
    ) {
      return;
    }

    const timeoutId = window.setTimeout(() => {
      projectStore.setProject((prev) => {
        const current = normalizeAnalysisState(prev.analysis);
        if (
          sameViewportValue(current.detailZoom, detailZoom) &&
          sameViewportValue(current.detailOffset, detailOffset)
        ) {
          return prev;
        }
        return {
          ...prev,
          analysis: {
            ...current,
            detailZoom,
            detailOffset,
          },
        };
      });
    }, VIEWPORT_COMMIT_DEBOUNCE_MS);

    return () => window.clearTimeout(timeoutId);
  }, [detailOffset, detailZoom, projectStore, storedDetailOffset, storedDetailZoom]);

  const activeItinerary = useMemo(() => {
    if (itineraries.length === 0) return null;
    return (
      itineraries.find((itinerary) => itinerary.id === activeItineraryId) ??
      itineraries[0] ??
      null
    );
  }, [activeItineraryId, itineraries]);

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

      const prediction = predictions?.[itinerary.id] ?? itinerary.prediction ?? null;
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

  const dayNightStartReady = Boolean(
    activeItinerary?.rhythm.startDate && activeItinerary?.rhythm.startTime,
  );

  const updateAnalysis = (mut: (draft: AnalysisPanelState) => void) => {
    if (!projectStore) return;
    projectStore.setProject((prev) => {
      const current = normalizeAnalysisState(prev.analysis);
      const next: AnalysisPanelState = {
        xMode: current.xMode,
        axis1: current.axis1,
        axis2: current.axis2,
        filters: { ...current.filters },
        detailZoom: current.detailZoom,
        detailOffset: current.detailOffset,
      };
      mut(next);
      return { ...prev, analysis: next };
    });
  };

  const setAxis1Value = (value: AxisMetricId) => {
    updateAnalysis((draft) => {
      draft.axis1 = value;
    });
  };
  const setAxis2Value = (value: AxisMetricId) => {
    updateAnalysis((draft) => {
      draft.axis2 = value;
    });
  };
  const setXMode = (value: AxisMode) => {
    updateAnalysis((draft) => {
      draft.xMode = value;
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
    if (dayNightStartReady) setShowDayNightRequirementHint(false);
  }, [dayNightStartReady]);

  const adjustDetailZoom = (delta: number) => {
    setViewportState((prev) => {
      const currentZoom = normalizeUnitInterval(prev.detailZoom, prev.detailZoom);
      const nextZoom = normalizeUnitInterval(currentZoom + delta, currentZoom);
      const currentVisibleFraction = detailZoomToVisibleFraction(currentZoom);
      const nextVisibleFraction = detailZoomToVisibleFraction(nextZoom);
      const currentCenter =
        normalizeUnitInterval(prev.detailOffset, prev.detailOffset) *
          (1 - currentVisibleFraction) +
        currentVisibleFraction / 2;

      return {
        detailZoom: nextZoom,
        detailOffset: detailOffsetForCenter(currentCenter, nextVisibleFraction),
      };
    });
  };

  const handleDetailOffsetChange = (value: number) => {
    setViewportState((prev) => ({
      ...prev,
      detailOffset: normalizeUnitInterval(value),
    }));
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

  const toggleAxis = (axis: 'axis1' | 'axis2') => {
    setOpenAxis((current) => (current === axis ? null : axis));
  };

  const selectAxis1 = (value: string) => {
    setAxis1Value(value.replace('__bis', '') as AxisMetricId);
    setOpenAxis(null);
  };

  const selectAxis2 = (value: string) => {
    setAxis2Value(value.replace('__bis', '') as AxisMetricId);
    setOpenAxis(null);
  };

  // Build the dynamic chart series from every visible itinerary that has a
  // computed prediction. One curve per (itinerary × axis) combination.
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
          color: itinerary.color,
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
          color: lightenColor(itinerary.color, 0.4),
          axis: 2,
          unit: '',
          points: axis2ShiftedPoints,
        });
      }
    }
    return result;
  }, [axis1Value, axis2Value, preparedChartNodes]);

  // Show the altitude backdrop whenever the user enables the
  // "Profil d'altitude"
  // filter chip. We also show it implicitly when one of the axes is set
  // to an inclination metric, so the slope curve always reads on top of
  // the underlying altitude profile.
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
      .map(({ altitudeShiftedPoints }) =>
        altitudeShiftedPoints ?? null,
      )
      .filter((points): points is NonNullable<typeof points> => Boolean(points));

    return computeXDomain(routeProfiles, xMode);
  }, [preparedChartNodes, xMode]);

  const poiAnnotations = useMemo<ChartPoiAnnotation[]>(() => {
    if (!filters.poi) return [];

    const result: ChartPoiAnnotation[] = [];
    for (const node of preparedChartNodes) {
      const { itinerary, prediction, xOffset } = node;
      result.push(
        ...buildPoiAnnotationsForItinerary(itinerary, prediction, xMode).map((annotation) =>
          shiftChartX(annotation, xOffset),
        ),
      );
    }
    return result;
  }, [filters.poi, preparedChartNodes, xMode]);

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

  const dayNightOverlay = useMemo<ChartDayNightOverlay | null>(() => {
    if (!filters.jourNuit || !dayNightStartReady || !activeItinerary) return null;
    if (activeItinerary.analysisVisible === false) return null;

    const prediction =
      predictions?.[activeItinerary.id] ?? activeItinerary.prediction ?? null;
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

    map.easeTo({
      center: [point.lon, point.lat],
      zoom: Math.max(map.getZoom(), CHART_CLICK_FOCUS_ZOOM),
      pitch: Math.max(map.getPitch(), CHART_CLICK_FOCUS_PITCH),
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
      <div className="rvc-center-analysis__toolbar">
        <div className="rvc-center-analysis__label">{t('Analyse')}</div>

        <div className="rvc-center-analysis__segmented" role="tablist" aria-label={t("Mode d'analyse")}>
          <button
            className={
              xMode === 'distance'
                ? 'rvc-center-analysis__segment rvc-center-analysis__segment--active'
                : 'rvc-center-analysis__segment'
            }
            type="button"
            onClick={() => setXMode('distance')}
          >
            {t('Distance')}
          </button>
          <button
            className={
              xMode === 'temps'
                ? 'rvc-center-analysis__segment rvc-center-analysis__segment--active'
                : 'rvc-center-analysis__segment'
            }
            type="button"
            onClick={() => setXMode('temps')}
          >
            {t('Temps')}
          </button>
          <button
            className={
              xMode === 'heure'
                ? 'rvc-center-analysis__segment rvc-center-analysis__segment--active'
                : 'rvc-center-analysis__segment'
            }
            type="button"
            onClick={() => setXMode('heure')}
          >
            {t('Heures')}
          </button>
        </div>

        <div className="rvc-center-analysis__detail">
          <span className="rvc-center-analysis__minor-label">{t('Détail')}</span>
          <div className="rvc-center-analysis__detail-buttons" role="group" aria-label={t('Zoom du graphique')}>
            <button
              type="button"
              className="rvc-center-analysis__detail-button"
              onClick={() => adjustDetailZoom(-DETAIL_ZOOM_STEP)}
              disabled={detailZoom <= 0.001}
              aria-label={t('Dézoomer le graphique')}
            >
              <IconMinus size={16} aria-hidden="true" />
            </button>
            <button
              type="button"
              className="rvc-center-analysis__detail-button"
              onClick={() => adjustDetailZoom(DETAIL_ZOOM_STEP)}
              disabled={detailZoom >= 0.999}
              aria-label={t('Zoomer le graphique')}
            >
              <IconPlus size={16} aria-hidden="true" />
            </button>
          </div>
        </div>

        <AxisDropdown
          axisLabel="Axe 1"
          value={axis1Value}
          isOpen={openAxis === 'axis1'}
          options={axisOptions}
          onToggle={() => toggleAxis('axis1')}
          onSelect={selectAxis1}
        />

        <AxisDropdown
          axisLabel="Axe 2"
          value={axis2Value}
          isOpen={openAxis === 'axis2'}
          options={axisOptions}
          onToggle={() => toggleAxis('axis2')}
          onSelect={selectAxis2}
        />

        <div className="rvc-center-analysis__separator" aria-hidden="true" />

        <div className="rvc-center-analysis__filters" aria-label={t('Filtres')}>
          {filterDefs.map(({ key, label }) => {
            const checked = filters[key];
            return (
              <label
                key={key}
                className={
                  checked
                    ? 'rvc-center-analysis__filter-chip'
                    : 'rvc-center-analysis__filter-chip rvc-center-analysis__filter-chip--off'
                }
              >
                <input
                  type="checkbox"
                  className="rvc-center-analysis__filter-input"
                  checked={checked}
                  onChange={() => toggleFilter(key)}
                  aria-label={t(label)}
                />
                <span className="rvc-center-analysis__checkbox" aria-hidden="true">
                  {checked ? <IconCheck size={10} /> : null}
                </span>
                <span className="rvc-center-analysis__filter-label" title={t(label)}>
                  {t(label)}
                </span>
              </label>
            );
          })}
        </div>
      </div>

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
          onViewportChange={setViewportState}
          onDetailOffsetChange={handleDetailOffsetChange}
          onHoverXValueChange={setManualHoverXValue}
          controlledHoverXValue={controlledHoverXValue}
          onPlotClick={handleChartClick}
          showSeriesRows={false}
        />
      </div>
    </section>
  );
}
