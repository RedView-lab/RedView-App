import { useEffect, useRef, useState } from 'react';
import { IconCheck, IconChevronDown, IconMoon, IconSun } from './CenterPanelIcons';
import { AxisDropdown, type AxisOption } from './AxisDropdown';

const filters = ['Waypoint', 'POI', 'Pause', 'Alertes', 'Pente', 'Jour/nuit'];
const xTicks = ['0', '10', '20', '30', '40', '50', '60', '70', '80', '90', '100'];
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
const tooltips = [
  {
    className: 'rvc-center-analysis__tooltip--one',
    color: '#d10000',
    lines: ['127.23 km', '+839 m', '-420 m', '02:48:59', 'J1 - 08:29'],
  },
  {
    className: 'rvc-center-analysis__tooltip--two',
    color: '#ffb54a',
    lines: ['127.23 km', '+1232 m', '-339 m', '02:31:19', 'J1 - 08:12'],
  },
  {
    className: 'rvc-center-analysis__tooltip--three',
    color: '#ffb54a',
    lines: ['127.23 km', '+1232 m', '-339 m', '02:31:19', 'J1 - 08:12'],
  },
];

export function CenterPanelAnalysis() {
  const rootRef = useRef<HTMLElement | null>(null);
  const [openAxis, setOpenAxis] = useState<'axis1' | 'axis2' | null>(null);
  const [axis1Value, setAxis1Value] = useState('Dénivelé');
  const [axis2Value, setAxis2Value] = useState('');

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
              <span>{filter}</span>
            </label>
          ))}
        </div>
      </div>

      <div className="rvc-center-analysis__chart-shell">
        <div className="rvc-center-analysis__plot">
          <div className="rvc-center-analysis__band rvc-center-analysis__band--left" />
          <div className="rvc-center-analysis__band rvc-center-analysis__band--right" />
          <div className="rvc-center-analysis__focus-line" />

          <div className="rvc-center-analysis__marker rvc-center-analysis__marker--sun-left" aria-hidden="true">
            <IconSun size={12} />
          </div>
          <div className="rvc-center-analysis__marker rvc-center-analysis__marker--moon-left" aria-hidden="true">
            <IconMoon size={12} />
          </div>
          <div className="rvc-center-analysis__marker rvc-center-analysis__marker--sun-right" aria-hidden="true">
            <IconSun size={12} />
          </div>
          <div className="rvc-center-analysis__marker rvc-center-analysis__marker--moon-right" aria-hidden="true">
            <IconMoon size={12} />
          </div>

          {tooltips.map((tooltip) => (
            <div key={tooltip.className} className={`rvc-center-analysis__tooltip ${tooltip.className}`}>
              <div className="rvc-center-analysis__tooltip-head">
                <span className="rvc-center-analysis__tooltip-dot" style={{ background: tooltip.color }} />
                <span>{tooltip.lines[0]}</span>
              </div>
              {tooltip.lines.slice(1).map((line) => (
                <div key={line}>{line}</div>
              ))}
            </div>
          ))}

          <div className="rvc-center-analysis__y-label rvc-center-analysis__y-label--3000">3000</div>
          <div className="rvc-center-analysis__y-label rvc-center-analysis__y-label--2000">2000</div>
          <div className="rvc-center-analysis__y-label rvc-center-analysis__y-label--1000">1000</div>
          <div className="rvc-center-analysis__y-label rvc-center-analysis__y-label--0">0</div>

          <div className="rvc-center-analysis__x-axis">
            {xTicks.map((tick) => (
              <span key={tick}>{tick}</span>
            ))}
          </div>
        </div>

        <div className="rvc-center-analysis__footer">
          <button className="rvc-center-analysis__add-button" type="button">
            <span className="rvc-center-analysis__add-plus">+</span>
            <span>Ajouter</span>
            <IconChevronDown size={14} />
          </button>
        </div>

        <div className="rvc-center-analysis__scrollbar" aria-hidden="true">
          <div className="rvc-center-analysis__scrollbar-track" />
          <div className="rvc-center-analysis__scrollbar-thumb" />
          <div className="rvc-center-analysis__scrollbar-grip">...</div>
        </div>
      </div>
    </section>
  );
}
