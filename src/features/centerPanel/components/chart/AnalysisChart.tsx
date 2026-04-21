import { Fragment, useMemo, type CSSProperties } from 'react';
import { IconPlusCircle, IconTrash } from '@/features/controlPanel/icons';
import { IconChevronDown } from '../CenterPanelIcons';
import { useChartHover } from './useChartHover';
import './chart.css';

// ----- Configuration -----------------------------------------------------

const Y_TICKS = [3000, 2500, 2000, 1500, 1000, 500, 0];
const Y2_TICKS = [30, 25, 20, 15, 10, 5, 0];
const X_TICKS = [0, 5, 10, 15, 20, 25, 30, 35, 40, 45, 50, 55, 60, 65, 70, 75, 80, 85, 90];

const SERIES = [
  { id: 's1', color: '#c50000', label: 'Température' },
  { id: 's2', color: '#ffa630', label: 'Température' },
  { id: 's3', color: '#f6c95b', label: 'Température' },
];

interface HoverCard {
  id: string;
  color: string;
  distance: string;
  ascent: string;
  descent: string;
  duration: string;
  schedule: string;
}

const HOVER_CARDS: HoverCard[] = [
  {
    id: 'a',
    color: '#c50000',
    distance: '127.23 km',
    ascent: '+839 m',
    descent: '-420 m',
    duration: '02:48:59',
    schedule: 'J1 - 08:29',
  },
  {
    id: 'b',
    color: '#ffa630',
    distance: '127.23 km',
    ascent: '+1232 m',
    descent: '-339 m',
    duration: '02:31:19',
    schedule: 'J1 - 08:12',
  },
  {
    id: 'c',
    color: '#f6c95b',
    distance: '127.23 km',
    ascent: '+1232 m',
    descent: '-339 m',
    duration: '02:31:19',
    schedule: 'J1 - 08:12',
  },
];

// ----- Component ---------------------------------------------------------

export function AnalysisChart() {
  // The hover hook attaches to the .rvchart container (single pointer owner).
  const { ref: chartRef, hover } = useChartHover<HTMLDivElement>();

  const style = useMemo<CSSProperties>(
    () => ({ ['--rvchart-left' as string]: '95px', ['--rvchart-right' as string]: '36px' }),
    [],
  );

  // X tick column positions inside the plot area (percent of width).
  const xPositions = useMemo(
    () => X_TICKS.map((v, i) => ({ value: v, ratio: i / (X_TICKS.length - 1) })),
    [],
  );

  // Y line positions inside plot area (percent of height, top→down).
  const yPositions = useMemo(
    () =>
      Y_TICKS.map((v, i) => ({ value: v, slope: Y2_TICKS[i] ?? 0, ratio: i / (Y_TICKS.length - 1) })),
    [],
  );

  return (
    <div ref={chartRef} className="rvchart" style={style}>
      {/* ---- Plot area (Y axes + grid + overlay) ---- */}
      <div className="rvchart__plot">
        <div className="rvchart__yaxis-left" aria-hidden="true">
          {Y_TICKS.map((v) => (
            <span key={`yl-${v}`}>{v}</span>
          ))}
        </div>

        <div className="rvchart__plotarea">
          {/* Layer 1: background grid */}
          <div className="rvchart__layer rvchart__layer--bg" aria-hidden="true">
            {yPositions.map(({ value, ratio }) => (
              <div
                key={`hl-${value}`}
                className="rvchart__hline"
                style={{ top: `${ratio * 100}%` }}
              />
            ))}
            {xPositions.map(({ value, ratio }) => (
              <div
                key={`vl-${value}`}
                className="rvchart__vline"
                style={{ left: `${ratio * 100}%` }}
              />
            ))}
          </div>

          {/* Layer 2: series (placeholder for future plot lines) */}
          <div className="rvchart__layer rvchart__layer--series" aria-hidden="true" />

          {/* Layer 3: overlay (cursor + hover cards) */}
          <div className="rvchart__layer rvchart__layer--overlay" aria-hidden="true">
            {hover ? (
              <>
                <div className="rvchart__cursor" style={{ left: `${hover.x}px` }} />
                <HoverCardGroup hoverX={hover.x} />
              </>
            ) : null}
          </div>
        </div>

        <div className="rvchart__yaxis-right" aria-hidden="true">
          {Y2_TICKS.map((v) => (
            <span key={`yr-${v}`}>{v}°</span>
          ))}
        </div>
      </div>

      {/* ---- X axis row ---- */}
      <div className="rvchart__xaxis">
        <div />
        <div className="rvchart__xaxis-cells">
          {xPositions.map(({ value, ratio }) => (
            <div
              key={`xa-${value}`}
              className="rvchart__xaxis-cell"
              style={{ left: `${ratio * 100}%` }}
            >
              {value}
            </div>
          ))}
        </div>
        <div />
      </div>

      {/* ---- Series rows ---- */}
      {SERIES.map((s) => (
        <div key={s.id} className="rvchart__series">
          <div className="rvchart__series-control">
            <button type="button" className="rvchart__series-button">
              <span className="rvchart__series-swatch" style={{ background: s.color }} />
              <span className="rvchart__series-name">{s.label}</span>
              <IconChevronDown size={12} />
            </button>
          </div>
          <div className="rvchart__series-cells">
            {xPositions.map(({ value, ratio }) => (
              <div
                key={`${s.id}-${value}`}
                className="rvchart__series-cell"
                style={{ left: `${ratio * 100}%` }}
              >
                17°
              </div>
            ))}
          </div>
          <button type="button" className="rvchart__series-trash" aria-label="Supprimer">
            <IconTrash size={12} />
          </button>
        </div>
      ))}

      {/* ---- Add row ---- */}
      <div className="rvchart__add">
        <div className="rvchart__series-control">
          <button type="button" className="rvchart__add-button">
            <IconPlusCircle size={12} />
            <span>Ajouter</span>
          </button>
        </div>
        <div />
        <div />
      </div>
    </div>
  );
}

// ----- Hover cards -------------------------------------------------------

interface HoverCardGroupProps {
  hoverX: number;
}

function HoverCardGroup({ hoverX }: HoverCardGroupProps) {
  return (
    <div
      className="rvchart__cards"
      // Position to the right of the cursor; the parent's overflow:hidden on
      // .rvchart will clip the right edge if it ever overflows, but the cards
      // remain inside the plot stack.
      style={{ left: `${hoverX + 12}px` }}
    >
      {HOVER_CARDS.map((card) => (
        <Fragment key={card.id}>
          <section className="rvchart__card">
            <span className="rvchart__card-dot" style={{ background: card.color }} />
            <div className="rvchart__card-copy">
              <div className="rvchart__card-distance">{card.distance}</div>
              <div className="rvchart__card-metrics">
                <div>{card.ascent}</div>
                <div>{card.descent}</div>
                <div>{card.duration}</div>
                <div>{card.schedule}</div>
              </div>
            </div>
          </section>
        </Fragment>
      ))}
    </div>
  );
}
