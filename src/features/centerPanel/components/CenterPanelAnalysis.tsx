import { useEffect, useLayoutEffect, useMemo, useRef, useState, type CSSProperties } from 'react';
import { IconCheck } from './CenterPanelIcons';
import { AxisDropdown, type AxisOption } from './AxisDropdown';
import { IconPlusCircle, IconTrash } from '@/features/controlPanel/icons';
import { IconChevronDown } from './CenterPanelIcons';

const filters = ['Waypoint', 'POI', 'Pause', 'Alertes', 'Pente', 'Jour/nuit'];

const Y_MAX = 3000;
const Y2_MAX = 30;
const X_MAX = 90;
const Y_RATIO = Y_MAX / Y2_MAX; // 100

const MIN_X_PX = 80;
const MIN_Y_PX = 44;
const LEFT_COL_PX = 95;
const RESERVED_BELOW_PLOT_PX = 24 + 28 * 3 + 24; // axis + 3 series + add row

const temperatureRows = [
  { color: '#c50000', label: 'TempÃ©rature' },
  { color: '#ffa630', label: 'TempÃ©rature' },
  { color: '#f6c95b', label: 'TempÃ©rature' },
];

const axisOptions: AxisOption[] = [
  { value: 'Vitesse', label: 'Vitesse', tone: 'primary' },
  { value: 'Vitesse moyenne', label: 'Vitesse moyenne', tone: 'primary' },
  { value: 'Puissance', label: 'Puissance', tone: 'primary' },
  { value: 'Puissance moyenne', label: 'Puissance moyenne', tone: 'primary' },
  { value: 'DÃ©nivelÃ©', label: 'DÃ©nivelÃ©', tone: 'primary' },
  { value: 'Pente', label: 'Pente', tone: 'primary' },
  { value: 'Surface', label: 'Surface', tone: 'primary' },
  { value: 'TempÃ©rature (Â°)', label: 'TempÃ©rature (Â°)', tone: 'secondary' },
  {
    value: 'TempÃ©rature ressentie (Â°)',
    label: 'TempÃ©rature ressentie (Â°)',
    tone: 'secondary',
  },
  { value: 'Pluie (mm)', label: 'Pluie (mm)', tone: 'secondary' },
  { value: 'Vent (km/h)', label: 'Vent (km/h)', tone: 'secondary' },
  {
    value: 'Couverture nuageuse (%)',
    label: 'Couverture nuageuse (%)',
    tone: 'secondary',
  },
  { value: 'HumiditÃ© (%)', label: 'HumiditÃ© (%)', tone: 'secondary' },
  { value: 'Ensoleillement (min)', label: 'Ensoleillement (min)', tone: 'secondary' },
  { value: 'HumiditÃ© (%)__bis', label: 'HumiditÃ© (%)', tone: 'secondary' },
];

function niceStep(range: number, targetCount: number): number {
  if (targetCount <= 1 || range <= 0) return range || 1;
  const rough = range / targetCount;
  const pow = Math.pow(10, Math.floor(Math.log10(rough)));
  const norm = rough / pow;
  let nice: number;
  if (norm < 1.5) nice = 1;
  else if (norm < 3) nice = 2;
  else if (norm < 7) nice = 5;
  else nice = 10;
  return nice * pow;
}

function generateTicks(max: number, targetCount: number): number[] {
  const step = niceStep(max, targetCount);
  if (step <= 0) return [0, max];
  const ticks: number[] = [];
  const decimals = step < 1 ? Math.max(0, Math.ceil(-Math.log10(step))) : 0;
  for (let v = 0; v <= max + step * 1e-6; v += step) {
    ticks.push(Number(v.toFixed(decimals + 6)));
  }
  return ticks;
}

const formatNumber = (v: number): string =>
  Number.isInteger(v) ? String(v) : v.toFixed(1).replace(/\.0$/, '');

const formatSlope = (altitude: number): string => `${formatNumber(altitude / Y_RATIO)}Â°`;

export function CenterPanelAnalysis() {
  const rootRef = useRef<HTMLElement | null>(null);
  const resultsRef = useRef<HTMLDivElement | null>(null);
  const [openAxis, setOpenAxis] = useState<'axis1' | 'axis2' | null>(null);
  const [axis1Value, setAxis1Value] = useState('DÃ©nivelÃ©');
  const [axis2Value, setAxis2Value] = useState('');
  const [size, setSize] = useState({ width: 0, height: 0 });

  useLayoutEffect(() => {
    const el = resultsRef.current;
    if (!el) return;
    const update = () => setSize({ width: el.clientWidth, height: el.clientHeight });
    update();
    const ro = new ResizeObserver(update);
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

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

  const { xTicks, scaleRows } = useMemo(() => {
    const dataWidth = Math.max(0, size.width - LEFT_COL_PX);
    const xTargetCount = Math.max(2, Math.floor(dataWidth / MIN_X_PX));
    const xt = generateTicks(X_MAX, xTargetCount);

    const plotHeight = Math.max(80, size.height - RESERVED_BELOW_PLOT_PX);
    const yTargetCount = Math.max(2, Math.floor(plotHeight / MIN_Y_PX));
    const yt = generateTicks(Y_MAX, yTargetCount);
    const ytTopDown = [...yt].reverse();

    // 1 headroom row above the highest tick + one row per Y tick (label aligned to row bottom)
    const sr = [
      { left: '', right: '' },
      ...ytTopDown.map((y) => ({ left: formatNumber(y), right: formatSlope(y) })),
    ];

    return { xTicks: xt, scaleRows: sr };
  }, [size]);

  const totalCols = xTicks.length + 1; // X tick cells + 1 right gutter cell

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

  const renderCells = (
    values: string[],
    tone: 'muted' | 'strong',
    trailing?: React.ReactNode,
  ) => {
    const cells: React.ReactElement[] = [];
    const valueClass =
      tone === 'strong'
        ? 'rvc-center-analysis__cell-value rvc-center-analysis__cell-value--strong'
        : 'rvc-center-analysis__cell-value';

    for (let i = 0; i < xTicks.length; i++) {
      const isFirst = i === 0;
      cells.push(
        <div
          key={`${tone}-${i}`}
          className={[
            'rvc-center-analysis__cell',
            isFirst ? 'rvc-center-analysis__cell--first' : '',
          ]
            .filter(Boolean)
            .join(' ')}
        >
          <span className={valueClass}>{values[i] ?? ''}</span>
        </div>,
      );
    }

    cells.push(
      <div
        key={`${tone}-last`}
        className="rvc-center-analysis__cell rvc-center-analysis__cell--last"
      >
        {trailing !== undefined ? (
          trailing
        ) : (
          <span className={valueClass}>{values[xTicks.length] ?? ''}</span>
        )}
      </div>,
    );

    return cells;
  };

  const sectionStyle = { '--rvc-center-results-rows': totalCols } as CSSProperties;

  return (
    <section
      ref={rootRef}
      className="rvc-center-analysis"
      aria-label="Analyse du parcours"
      style={sectionStyle}
    >
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
          <span className="rvc-center-analysis__minor-label">DÃ©tail</span>
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

      <div ref={resultsRef} className="rvc-center-analysis__results" aria-label="Graphique d'analyse">
        <div className="rvc-center-analysis__plot-grid" aria-hidden="true">
          {scaleRows.map((row, rowIndex) => (
            <div key={`scale-${rowIndex}`} className="rvc-center-analysis__scale-row">
              <div className="rvc-center-analysis__scale-label">{row.left}</div>
              {renderCells(
                [...Array<string>(xTicks.length).fill(''), row.right],
                'muted',
              )}
            </div>
          ))}
        </div>

        <div className="rvc-center-analysis__axis-row" aria-hidden="true">
          <div className="rvc-center-analysis__axis-label-cell" />
          {renderCells([...xTicks.map(formatNumber), ''], 'strong')}
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

              {renderCells(
                Array<string>(xTicks.length).fill('17Â°'),
                'muted',
                <button className="rvc-center-analysis__series-delete" type="button" aria-label="Supprimer la sÃ©rie">
                  <IconTrash size={12} />
                </button>,
              )}
            </div>
          ))}
        </div>

        <div className="rvc-center-analysis__lower">
          <div className="rvc-center-analysis__add-row">
            <div className="rvc-center-analysis__series-control">
              <button className="rvc-center-analysis__add-button" type="button">
                <IconPlusCircle size={12} />
                <span>Ajouter</span>
                <IconChevronDown size={14} className="rvc-center-analysis__footer-caret" aria-hidden="true" />
              </button>
            </div>

            {renderCells(Array<string>(xTicks.length + 1).fill(''), 'muted')}
          </div>
        </div>
      </div>

    </section>
  );
}
