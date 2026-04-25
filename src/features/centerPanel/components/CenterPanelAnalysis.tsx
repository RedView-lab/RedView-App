import { useEffect, useMemo, useRef, useState } from 'react';
import type { Map as MapboxMap } from 'mapbox-gl';
import { IconCheck } from './CenterPanelIcons';
import { AxisDropdown, type AxisOption } from './AxisDropdown';
import { useAnalysisFlyover } from '../flyover';
import { useRouteSplitToolOptional } from '../routeSplit';
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
} from './chart';
import {
  usePredictionStoreOptional,
  useProjectStoreOptional,
} from '@/features/itineraryPanel';
import {
  buildItineraryVisualNodes,
  getItineraryEndDistanceKm,
  getItineraryStartDistanceKm,
  shiftChartPoints,
  shiftChartX,
} from '@/features/itineraryPanel/lineage/itineraryLineage';
import { createDefaultAnalysisPanelState } from '@/features/itineraryPanel/defaultState';
import type {
  AnalysisFiltersState,
  AnalysisPanelState,
  Itinerary,
} from '@/features/itineraryPanel/types';

type FilterKey = keyof AnalysisFiltersState;

const filterDefs: ReadonlyArray<{ key: FilterKey; label: string }> = [
  { key: 'waypoint', label: 'Waypoint' },
  { key: 'poi', label: 'POI' },
  { key: 'pause', label: 'Pause' },
  { key: 'alertes', label: 'Alertes' },
  { key: 'pente', label: "Profil d'altitude" },
  { key: 'jourNuit', label: 'Jour/nuit' },
];

const axisOptions: AxisOption[] = [
  { value: 'Vitesse', label: 'Vitesse', tone: 'primary' },
  { value: 'Vitesse moyenne', label: 'Vitesse moyenne', tone: 'primary' },
  { value: 'Puissance', label: 'Puissance', tone: 'primary' },
  { value: 'Puissance moyenne', label: 'Puissance moyenne', tone: 'primary' },
  { value: 'Inclinaison (°)', label: 'Inclinaison (°)', tone: 'primary' },
  { value: 'Inclinaison (%)', label: 'Inclinaison (%)', tone: 'primary' },
  { value: 'Surface', label: 'Surface', tone: 'primary' },
  { value: 'Température', label: 'Température', tone: 'secondary' },
  {
    value: 'Température ressentie (°)',
    label: 'Température ressentie (°)',
    tone: 'secondary',
  },
  { value: 'Pluie (mm)', label: 'Pluie (mm)', tone: 'secondary' },
  { value: 'Vent (km/h)', label: 'Vent (km/h)', tone: 'secondary' },
  {
    value: 'Couverture nuageuse (%)',
    label: 'Couverture nuageuse (%)',
    tone: 'secondary',
  },
  { value: 'Humidité (%)', label: 'Humidité (%)', tone: 'secondary' },
  { value: 'Ensoleillement (min)', label: 'Ensoleillement (min)', tone: 'secondary' },
  { value: 'Humidité (%)__bis', label: 'Humidité (%)', tone: 'secondary' },
];

const DETAIL_ZOOM_STEP = 0.1;
const DETAIL_MIN_VISIBLE_FRACTION = 0.04;
const VIEWPORT_COMMIT_DEBOUNCE_MS = 140;
const CHART_CLICK_CAMERA_DURATION_MS = 950;
const CHART_CLICK_FOCUS_ZOOM = 15.5;
const CHART_CLICK_FOCUS_PITCH = 68;

interface CenterPanelAnalysisProps {
  map: MapboxMap | null;
}

export function CenterPanelAnalysis({ map }: CenterPanelAnalysisProps) {
  const rootRef = useRef<HTMLElement | null>(null);
  const [openAxis, setOpenAxis] = useState<'axis1' | 'axis2' | null>(null);
  const [showDayNightRequirementHint, setShowDayNightRequirementHint] = useState(false);

  const projectStore = useProjectStoreOptional();
  const predictionStore = usePredictionStoreOptional();
  const routeSplitTool = useRouteSplitToolOptional();
  const { controlledHoverXValue, setManualHoverXValue } = useAnalysisFlyover();

  // Persisted analysis UI state (axis selections, X-axis mode, filter
  // chips). Read from the project so reopening it restores the chart.
  // Migrate legacy axis labels so projects saved before the rename keep
  // rendering without exposing the removed "Altitude" metric anymore.
  const rawAnalysis = projectStore?.project.analysis;
  const analysisState: AnalysisPanelState = rawAnalysis
    ? normalizeAnalysisState(rawAnalysis)
    : createDefaultAnalysisPanelState();
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
    if (!projectStore) return null;
    return (
      projectStore.project.itineraries.find(
        (itinerary) => itinerary.id === projectStore.project.activeItineraryId,
      ) ?? projectStore.project.itineraries[0] ?? null
    );
  }, [projectStore]);

  const visualNodes = useMemo(
    () => (projectStore ? buildItineraryVisualNodes(projectStore.project.itineraries) : []),
    [projectStore],
  );

  const visibleChartNodes = useMemo(
    () =>
      visualNodes.filter(
        ({ itinerary }) =>
          itinerary.analysisVisible !== false && (itinerary.gpxRoute?.points.length ?? 0) > 0,
      ),
    [visualNodes],
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
    if (!projectStore) return [];
    const result: ChartSeries[] = [];
    for (const node of visualNodes) {
      const itinerary = node.itinerary;
      if (itinerary.analysisVisible === false) continue;
      const prediction = predictionStore?.predictions[itinerary.id] ?? itinerary.prediction ?? null;
      const routePoints = itinerary.gpxRoute?.points ?? null;
      const xOffset = xMode === 'distance' ? node.startDistanceKm : 0;

      const axis1Points = buildSeriesFromPrediction(
        prediction,
        axis1Value,
        xMode,
        routePoints,
        itinerary.rhythm.startTime,
      );
      if (axis1Points) {
        result.push({
          id: `${itinerary.id}::axis1`,
          itineraryId: itinerary.id,
          itineraryName: itinerary.name,
          metricId: axis1Value,
          color: itinerary.color,
          axis: 1,
          unit: '',
          points: shiftChartPoints(axis1Points, xOffset),
        });
      }

      const axis2Points = buildSeriesFromPrediction(
        prediction,
        axis2Value,
        xMode,
        routePoints,
        itinerary.rhythm.startTime,
      );
      if (axis2Points) {
        result.push({
          id: `${itinerary.id}::axis2`,
          itineraryId: itinerary.id,
          itineraryName: itinerary.name,
          metricId: axis2Value,
          color: lightenColor(itinerary.color, 0.4),
          axis: 2,
          unit: '',
          points: shiftChartPoints(axis2Points, xOffset),
        });
      }
    }
    return result;
  }, [projectStore, predictionStore, axis1Value, axis2Value, visualNodes, xMode]);

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
    if (!projectStore) return [];

    const result: ChartBackdropProfile[] = [];
    for (const node of visualNodes) {
      const itinerary = node.itinerary;
      if (itinerary.analysisVisible === false) continue;
      const prediction = predictionStore?.predictions[itinerary.id] ?? itinerary.prediction ?? null;
      const points = buildSeriesFromPrediction(
        prediction,
        'Altitude',
        xMode,
        itinerary.gpxRoute?.points ?? null,
        itinerary.rhythm.startTime,
      );
      if (!points) continue;
      result.push({
        id: `${itinerary.id}::altitude-backdrop`,
        itineraryId: itinerary.id,
        itineraryName: itinerary.name,
        color: itinerary.color,
        points: shiftChartPoints(points, xMode === 'distance' ? node.startDistanceKm : 0),
      });
    }
    return result;
  }, [showAltitudeBackdrop, projectStore, predictionStore, visualNodes, xMode]);

  const routeXDomainClamp = useMemo<AxisDomain | null>(() => {
    if (!projectStore) return null;

    const routeProfiles = visualNodes
      .filter(({ itinerary }) => itinerary.analysisVisible !== false)
      .map((node) => {
        const itinerary = node.itinerary;
        const prediction = predictionStore?.predictions[itinerary.id] ?? itinerary.prediction ?? null;
        const points = buildSeriesFromPrediction(
          prediction,
          'Altitude',
          xMode,
          itinerary.gpxRoute?.points ?? null,
          itinerary.rhythm.startTime,
        );
        return points
          ? shiftChartPoints(points, xMode === 'distance' ? node.startDistanceKm : 0)
          : null;
      })
      .filter((points): points is NonNullable<typeof points> => Boolean(points));

    return computeXDomain(routeProfiles, xMode);
  }, [projectStore, predictionStore, visualNodes, xMode]);

  const poiAnnotations = useMemo<ChartPoiAnnotation[]>(() => {
    if (!filters.poi) return [];
    if (!projectStore) return [];

    const result: ChartPoiAnnotation[] = [];
    for (const node of visualNodes) {
      const itinerary = node.itinerary;
      if (itinerary.analysisVisible === false) continue;
      const prediction = predictionStore?.predictions[itinerary.id] ?? itinerary.prediction ?? null;
      const xOffset = xMode === 'distance' ? node.startDistanceKm : 0;
      result.push(
        ...buildPoiAnnotationsForItinerary(itinerary, prediction, xMode).map((annotation) =>
          shiftChartX(annotation, xOffset),
        ),
      );
    }
    return result;
  }, [filters.poi, projectStore, predictionStore, visualNodes, xMode]);

  const alertAnnotations = useMemo<ChartAlertAnnotation[]>(() => {
    if (!filters.alertes) return [];
    if (!projectStore) return [];

    const result: ChartAlertAnnotation[] = [];
    for (const node of visualNodes) {
      const itinerary = node.itinerary;
      if (itinerary.analysisVisible === false) continue;
      const prediction = predictionStore?.predictions[itinerary.id] ?? itinerary.prediction ?? null;
      const xOffset = xMode === 'distance' ? node.startDistanceKm : 0;
      result.push(
        ...buildRouteAuditAnnotationsForItinerary(itinerary, prediction, xMode).map((annotation) =>
          shiftChartX(annotation, xOffset),
        ),
      );
    }
    return result;
  }, [filters.alertes, projectStore, predictionStore, visualNodes, xMode]);

  const dayNightOverlay = useMemo<ChartDayNightOverlay | null>(() => {
    if (!filters.jourNuit || !dayNightStartReady || !activeItinerary) return null;
    if (activeItinerary.analysisVisible === false) return null;

    const prediction =
      predictionStore?.predictions[activeItinerary.id] ?? activeItinerary.prediction ?? null;
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
  }, [activeItinerary, dayNightStartReady, filters.jourNuit, predictionStore, xMode]);

  const dayNightWarning =
    (filters.jourNuit || showDayNightRequirementHint) && !dayNightStartReady
      ? 'Renseigne une date et une heure de départ pour activer Jour/nuit.'
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
      const activePrediction =
        predictionStore?.predictions[activeItinerary.id] ?? activeItinerary.prediction ?? null;
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
    const prediction =
      predictionStore?.predictions[targetItinerary.id] ?? targetItinerary.prediction ?? null;
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
      aria-label="Analyse du parcours"
    >
      <div className="rvc-center-analysis__toolbar">
        <div className="rvc-center-analysis__label">Analyse</div>

        <div className="rvc-center-analysis__segmented" role="tablist" aria-label="Mode d'analyse">
          <button
            className={
              xMode === 'distance'
                ? 'rvc-center-analysis__segment rvc-center-analysis__segment--active'
                : 'rvc-center-analysis__segment'
            }
            type="button"
            onClick={() => setXMode('distance')}
          >
            Distance
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
            Temps
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
            Heures
          </button>
        </div>

        <div className="rvc-center-analysis__detail">
          <span className="rvc-center-analysis__minor-label">Détail</span>
          <div className="rvc-center-analysis__detail-buttons" role="group" aria-label="Zoom du graphique">
            <button
              type="button"
              className="rvc-center-analysis__detail-button"
              onClick={() => adjustDetailZoom(-DETAIL_ZOOM_STEP)}
              disabled={detailZoom <= 0.001}
              aria-label="Dézoomer le graphique"
            >
              -
            </button>
            <button
              type="button"
              className="rvc-center-analysis__detail-button"
              onClick={() => adjustDetailZoom(DETAIL_ZOOM_STEP)}
              disabled={detailZoom >= 0.999}
              aria-label="Zoomer le graphique"
            >
              +
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

        <div className="rvc-center-analysis__filters" aria-label="Filtres">
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
                  aria-label={label}
                />
                <span className="rvc-center-analysis__checkbox" aria-hidden="true">
                  {checked ? <IconCheck size={10} /> : null}
                </span>
                <span className="rvc-center-analysis__filter-label" title={label}>
                  {label}
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

      <div className="rvc-center-analysis__results" aria-label="Graphique d'analyse">
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

/**
 * Lighten a hex color by mixing it with white. Used so the secondary axis
 * curve for an itinerary can be visually distinguished from the primary
 * one without picking an unrelated hue.
 */
function lightenColor(hex: string, amount: number): string {
  const match = /^#?([0-9a-f]{6})$/i.exec(hex.trim());
  if (!match) return hex;
  const value = parseInt(match[1], 16);
  const r = (value >> 16) & 0xff;
  const g = (value >> 8) & 0xff;
  const b = value & 0xff;
  const t = Math.max(0, Math.min(1, amount));
  const lr = Math.round(r + (255 - r) * t);
  const lg = Math.round(g + (255 - g) * t);
  const lb = Math.round(b + (255 - b) * t);
  return `#${((lr << 16) | (lg << 8) | lb).toString(16).padStart(6, '0')}`;
}

/**
 * Map legacy axis labels to their current equivalent so projects saved
 * before a renaming round-trip cleanly through the dropdown selectors.
 */
function migrateAxisMetric(value: string): AxisMetricId {
  if (value === 'Dénivelé' || value === 'Altitude') return 'Inclinaison (%)';
  return value as AxisMetricId;
}

function findSplitIndexForChartX(
  routePoints: Array<{ lat: number; lon: number; distanceM?: number }> | null | undefined,
  prediction: Parameters<typeof locateRoutePointAtX>[1],
  xMode: AxisMode,
  xValue: number,
  startTime?: string | null,
): number | null {
  if (!routePoints || routePoints.length < 4) return null;

  const targetPoint = locateRoutePointAtX(routePoints, prediction, xMode, xValue, startTime);
  const targetDistanceM = targetPoint?.distanceM;
  if (!Number.isFinite(targetDistanceM)) return null;

  const distances = getRoutePointDistances(routePoints);
  let lo = 0;
  let hi = distances.length - 1;
  while (lo + 1 < hi) {
    const mid = Math.floor((lo + hi) / 2);
    if (distances[mid] <= (targetDistanceM as number)) lo = mid;
    else hi = mid;
  }

  const loDistance = Math.abs(distances[lo] - (targetDistanceM as number));
  const hiDistance = Math.abs(distances[hi] - (targetDistanceM as number));
  const bestIndex = hiDistance < loDistance ? hi : lo;
  return Math.max(1, Math.min(bestIndex, routePoints.length - 2));
}

function getRoutePointDistances(
  routePoints: Array<{ lat: number; lon: number; distanceM?: number }>,
): number[] {
  if (routePoints.length === 0) return [];

  const distances: number[] = [0];
  let cumulativeDistanceM = 0;
  for (let index = 1; index < routePoints.length; index += 1) {
    const point = routePoints[index];
    const nextDistance = point.distanceM;
    if (Number.isFinite(nextDistance) && (nextDistance as number) >= cumulativeDistanceM) {
      cumulativeDistanceM = nextDistance as number;
    } else {
      cumulativeDistanceM += haversineM(routePoints[index - 1]!, point);
    }
    distances.push(cumulativeDistanceM);
  }
  return distances;
}

function haversineM(
  start: { lat: number; lon: number },
  end: { lat: number; lon: number },
): number {
  const lat1 = (start.lat * Math.PI) / 180;
  const lat2 = (end.lat * Math.PI) / 180;
  const dLat = lat2 - lat1;
  const dLon = ((end.lon - start.lon) * Math.PI) / 180;
  const sinLat = Math.sin(dLat / 2);
  const sinLon = Math.sin(dLon / 2);
  const h = sinLat * sinLat + Math.cos(lat1) * Math.cos(lat2) * sinLon * sinLon;
  return 12_742_017.6 * Math.asin(Math.min(1, Math.sqrt(h)));
}

function normalizeAnalysisState(state?: Partial<AnalysisPanelState> | null): AnalysisPanelState {
  const fallback = createDefaultAnalysisPanelState();
  const filters = {
    ...fallback.filters,
    ...(state?.filters ?? {}),
  };
  if (filters.poi) filters.pente = true;
  return {
    xMode: state?.xMode ?? fallback.xMode,
    axis1: migrateAxisMetric(state?.axis1 ?? fallback.axis1),
    axis2: migrateAxisMetric(state?.axis2 ?? fallback.axis2),
    filters,
    detailZoom: normalizeUnitInterval(state?.detailZoom, fallback.detailZoom),
    detailOffset: normalizeUnitInterval(state?.detailOffset, fallback.detailOffset),
  };
}

function normalizeUnitInterval(value: number | undefined, fallback = 0): number {
  if (!Number.isFinite(value)) return fallback;
  return Math.max(0, Math.min(1, value ?? fallback));
}

function detailZoomToVisibleFraction(detailZoom: number): number {
  return 1 - normalizeUnitInterval(detailZoom) * (1 - DETAIL_MIN_VISIBLE_FRACTION);
}

function detailOffsetForCenter(center: number, visibleFraction: number): number {
  const remainingSpan = 1 - visibleFraction;
  if (remainingSpan <= 1e-6) return 0;
  return normalizeUnitInterval((center - visibleFraction / 2) / remainingSpan);
}

function selectInteractiveItineraryForChartX(
  visibleChartNodes: Array<{ itinerary: Itinerary; startDistanceKm: number }>,
  activeItineraryId: string | null,
  xMode: AxisMode,
  xValue: number,
): Itinerary | null {
  if (visibleChartNodes.length === 0) return null;

  const activeNode = activeItineraryId
    ? visibleChartNodes.find(({ itinerary }) => itinerary.id === activeItineraryId) ?? null
    : null;
  if (xMode !== 'distance') return activeNode?.itinerary ?? visibleChartNodes[0]?.itinerary ?? null;

  const inRangeNodes = visibleChartNodes.filter(({ itinerary, startDistanceKm }) => {
    const endDistanceKm = getItineraryEndDistanceKm(itinerary);
    return xValue >= startDistanceKm - 1e-6 && xValue <= endDistanceKm + 1e-6;
  });

  if (activeNode && inRangeNodes.some(({ itinerary }) => itinerary.id === activeNode.itinerary.id)) {
    return activeNode.itinerary;
  }

  return inRangeNodes[0]?.itinerary ?? activeNode?.itinerary ?? visibleChartNodes[0]?.itinerary ?? null;
}

function sameViewportValue(left: number, right: number): boolean {
  return Math.abs(left - right) <= 1e-4;
}