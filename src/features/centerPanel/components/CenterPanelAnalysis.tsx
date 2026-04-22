import { useEffect, useMemo, useRef, useState, type ChangeEvent } from 'react';
import { IconCheck } from './CenterPanelIcons';
import { AxisDropdown, type AxisOption } from './AxisDropdown';
import {
  AnalysisChart,
  buildSeriesFromPrediction,
  isInclinationMetric,
  type AxisMetricId,
  type AxisMode,
  type ChartBackdropProfile,
  type ChartSeries,
} from './chart';
import {
  usePredictionStoreOptional,
  useProjectStoreOptional,
} from '@/features/itineraryPanel';
import { createDefaultAnalysisPanelState } from '@/features/itineraryPanel/defaultState';
import type {
  AnalysisFiltersState,
  AnalysisPanelState,
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

export function CenterPanelAnalysis() {
  const rootRef = useRef<HTMLElement | null>(null);
  const [openAxis, setOpenAxis] = useState<'axis1' | 'axis2' | null>(null);

  const projectStore = useProjectStoreOptional();
  const predictionStore = usePredictionStoreOptional();

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
  const detailZoom = analysisState.detailZoom;
  const detailOffset = analysisState.detailOffset;

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
    updateAnalysis((draft) => {
      draft.filters[key] = !draft.filters[key];
    });
  };

  const handleDetailZoomChange = (event: ChangeEvent<HTMLInputElement>) => {
    const nextZoom = normalizeUnitInterval(Number(event.target.value) / 100);
    updateAnalysis((draft) => {
      draft.detailZoom = nextZoom;
    });
  };

  const handleDetailOffsetChange = (value: number) => {
    updateAnalysis((draft) => {
      draft.detailOffset = normalizeUnitInterval(value);
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
    for (const itinerary of projectStore.project.itineraries) {
      if (itinerary.visible === false) continue;
      const prediction = predictionStore?.predictions[itinerary.id] ?? itinerary.prediction ?? null;
      const routePoints = itinerary.gpxRoute?.points ?? null;

      const axis1Points = buildSeriesFromPrediction(prediction, axis1Value, xMode, routePoints);
      if (axis1Points) {
        result.push({
          id: `${itinerary.id}::axis1`,
          itineraryId: itinerary.id,
          itineraryName: itinerary.name,
          metricId: axis1Value,
          color: itinerary.color,
          axis: 1,
          unit: '',
          points: axis1Points,
        });
      }

      const axis2Points = buildSeriesFromPrediction(prediction, axis2Value, xMode, routePoints);
      if (axis2Points) {
        result.push({
          id: `${itinerary.id}::axis2`,
          itineraryId: itinerary.id,
          itineraryName: itinerary.name,
          metricId: axis2Value,
          color: lightenColor(itinerary.color, 0.4),
          axis: 2,
          unit: '',
          points: axis2Points,
        });
      }
    }
    return result;
  }, [projectStore, predictionStore, axis1Value, axis2Value, xMode]);

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
    for (const itinerary of projectStore.project.itineraries) {
      if (itinerary.visible === false) continue;
      const prediction = predictionStore?.predictions[itinerary.id] ?? itinerary.prediction ?? null;
      const points = buildSeriesFromPrediction(
        prediction,
        'Altitude',
        xMode,
        itinerary.gpxRoute?.points ?? null,
      );
      if (!points) continue;
      result.push({
        id: `${itinerary.id}::altitude-backdrop`,
        itineraryId: itinerary.id,
        itineraryName: itinerary.name,
        points,
      });
    }
    return result;
  }, [showAltitudeBackdrop, projectStore, predictionStore, xMode]);

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
        </div>

        <div className="rvc-center-analysis__detail">
          <span className="rvc-center-analysis__minor-label">Détail</span>
          <div className="rvc-center-analysis__slider-group">
            <span aria-hidden="true">-</span>
            <label
              className="rvc-center-analysis__slider"
              style={{ ['--rvc-center-analysis-slider-ratio' as string]: detailZoom.toString() }}
            >
              <input
                className="rvc-center-analysis__slider-input"
                type="range"
                min="0"
                max="100"
                step="1"
                value={Math.round(detailZoom * 100)}
                onChange={handleDetailZoomChange}
                aria-label="Zoom du graphique"
              />
              <span className="rvc-center-analysis__slider-fill" aria-hidden="true" />
              <span className="rvc-center-analysis__slider-thumb" aria-hidden="true" />
            </label>
            <span aria-hidden="true">+</span>
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

      <div className="rvc-center-analysis__results" aria-label="Graphique d'analyse">
        <AnalysisChart
          series={series}
          backdropProfiles={altitudeBackdropProfiles}
          axis1Metric={axis1Value}
          axis2Metric={axis2Value}
          xMode={xMode}
          detailZoom={detailZoom}
          detailOffset={detailOffset}
          onDetailOffsetChange={handleDetailOffsetChange}
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

function normalizeAnalysisState(state?: Partial<AnalysisPanelState> | null): AnalysisPanelState {
  const fallback = createDefaultAnalysisPanelState();
  return {
    xMode: state?.xMode ?? fallback.xMode,
    axis1: migrateAxisMetric(state?.axis1 ?? fallback.axis1),
    axis2: migrateAxisMetric(state?.axis2 ?? fallback.axis2),
    filters: {
      ...fallback.filters,
      ...(state?.filters ?? {}),
    },
    detailZoom: normalizeUnitInterval(state?.detailZoom, fallback.detailZoom),
    detailOffset: normalizeUnitInterval(state?.detailOffset, fallback.detailOffset),
  };
}

function normalizeUnitInterval(value: number | undefined, fallback = 0): number {
  if (!Number.isFinite(value)) return fallback;
  return Math.max(0, Math.min(1, value ?? fallback));
}