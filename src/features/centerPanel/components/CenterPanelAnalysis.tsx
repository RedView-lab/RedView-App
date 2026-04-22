import { useEffect, useMemo, useRef, useState } from 'react';
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

const filters = ['Waypoint', 'POI', 'Pause', 'Alertes', 'Pente', 'Jour/nuit'];

const axisOptions: AxisOption[] = [
  { value: 'Vitesse', label: 'Vitesse', tone: 'primary' },
  { value: 'Vitesse moyenne', label: 'Vitesse moyenne', tone: 'primary' },
  { value: 'Puissance', label: 'Puissance', tone: 'primary' },
  { value: 'Puissance moyenne', label: 'Puissance moyenne', tone: 'primary' },
  { value: 'Dénivelé', label: 'Dénivelé', tone: 'primary' },
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
  const [axis1Value, setAxis1Value] = useState<AxisMetricId>('Vitesse');
  const [axis2Value, setAxis2Value] = useState<AxisMetricId>('Puissance');
  const [xMode, setXMode] = useState<AxisMode>('distance');

  const projectStore = useProjectStoreOptional();
  const predictionStore = usePredictionStoreOptional();

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
    if (!projectStore || !predictionStore) return [];
    const result: ChartSeries[] = [];
    for (const itinerary of projectStore.project.itineraries) {
      if (itinerary.visible === false) continue;
      const prediction = predictionStore.predictions[itinerary.id];
      if (!prediction) continue;

      const axis1Points = buildSeriesFromPrediction(prediction, axis1Value, xMode);
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

      const axis2Points = buildSeriesFromPrediction(prediction, axis2Value, xMode);
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

  const altitudeBackdropProfiles = useMemo<ChartBackdropProfile[]>(() => {
    if (!isInclinationMetric(axis1Value) && !isInclinationMetric(axis2Value)) return [];
    if (!projectStore || !predictionStore) return [];

    const result: ChartBackdropProfile[] = [];
    for (const itinerary of projectStore.project.itineraries) {
      if (itinerary.visible === false) continue;
      const prediction = predictionStore.predictions[itinerary.id];
      if (!prediction) continue;
      const points = buildSeriesFromPrediction(prediction, 'Dénivelé', xMode);
      if (!points) continue;
      result.push({
        id: `${itinerary.id}::altitude-backdrop`,
        itineraryId: itinerary.id,
        itineraryName: itinerary.name,
        points,
      });
    }
    return result;
  }, [axis1Value, axis2Value, projectStore, predictionStore, xMode]);

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
          <div className="rvc-center-analysis__slider-group" aria-hidden="true">
            <span>-</span>
            <div className="rvc-center-analysis__slider">
              <div className="rvc-center-analysis__slider-fill" />
              <div className="rvc-center-analysis__slider-thumb" />
            </div>
            <span>+</span>
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
          {filters.map((filter) => (
            <label key={filter} className="rvc-center-analysis__filter-chip">
              <span className="rvc-center-analysis__checkbox" aria-hidden="true">
                <IconCheck size={10} />
              </span>
              <span className="rvc-center-analysis__filter-label" title={filter}>{filter}</span>
            </label>
          ))}
        </div>
      </div>

      <div className="rvc-center-analysis__results" aria-label="Graphique d'analyse">
        <AnalysisChart
          series={series}
          backdropProfiles={altitudeBackdropProfiles}
          axis1Metric={axis1Value}
          axis2Metric={axis2Value}
          xMode={xMode}
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