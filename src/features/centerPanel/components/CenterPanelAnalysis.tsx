import { useEffect, useMemo, useRef, useState } from 'react';
import {
  AnalysisResults,
  type AnalysisChartSeries,
  type AnalysisCursor,
} from '@/features/analysisPanel/components/AnalysisResults';
import { AnalysisSlider } from '@/features/analysisPanel/components/AnalysisSlider';
import {
  defaultAnalysisHoverCards,
  type AnalysisHoverCardData,
} from './AnalysisHoverCards';
import { IconCheck } from './CenterPanelIcons';
import { AxisDropdown, type AxisOption } from './AxisDropdown';

const filters = ['Waypoint', 'POI', 'Pause', 'Alertes', 'Pente', 'Jour/nuit'];

const axisOptions: AxisOption[] = [
  { value: 'Vitesse', label: 'Vitesse', tone: 'primary' },
  { value: 'Vitesse moyenne', label: 'Vitesse moyenne', tone: 'primary' },
  { value: 'Puissance', label: 'Puissance', tone: 'primary' },
  { value: 'Puissance moyenne', label: 'Puissance moyenne', tone: 'primary' },
  { value: 'Dénivelé', label: 'Dénivelé', tone: 'primary' },
  { value: 'Pente', label: 'Pente', tone: 'primary' },
  { value: 'Surface', label: 'Surface', tone: 'primary' },
  { value: 'Température (°)', label: 'Température (°)', tone: 'secondary' },
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

const repeatedTemperatureValues = Array.from({ length: 10 }, () => '17°');

const demoSeries: AnalysisChartSeries[] = [
  {
    id: 'Température',
    color: '#ef1a12',
    strokeWidth: 0.58,
    cellValues: repeatedTemperatureValues,
    points: [
      { x: 0, y: 780 },
      { x: 5, y: 720 },
      { x: 8, y: 1320 },
      { x: 14, y: 0 },
      { x: 22, y: 640 },
      { x: 28, y: 1680 },
      { x: 36, y: 1100 },
      { x: 45, y: 980 },
      { x: 49, y: 380 },
      { x: 53, y: 1900 },
      { x: 58, y: 220 },
      { x: 63, y: 1180 },
      { x: 67, y: 0 },
      { x: 72, y: 1360 },
      { x: 79, y: 1240 },
      { x: 83, y: 160 },
      { x: 92, y: 0 },
      { x: 100, y: 420 },
    ],
  },
  {
    id: 'Température ressentie',
    color: '#ff9d60',
    strokeWidth: 0.52,
    opacity: 0.96,
    cellValues: repeatedTemperatureValues,
    points: [
      { x: 0, y: 2040 },
      { x: 4, y: 2120 },
      { x: 7, y: 1460 },
      { x: 12, y: 3180 },
      { x: 18, y: 3180 },
      { x: 23, y: 2040 },
      { x: 28, y: 1040 },
      { x: 33, y: 1860 },
      { x: 44, y: 1760 },
      { x: 49, y: 240 },
      { x: 52, y: 1960 },
      { x: 57, y: 1580 },
      { x: 66, y: 1320 },
      { x: 70, y: 1240 },
      { x: 73, y: 0 },
      { x: 79, y: 0 },
      { x: 84, y: 2740 },
      { x: 92, y: 3280 },
      { x: 100, y: 2520 },
    ],
  },
  {
    id: 'Température humide',
    color: '#ffd35a',
    strokeWidth: 0.46,
    opacity: 0.94,
    cellValues: repeatedTemperatureValues,
    points: [
      { x: 0, y: 2120 },
      { x: 4, y: 2200 },
      { x: 7, y: 1520 },
      { x: 12, y: 3320 },
      { x: 18, y: 3260 },
      { x: 23, y: 2140 },
      { x: 28, y: 1100 },
      { x: 33, y: 1760 },
      { x: 44, y: 1680 },
      { x: 49, y: 620 },
      { x: 52, y: 2140 },
      { x: 57, y: 1740 },
      { x: 66, y: 1500 },
      { x: 70, y: 1280 },
      { x: 73, y: 0 },
      { x: 79, y: 0 },
      { x: 84, y: 2860 },
      { x: 92, y: 3440 },
      { x: 100, y: 2640 },
    ],
  },
];

function clampNumber(value: number, min: number, max: number) {
  return Math.min(max, Math.max(min, value));
}

function buildCursor(hoverCards: AnalysisHoverCardData[]): AnalysisCursor | null {
  if (hoverCards.length === 0) return null;

  return {
    xPercent: clampNumber(hoverCards[0].anchorX * 100, 0, 100),
    summaries: hoverCards.map((card) => ({
      seriesId: card.id,
      color: card.color,
      distanceLabel: card.metrics.distanceLabel,
      ascentLabel: card.metrics.ascentLabel,
      descentLabel: card.metrics.descentLabel,
      durationLabel: card.metrics.durationLabel,
      scheduleLabel: card.metrics.scheduleLabel,
    })),
  };
}

interface CenterPanelAnalysisProps {
  hoverCards?: AnalysisHoverCardData[];
}

export function CenterPanelAnalysis({ hoverCards = defaultAnalysisHoverCards }: CenterPanelAnalysisProps) {
  const rootRef = useRef<HTMLElement | null>(null);
  const [openAxis, setOpenAxis] = useState<'axis1' | 'axis2' | null>(null);
  const [axis1Value, setAxis1Value] = useState('Dénivelé');
  const [axis2Value, setAxis2Value] = useState('');
  const cursor = useMemo(() => buildCursor(hoverCards), [hoverCards]);

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
    setAxis1Value(value.replace('__bis', ''));
    setOpenAxis(null);
  };

  const selectAxis2 = (value: string) => {
    setAxis2Value(value.replace('__bis', ''));
    setOpenAxis(null);
  };

  return (
    <section ref={rootRef} className="rvc-center-analysis" aria-label="Analyse du parcours">
      <div className="rvc-center-analysis__toolbar">
        <div className="rvc-center-analysis__label">Analyse</div>

        <div className="rvc-center-analysis__segmented" role="tablist" aria-label="Mode d'analyse">
          <button className="rvc-center-analysis__segment rvc-center-analysis__segment--active" type="button">
            Distance
          </button>
          <button className="rvc-center-analysis__segment" type="button">
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

      <div className="rvc-center-analysis__chart-shell">
        <AnalysisResults series={demoSeries} cursor={cursor} />
        <AnalysisSlider />
      </div>
    </section>
  );
}
