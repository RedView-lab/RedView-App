import { Fragment, useEffect, useMemo, useState, type CSSProperties } from 'react';
import { IconPlusCircle, IconTrash } from '@/features/controlPanel/icons';
import { IconChevronDown } from '../CenterPanelIcons';
import { useChartHover } from './useChartHover';
import './chart.css';

// ----- Configuration -----------------------------------------------------

const Y_DOMAIN = { min: 0, max: 3000 };
const Y2_DOMAIN = { min: 0, max: 30 };
const DEFAULT_Y_TICKS = [3000, 2500, 2000, 1500, 1000, 500, 0];
const X_TICKS = [0, 5, 10, 15, 20, 25, 30, 35, 40, 45, 50, 55, 60, 65, 70, 75, 80, 85, 90];
const Y_MAJOR_TARGET_PX = 26;

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
  // Hover must be measured in the plot area coordinate space, otherwise the
  // left gutter shifts the cursor and cards away from the actual pointer.
  const { ref: plotAreaRef, hover } = useChartHover<HTMLDivElement>();
  const [plotHeight, setPlotHeight] = useState(0);

  useEffect(() => {
    const node = plotAreaRef.current;
    if (!node) return;

    const update = (height: number) => {
      setPlotHeight((prev) => (Math.abs(prev - height) < 0.5 ? prev : height));
    };

    update(node.getBoundingClientRect().height);

    const ro = new ResizeObserver((entries) => {
      const nextHeight = entries[0]?.contentRect.height;
      if (typeof nextHeight === 'number') {
        update(nextHeight);
      }
    });

    ro.observe(node);
    return () => ro.disconnect();
  }, [plotAreaRef]);

  const style = useMemo<CSSProperties>(
    () => ({ ['--rvchart-left' as string]: '95px', ['--rvchart-right' as string]: '36px' }),
    [],
  );

  // X tick column positions inside the plot area (percent of width).
  const xPositions = useMemo(
    () => X_TICKS.map((v, i) => ({ value: v, ratio: i / (X_TICKS.length - 1) })),
    [],
  );

  const yTicks = useMemo(() => {
    if (plotHeight <= 0) return DEFAULT_Y_TICKS;
    const targetCount = Math.max(2, Math.round(plotHeight / Y_MAJOR_TARGET_PX));
    return buildNiceTicks(Y_DOMAIN.min, Y_DOMAIN.max, targetCount).slice().reverse();
  }, [plotHeight]);

  const y2Ticks = useMemo(
    () => buildInterpolatedTicks(Y2_DOMAIN.max, Y2_DOMAIN.min, yTicks.length),
    [yTicks.length],
  );

  // Y line positions inside plot area (percent of height, top→down).
  const yPositions = useMemo(
    () =>
      yTicks.map((v, i) => ({
        value: v,
        slope: y2Ticks[i] ?? Y2_DOMAIN.min,
        ratio: yTicks.length > 1 ? i / (yTicks.length - 1) : 0,
      })),
    [y2Ticks, yTicks],
  );

  return (
    <div className="rvchart" style={style}>
      {/* ---- Plot area (Y axes + grid + overlay) ---- */}
      <div className="rvchart__plot">
        <div className="rvchart__yaxis-left" aria-hidden="true">
          {yTicks.map((v) => (
            <span key={`yl-${v}`}>{v}</span>
          ))}
        </div>

        <div ref={plotAreaRef} className="rvchart__plotarea">
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
                <HoverCardGroup hoverX={hover.x} hoverRatioX={hover.ratioX} />
              </>
            ) : null}
          </div>
        </div>

        <div className="rvchart__yaxis-right" aria-hidden="true">
          {y2Ticks.map((v, index) => (
            <span key={`yr-${index}-${v}`}>{formatTickLabel(v)}°</span>
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
  hoverRatioX: number;
}

function HoverCardGroup({ hoverX, hoverRatioX }: HoverCardGroupProps) {
  const transform = hoverRatioX > 0.56 ? 'translateX(calc(-100% - 4px))' : 'translateX(4px)';

  return (
    <div
      className="rvchart__cards"
      style={{ left: `${hoverX}px`, transform }}
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

function buildInterpolatedTicks(max: number, min: number, count: number): number[] {
  if (count <= 1) return [max];

  return Array.from({ length: count }, (_, index) => {
    const ratio = index / (count - 1);
    return max + (min - max) * ratio;
  });
}

function buildNiceTicks(min: number, max: number, targetCount: number): number[] {
  const range = Math.max(1e-9, max - min);
  const desired = Math.max(2, targetCount);
  const rough = range / desired;
  const pow10 = Math.pow(10, Math.floor(Math.log10(rough)));
  const norm = rough / pow10;
  let nice: number;

  if (norm < 1.5) nice = 1;
  else if (norm < 3) nice = 2;
  else if (norm < 4) nice = 2.5;
  else if (norm < 7) nice = 5;
  else nice = 10;

  const step = nice * pow10;
  const start = Math.ceil(min / step) * step;
  const ticks: number[] = [];

  for (let value = start; value <= max + step * 1e-6; value += step) {
    const rounded = Math.round(value / step) * step;
    ticks.push(Number(rounded.toFixed(10)));
  }

  if (ticks.length === 0 || ticks[0] > min + step * 1e-6) ticks.unshift(min);
  if (ticks[ticks.length - 1] < max - step * 1e-6) ticks.push(max);

  const seen = new Set<number>();
  return ticks.filter((value) => {
    if (seen.has(value)) return false;
    seen.add(value);
    return true;
  });
}

function formatTickLabel(value: number): string {
  if (Number.isInteger(value)) return String(value);
  return Number(value.toFixed(1)).toString();
}
