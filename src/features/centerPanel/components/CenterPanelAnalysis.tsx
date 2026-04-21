import { useEffect, useRef, useState } from 'react';
import { IconCheck } from './CenterPanelIcons';
import { AxisDropdown, type AxisOption } from './AxisDropdown';
import { IconPlusCircle, IconTrash } from '@/features/controlPanel/icons';
import { IconChevronDown } from './CenterPanelIcons';

const filters = ['Waypoint', 'POI', 'Pause', 'Alertes', 'Pente', 'Jour/nuit'];

const scaleRows = [
  { left: '', right: '' },
  { left: '3000', right: '30°' },
  { left: '', right: '' },
  { left: '2000', right: '20°' },
  { left: '', right: '' },
  { left: '1000', right: '10°' },
  { left: '', right: '' },
  { left: '0', right: '0°' },
];

const axisTicks = ['0', '10', '20', '30', '40', '50', '60', '70', '80', '90', ''];

const temperatureRows = [
  { color: '#c50000', label: 'Température' },
  { color: '#ffa630', label: 'Température' },
  { color: '#f6c95b', label: 'Température' },
];

const temperatureValues = Array.from({ length: 10 }, () => '17°');

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

  const renderCells = (values: string[], tone: 'muted' | 'strong', trailing?: React.ReactNode) =>
    axisTicks.map((tick, index) => {
      const isFirst = index === 0;
      const isLast = index === axisTicks.length - 1;
      const value = values[index] ?? tick;

      return (
        <div
          key={`${tone}-${index}`}
          className={[
            'rvc-center-analysis__cell',
            isFirst ? 'rvc-center-analysis__cell--first' : '',
            isLast ? 'rvc-center-analysis__cell--last' : '',
          ]
            .filter(Boolean)
            .join(' ')}
        >
          <span
            className={
              tone === 'strong'
                ? 'rvc-center-analysis__cell-value rvc-center-analysis__cell-value--strong'
                : 'rvc-center-analysis__cell-value'
            }
          >
            {isLast ? trailing ?? value : value}
          </span>
        </div>
      );
    });

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

      <div className="rvc-center-analysis__results" aria-label="Graphique d'analyse">
        <div className="rvc-center-analysis__plot-grid" aria-hidden="true">
          {scaleRows.map((row, rowIndex) => (
            <div key={`${row.left}-${row.right}-${rowIndex}`} className="rvc-center-analysis__scale-row">
              <div className="rvc-center-analysis__scale-label">{row.left}</div>
              {renderCells(
                Array.from({ length: axisTicks.length }, (_, index) =>
                  index === axisTicks.length - 1 ? row.right : '',
                ),
                'muted',
              )}
            </div>
          ))}
        </div>

        <div className="rvc-center-analysis__axis-row" aria-hidden="true">
          <div className="rvc-center-analysis__axis-label-cell" />
          {renderCells(axisTicks, 'strong')}
        </div>

        <div className="rvc-center-analysis__series-list">
          {temperatureRows.map((row, rowIndex) => (
            <div key={`${row.label}-${rowIndex}`} className="rvc-center-analysis__series-row">
              <div className="rvc-center-analysis__series-control">
                <button className="rvc-center-analysis__series-button" type="button">
                  <span
                    className="rvc-center-analysis__series-color"
                    style={{ backgroundColor: row.color }}
                    aria-hidden="true"
                  />
                  <span className="rvc-center-analysis__series-label">{row.label}</span>
                  <IconChevronDown size={14} aria-hidden="true" />
                </button>
              </div>

              {renderCells(temperatureValues, 'muted',
                <button className="rvc-center-analysis__series-delete" type="button" aria-label="Supprimer la série">
                  <IconTrash size={12} />
                </button>,
              )}
            </div>
          ))}
        </div>

        <div className="rvc-center-analysis__footer">
          <button className="rvc-center-analysis__add-button" type="button">
            <IconPlusCircle size={12} />
            <span>Ajouter</span>
            <IconChevronDown size={14} className="rvc-center-analysis__footer-caret" aria-hidden="true" />
          </button>
        </div>

        <div className="rvc-center-analysis__scrollbar" aria-hidden="true">
          <div className="rvc-center-analysis__scrollbar-track" />
          <div className="rvc-center-analysis__scrollbar-thumb">
            <div className="rvc-center-analysis__scrollbar-grip">...</div>
          </div>
        </div>
      </div>

    </section>
  );
}
