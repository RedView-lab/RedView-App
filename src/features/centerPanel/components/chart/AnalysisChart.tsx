import { Fragment, useEffect, useMemo, useState, type CSSProperties } from 'react';
import { IconPlusCircle, IconTrash } from '@/features/controlPanel/icons';
import { IconChevronDown } from '../CenterPanelIcons';
import { useChartHover } from './useChartHover';
import {
  computeDomain,
  computeXDomain,
  formatAxisValue,
  metricIsAvailable,
  unitForMetric,
  type AxisDomain,
  type AxisMetricId,
  type AxisMode,
  type ChartSeries,
} from './series';
import './chart.css';

// ----- Configuration -----------------------------------------------------

const Y_MAJOR_TARGET_PX = 26;
const X_MAJOR_TARGET_PX = 80;
const DEFAULT_TICK_COUNT = 6;

interface AnalysisChartProps {
  series: ChartSeries[];
  axis1Metric: AxisMetricId;
  axis2Metric: AxisMetricId;
  xMode: AxisMode;
}

// ----- Component ---------------------------------------------------------

export function AnalysisChart({
  series,
  axis1Metric,
  axis2Metric,
  xMode,
}: AnalysisChartProps) {
  const { ref: plotAreaRef, hover } = useChartHover<HTMLDivElement>();
  const [plotSize, setPlotSize] = useState({ width: 0, height: 0 });

  useEffect(() => {
    const node = plotAreaRef.current;
    if (!node) return;

    const update = (width: number, height: number) => {
      setPlotSize((prev) =>
        Math.abs(prev.width - width) < 0.5 && Math.abs(prev.height - height) < 0.5
          ? prev
          : { width, height },
      );
    };

    const rect = node.getBoundingClientRect();
    update(rect.width, rect.height);

    const ro = new ResizeObserver((entries) => {
      const cr = entries[0]?.contentRect;
      if (cr) update(cr.width, cr.height);
    });

    ro.observe(node);
    return () => ro.disconnect();
  }, [plotAreaRef]);

  const axis1Series = useMemo(() => series.filter((s) => s.axis === 1), [series]);
  const axis2Series = useMemo(() => series.filter((s) => s.axis === 2), [series]);

  const xDomain = useMemo<AxisDomain>(() => {
    const dom = computeXDomain(series.map((s) => s.points));
    if (dom) return dom;
    return xMode === 'distance' ? { min: 0, max: 90 } : { min: 0, max: 6 };
  }, [series, xMode]);

  const yDomain = useMemo<AxisDomain>(() => {
    const dom = computeDomain(axis1Series.map((s) => s.points));
    if (dom) return dom;
    return { min: 0, max: defaultDomainFor(axis1Metric) };
  }, [axis1Series, axis1Metric]);

  const y2Domain = useMemo<AxisDomain>(() => {
    const dom = computeDomain(axis2Series.map((s) => s.points));
    if (dom) return dom;
    return { min: 0, max: defaultDomainFor(axis2Metric) };
  }, [axis2Series, axis2Metric]);

  const xTicks = useMemo(() => {
    const target = Math.max(2, Math.round(plotSize.width / X_MAJOR_TARGET_PX));
    return buildNiceTicks(xDomain.min, xDomain.max, target || DEFAULT_TICK_COUNT);
  }, [plotSize.width, xDomain.min, xDomain.max]);

  const yTicksAsc = useMemo(() => {
    const target =
      plotSize.height > 0
        ? Math.max(2, Math.round(plotSize.height / Y_MAJOR_TARGET_PX))
        : DEFAULT_TICK_COUNT;
    return buildNiceTicks(yDomain.min, yDomain.max, target);
  }, [plotSize.height, yDomain.min, yDomain.max]);

  const yTicks = useMemo(() => yTicksAsc.slice().reverse(), [yTicksAsc]);

  const y2Ticks = useMemo(
    () => buildInterpolatedTicks(y2Domain.max, y2Domain.min, yTicks.length),
    [y2Domain.max, y2Domain.min, yTicks.length],
  );

  const xPositions = useMemo(
    () =>
      xTicks.map((value) => ({
        value,
        ratio: ratioFor(value, xDomain),
      })),
    [xTicks, xDomain],
  );
  const yPositions = useMemo(
    () =>
      yTicks.map((value, index) => ({
        value,
        ratio: yTicks.length > 1 ? index / (yTicks.length - 1) : 0,
      })),
    [yTicks],
  );

  const style = useMemo<CSSProperties>(
    () => ({ ['--rvchart-left' as string]: '95px', ['--rvchart-right' as string]: '60px' }),
    [],
  );

  const seriesPaths = useMemo(
    () =>
      series.map((s) => ({
        id: s.id,
        color: s.color,
        path: buildSvgPath(s.points, xDomain, s.axis === 2 ? y2Domain : yDomain),
      })),
    [series, xDomain, yDomain, y2Domain],
  );

  const hoverData = useMemo(() => {
    if (!hover || !series.length) return null;
    const hoveredX = xDomain.min + hover.ratioX * (xDomain.max - xDomain.min);
    return series.map((s) => ({
      id: s.id,
      itineraryName: s.itineraryName,
      color: s.color,
      axis: s.axis,
      metric: s.metricId,
      value: interpolateY(s.points, hoveredX),
    }));
  }, [hover, series, xDomain]);

  return (
    <div className="rvchart" style={style}>
      {/* ---- Plot area (Y axes + grid + overlay) ---- */}
      <div className="rvchart__plot">
        <div className="rvchart__yaxis-left" aria-hidden="true">
          {yTicks.map((value, index) => (
            <span key={`yl-${index}-${value}`}>{formatAxisLabel(value, axis1Metric)}</span>
          ))}
        </div>

        <div ref={plotAreaRef} className="rvchart__plotarea">
          {/* Layer 1: background grid */}
          <div className="rvchart__layer rvchart__layer--bg" aria-hidden="true">
            {yPositions.map(({ value, ratio }) => (
              <div
                key={`hl-${value}-${ratio.toFixed(4)}`}
                className="rvchart__hline"
                style={{ top: `${ratio * 100}%` }}
              />
            ))}
            {xPositions.map(({ value, ratio }) => (
              <div
                key={`vl-${value}-${ratio.toFixed(4)}`}
                className="rvchart__vline"
                style={{ left: `${ratio * 100}%` }}
              />
            ))}
          </div>

          {/* Layer 2: series */}
          <svg
            className="rvchart__layer rvchart__layer--series"
            viewBox="0 0 100 100"
            preserveAspectRatio="none"
            aria-hidden="true"
          >
            {seriesPaths.map((entry) =>
              entry.path ? (
                <path
                  key={entry.id}
                  d={entry.path}
                  fill="none"
                  stroke={entry.color}
                  strokeWidth={1.4}
                  strokeLinejoin="round"
                  strokeLinecap="round"
                  vectorEffect="non-scaling-stroke"
                />
              ) : null,
            )}
          </svg>

          {/* Layer 3: overlay (cursor + hover cards) */}
          <div className="rvchart__layer rvchart__layer--overlay" aria-hidden="true">
            {hover ? (
              <>
                <div className="rvchart__cursor" style={{ left: `${hover.x}px` }} />
                <HoverCardGroup
                  hoverX={hover.x}
                  hoverRatioX={hover.ratioX}
                  xValue={xDomain.min + hover.ratioX * (xDomain.max - xDomain.min)}
                  xMode={xMode}
                  rows={hoverData ?? []}
                />
              </>
            ) : null}
          </div>
        </div>

        <div className="rvchart__yaxis-right" aria-hidden="true">
          {y2Ticks.map((value, index) => (
            <span key={`yr-${index}-${value}`}>{formatAxisLabel(value, axis2Metric)}</span>
          ))}
        </div>
      </div>

      {/* ---- X axis row ---- */}
      <div className="rvchart__xaxis">
        <div />
        <div className="rvchart__xaxis-cells">
          {xPositions.map(({ value, ratio }) => (
            <div
              key={`xa-${value}-${ratio.toFixed(4)}`}
              className="rvchart__xaxis-cell"
              style={{ left: `${ratio * 100}%` }}
            >
              {formatXTick(value, xMode)}
            </div>
          ))}
        </div>
        <div />
      </div>

      {/* ---- Series rows (one per visible itinerary axis curve) ---- */}
      {series.length === 0 ? (
        <EmptySeriesRow axis1={axis1Metric} axis2={axis2Metric} />
      ) : (
        series.map((s) => (
          <SeriesRow key={s.id} seriesEntry={s} xPositions={xPositions} />
        ))
      )}

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

// ----- Series row --------------------------------------------------------

interface SeriesRowProps {
  seriesEntry: ChartSeries;
  xPositions: { value: number; ratio: number }[];
}

function SeriesRow({ seriesEntry, xPositions }: SeriesRowProps) {
  const cellValues = useMemo(
    () =>
      xPositions.map(({ value, ratio }) => ({
        value,
        ratio,
        y: interpolateY(seriesEntry.points, value),
      })),
    [seriesEntry.points, xPositions],
  );

  return (
    <div className="rvchart__series">
      <div className="rvchart__series-control">
        <button type="button" className="rvchart__series-button">
          <span className="rvchart__series-swatch" style={{ background: seriesEntry.color }} />
          <span className="rvchart__series-name">
            {seriesEntry.itineraryName} · {seriesEntry.metricId}
          </span>
          <IconChevronDown size={12} />
        </button>
      </div>
      <div className="rvchart__series-cells">
        {cellValues.map(({ value, ratio, y }) => (
          <div
            key={`${seriesEntry.id}-${value}`}
            className="rvchart__series-cell"
            style={{ left: `${ratio * 100}%` }}
          >
            {Number.isFinite(y) ? formatCellValue(y, seriesEntry.metricId) : '--'}
          </div>
        ))}
      </div>
      <button type="button" className="rvchart__series-trash" aria-label="Supprimer">
        <IconTrash size={12} />
      </button>
    </div>
  );
}

function EmptySeriesRow({ axis1, axis2 }: { axis1: AxisMetricId; axis2: AxisMetricId }) {
  const message = (() => {
    const a1Ok = metricIsAvailable(axis1);
    const a2Ok = metricIsAvailable(axis2);
    if (!a1Ok && !a2Ok) return `${axis1} et ${axis2} ne sont pas encore disponibles.`;
    return 'Aucune prédiction calculée — lancez « Calculer ».';
  })();

  return (
    <div className="rvchart__series">
      <div className="rvchart__series-control">
        <button type="button" className="rvchart__series-button" disabled>
          <span className="rvchart__series-swatch" style={{ background: 'rgba(255,255,255,0.16)' }} />
          <span className="rvchart__series-name">{message}</span>
        </button>
      </div>
      <div />
      <div />
    </div>
  );
}

// ----- Hover cards -------------------------------------------------------

interface HoverCardGroupProps {
  hoverX: number;
  hoverRatioX: number;
  xValue: number;
  xMode: AxisMode;
  rows: {
    id: string;
    itineraryName: string;
    color: string;
    axis: 1 | 2;
    metric: AxisMetricId;
    value: number;
  }[];
}

function HoverCardGroup({ hoverX, hoverRatioX, xValue, xMode, rows }: HoverCardGroupProps) {
  if (rows.length === 0) return null;
  const transform = hoverRatioX > 0.56 ? 'translateX(calc(-100% - 4px))' : 'translateX(4px)';

  return (
    <div className="rvchart__cards" style={{ left: `${hoverX}px`, transform }}>
      {rows.map((row) => (
        <Fragment key={row.id}>
          <section className="rvchart__card">
            <span className="rvchart__card-dot" style={{ background: row.color }} />
            <div className="rvchart__card-copy">
              <div className="rvchart__card-distance">
                {row.itineraryName} · Axe {row.axis}
              </div>
              <div className="rvchart__card-metrics">
                <div>
                  {row.metric}: {Number.isFinite(row.value) ? formatAxisValue(row.metric, row.value) : '--'}
                </div>
                <div>{xMode === 'distance' ? `${xValue.toFixed(1)} km` : formatHours(xValue)}</div>
              </div>
            </div>
          </section>
        </Fragment>
      ))}
    </div>
  );
}

// ----- Helpers -----------------------------------------------------------

function defaultDomainFor(metric: AxisMetricId): number {
  switch (metric) {
    case 'Vitesse':
    case 'Vitesse moyenne':
      return 50;
    case 'Puissance':
    case 'Puissance moyenne':
      return 400;
    case 'Dénivelé':
      return 3000;
    case 'Pente':
      return 30;
    default:
      return 100;
  }
}

function ratioFor(value: number, domain: AxisDomain): number {
  const span = domain.max - domain.min;
  if (span <= 0) return 0;
  return Math.max(0, Math.min(1, (value - domain.min) / span));
}

function buildSvgPath(
  points: { x: number; y: number }[],
  xDomain: AxisDomain,
  yDomain: AxisDomain,
): string {
  if (points.length < 2) return '';
  const xSpan = xDomain.max - xDomain.min;
  const ySpan = yDomain.max - yDomain.min;
  if (xSpan <= 0 || ySpan <= 0) return '';
  let d = '';
  for (let i = 0; i < points.length; i++) {
    const p = points[i];
    const x = ((p.x - xDomain.min) / xSpan) * 100;
    const y = 100 - ((p.y - yDomain.min) / ySpan) * 100;
    if (!Number.isFinite(x) || !Number.isFinite(y)) continue;
    d += `${i === 0 ? 'M' : 'L'} ${x.toFixed(3)} ${y.toFixed(3)} `;
  }
  return d.trim();
}

function interpolateY(points: { x: number; y: number }[], xValue: number): number {
  if (points.length === 0) return Number.NaN;
  if (xValue <= points[0].x) return points[0].y;
  if (xValue >= points[points.length - 1].x) return points[points.length - 1].y;
  let lo = 0;
  let hi = points.length - 1;
  while (hi - lo > 1) {
    const mid = (lo + hi) >> 1;
    if (points[mid].x <= xValue) lo = mid;
    else hi = mid;
  }
  const a = points[lo];
  const b = points[hi];
  const span = b.x - a.x;
  if (span <= 0) return a.y;
  const t = (xValue - a.x) / span;
  return a.y + (b.y - a.y) * t;
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
    ticks.push(Number((Math.round(value / step) * step).toFixed(10)));
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

function formatAxisLabel(value: number, metric: AxisMetricId): string {
  if (!Number.isFinite(value)) return '--';
  let txt: string;
  if (Number.isInteger(value)) txt = String(value);
  else if (Math.abs(value) >= 100) txt = String(Math.round(value));
  else if (Math.abs(value) >= 10) txt = value.toFixed(1);
  else txt = Number(value.toFixed(2)).toString();
  const unit = unitForMetric(metric);
  return unit ? `${txt}${unit === '°C' ? '°' : unit}` : txt;
}

function formatXTick(value: number, xMode: AxisMode): string {
  if (xMode === 'distance') {
    if (Number.isInteger(value)) return String(value);
    return value.toFixed(1);
  }
  return formatHours(value);
}

function formatHours(hours: number): string {
  if (!Number.isFinite(hours)) return '--';
  const totalMin = Math.round(hours * 60);
  const h = Math.floor(totalMin / 60);
  const m = Math.abs(totalMin % 60);
  return `${h}h${m.toString().padStart(2, '0')}`;
}

function formatCellValue(value: number, metric: AxisMetricId): string {
  if (!Number.isFinite(value)) return '--';
  const unit = unitForMetric(metric);
  let txt: string;
  if (Math.abs(value) >= 100) txt = String(Math.round(value));
  else if (Math.abs(value) >= 10) txt = value.toFixed(1);
  else txt = value.toFixed(2).replace(/\.?0+$/u, '');
  return unit ? `${txt}${unit === '°C' ? '°' : unit}` : txt;
}
