import { Fragment, useEffect, useMemo, useState, type CSSProperties } from 'react';
import { IconPlusCircle, IconTrash } from '@/features/controlPanel/icons';
import { IconChevronDown } from '../CenterPanelIcons';
import { useChartHover } from './useChartHover';
import {
  computeDomain,
  computeXDomain,
  formatAxisValue,
  isInclinationMetric,
  isIntervalAverageMetric,
  metricIsAvailable,
  unitForMetric,
  type AxisDomain,
  type AxisMetricId,
  type AxisMode,
  type ChartBackdropProfile,
  type ChartSeries,
} from './series';
import './chart.css';

const Y_MAJOR_TARGET_PX = 26;
const X_MAJOR_TARGET_PX = 80;
const DEFAULT_TICK_COUNT = 6;

interface AnalysisChartProps {
  series: ChartSeries[];
  backdropProfiles?: ChartBackdropProfile[];
  axis1Metric: AxisMetricId;
  axis2Metric: AxisMetricId;
  xMode: AxisMode;
  showSeriesRows?: boolean;
}

export function AnalysisChart({
  series,
  backdropProfiles = [],
  axis1Metric,
  axis2Metric,
  xMode,
  showSeriesRows = true,
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

  const xDomain = useMemo<AxisDomain>(() => {
    const dom = computeXDomain(series.map((entry) => entry.points));
    if (dom) return dom;
    return xMode === 'distance' ? { min: 0, max: 90 } : { min: 0, max: 6 };
  }, [series, xMode]);

  const xTicks = useMemo(() => {
    const target = Math.max(2, Math.round(plotSize.width / X_MAJOR_TARGET_PX));
    return buildNiceTicks(xDomain.min, xDomain.max, target || DEFAULT_TICK_COUNT);
  }, [plotSize.width, xDomain.max, xDomain.min]);

  const plotXDomain = useMemo<AxisDomain>(() => {
    if (xTicks.length === 0) return xDomain;
    return {
      min: xTicks[0] ?? xDomain.min,
      max: xTicks[xTicks.length - 1] ?? xDomain.max,
    };
  }, [xDomain, xTicks]);

  const displaySeries = useMemo(
    () => series.map((entry) => materializeSeriesForPlot(entry, xTicks)),
    [series, xTicks],
  );

  const axis1Series = useMemo(
    () => displaySeries.filter((entry) => entry.axis === 1),
    [displaySeries],
  );
  const axis2Series = useMemo(
    () => displaySeries.filter((entry) => entry.axis === 2),
    [displaySeries],
  );

  const yDomain = useMemo<AxisDomain>(() => {
    const dom = computeDomain(axis1Series.map((entry) => entry.points));
    return dom ? normalizeMetricDomain(axis1Metric, dom) : defaultDomainFor(axis1Metric);
  }, [axis1Metric, axis1Series]);

  const y2Domain = useMemo<AxisDomain>(() => {
    const dom = computeDomain(axis2Series.map((entry) => entry.points));
    return dom ? normalizeMetricDomain(axis2Metric, dom) : defaultDomainFor(axis2Metric);
  }, [axis2Metric, axis2Series]);

  const yTicksAsc = useMemo(() => {
    const target =
      plotSize.height > 0
        ? Math.max(2, Math.round(plotSize.height / Y_MAJOR_TARGET_PX))
        : DEFAULT_TICK_COUNT;
    return buildNiceTicks(yDomain.min, yDomain.max, target);
  }, [plotSize.height, yDomain.max, yDomain.min]);

  const yTicks = useMemo(() => yTicksAsc.slice().reverse(), [yTicksAsc]);

  const plotYDomain = useMemo<AxisDomain>(() => {
    if (yTicksAsc.length === 0) return yDomain;
    return {
      min: yTicksAsc[0] ?? yDomain.min,
      max: yTicksAsc[yTicksAsc.length - 1] ?? yDomain.max,
    };
  }, [yDomain, yTicksAsc]);

  const y2Ticks = useMemo(
    () => buildInterpolatedTicks(y2Domain.max, y2Domain.min, yTicks.length),
    [y2Domain.max, y2Domain.min, yTicks.length],
  );

  const plotY2Domain = useMemo<AxisDomain>(() => {
    if (y2Ticks.length === 0) return y2Domain;
    return {
      min: y2Ticks[y2Ticks.length - 1] ?? y2Domain.min,
      max: y2Ticks[0] ?? y2Domain.max,
    };
  }, [y2Domain, y2Ticks]);

  const xPositions = useMemo(
    () =>
      xTicks.map((value) => ({
        value,
        ratio: ratioFor(value, plotXDomain),
      })),
    [plotXDomain, xTicks],
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

  const backdropYDomain = useMemo<AxisDomain | null>(
    () => computeDomain(backdropProfiles.map((profile) => profile.points)),
    [backdropProfiles],
  );

  const backdropPaths = useMemo(() => {
    if (!backdropYDomain) return [];
    return backdropProfiles.map((profile) => ({
      id: profile.id,
      fillPath: buildAreaPath(profile.points, plotXDomain, backdropYDomain),
      strokePath: buildSvgPath(profile.points, plotXDomain, backdropYDomain),
    }));
  }, [backdropProfiles, backdropYDomain, plotXDomain]);

  const seriesPaths = useMemo(
    () =>
      displaySeries.map((entry) => ({
        id: entry.id,
        color: entry.color,
        path: buildSvgPath(
          entry.points,
          plotXDomain,
          entry.axis === 2 ? plotY2Domain : plotYDomain,
        ),
      })),
    [displaySeries, plotXDomain, plotY2Domain, plotYDomain],
  );

  const hoverData = useMemo(() => {
    if (!hover || !displaySeries.length) return null;
    const hoveredX = plotXDomain.min + hover.ratioX * (plotXDomain.max - plotXDomain.min);
    return displaySeries.map((entry) => ({
      id: entry.id,
      itineraryName: entry.itineraryName,
      color: entry.color,
      axis: entry.axis,
      metric: entry.metricId,
      value: interpolateY(entry.points, hoveredX),
    }));
  }, [displaySeries, hover, plotXDomain]);

  return (
    <div className="rvchart" style={style}>
      <div className="rvchart__plot">
        <div className="rvchart__yaxis-left" aria-hidden="true">
          {yTicks.map((value, index) => (
            <span key={`yl-${index}-${value}`}>{formatAxisLabel(value, axis1Metric)}</span>
          ))}
        </div>

        <div ref={plotAreaRef} className="rvchart__plotarea">
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

          <svg
            className="rvchart__layer rvchart__layer--series"
            viewBox="0 0 100 100"
            preserveAspectRatio="none"
            overflow="hidden"
            aria-hidden="true"
          >
            {backdropPaths.map((entry) =>
              entry.fillPath ? (
                <path key={`${entry.id}-fill`} d={entry.fillPath} className="rvchart__backdrop-fill" />
              ) : null,
            )}
            {backdropPaths.map((entry) =>
              entry.strokePath ? (
                <path key={`${entry.id}-stroke`} d={entry.strokePath} className="rvchart__backdrop-stroke" />
              ) : null,
            )}
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

          <div className="rvchart__layer rvchart__layer--overlay" aria-hidden="true">
            {hover ? (
              <>
                <div className="rvchart__cursor" style={{ left: `${hover.x}px` }} />
                <HoverCardGroup
                  hoverX={hover.x}
                  hoverRatioX={hover.ratioX}
                  xValue={plotXDomain.min + hover.ratioX * (plotXDomain.max - plotXDomain.min)}
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

      {showSeriesRows
        ? displaySeries.length === 0
          ? <EmptySeriesRow axis1={axis1Metric} axis2={axis2Metric} />
          : displaySeries.map((entry) => (
              <SeriesRow key={entry.id} seriesEntry={entry} xPositions={xPositions} />
            ))
        : null}

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

function defaultDomainFor(metric: AxisMetricId): AxisDomain {
  switch (metric) {
    case 'Vitesse':
    case 'Vitesse moyenne':
      return { min: 0, max: 50 };
    case 'Puissance':
    case 'Puissance moyenne':
      return { min: 0, max: 400 };
    case 'Altitude':
      return { min: 0, max: 3000 };
    case 'Inclinaison (°)':
      return { min: -90, max: 90 };
    case 'Inclinaison (%)':
      return { min: -100, max: 100 };
    default:
      return { min: 0, max: 100 };
  }
}

function normalizeMetricDomain(metric: AxisMetricId, domain: AxisDomain): AxisDomain {
  if (!isInclinationMetric(metric)) return domain;
  const min = Math.min(domain.min, 0);
  const max = Math.max(domain.max, 0);
  if (metric === 'Inclinaison (°)') {
    return {
      min: clamp(min, -90, 90),
      max: clamp(max, -90, 90),
    };
  }
  return { min, max };
}

function materializeSeriesForPlot(seriesEntry: ChartSeries, xTicks: number[]): ChartSeries {
  if (!isIntervalAverageMetric(seriesEntry.metricId)) return seriesEntry;
  return {
    ...seriesEntry,
    points: buildIntervalAverageSeries(seriesEntry.points, xTicks),
  };
}

function buildIntervalAverageSeries(
  points: { x: number; y: number }[],
  xTicks: number[],
): { x: number; y: number }[] {
  if (points.length < 2 || xTicks.length < 2) return points;

  const result: Array<{ x: number; y: number }> = [];
  for (let index = 0; index < xTicks.length - 1; index += 1) {
    const start = xTicks[index] ?? 0;
    const end = xTicks[index + 1] ?? start;
    if (!Number.isFinite(start) || !Number.isFinite(end) || end <= start) continue;
    const avg = averageSeriesOverInterval(points, start, end);
    if (!Number.isFinite(avg)) continue;

    if (result.length === 0) {
      result.push({ x: start, y: avg });
    } else {
      const prev = result[result.length - 1];
      if (Math.abs(prev.x - start) > 1e-6) {
        result.push({ x: start, y: prev.y });
      }
      if (Math.abs(prev.y - avg) > 1e-6) {
        result.push({ x: start, y: avg });
      }
    }

    result.push({ x: end, y: avg });
  }

  return result.length >= 2 ? result : points;
}

function averageSeriesOverInterval(
  points: { x: number; y: number }[],
  start: number,
  end: number,
): number {
  const span = end - start;
  if (span <= 0) return Number.NaN;

  const breakpoints = [start];
  for (const point of points) {
    if (point.x > start && point.x < end) breakpoints.push(point.x);
  }
  breakpoints.push(end);

  let integral = 0;
  let prevX = breakpoints[0] ?? start;
  let prevY = interpolateY(points, prevX);
  for (let index = 1; index < breakpoints.length; index += 1) {
    const currX = breakpoints[index] ?? prevX;
    const currY = interpolateY(points, currX);
    integral += ((prevY + currY) / 2) * (currX - prevX);
    prevX = currX;
    prevY = currY;
  }

  return integral / span;
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
  for (let index = 0; index < points.length; index += 1) {
    const point = points[index];
    const x = clamp(((point.x - xDomain.min) / xSpan) * 100, 0, 100);
    const y = clamp(100 - ((point.y - yDomain.min) / ySpan) * 100, 0, 100);
    if (!Number.isFinite(x) || !Number.isFinite(y)) continue;
    d += `${index === 0 ? 'M' : 'L'} ${x.toFixed(3)} ${y.toFixed(3)} `;
  }
  return d.trim();
}

function buildAreaPath(
  points: { x: number; y: number }[],
  xDomain: AxisDomain,
  yDomain: AxisDomain,
): string {
  const linePath = buildSvgPath(points, xDomain, yDomain);
  const xSpan = xDomain.max - xDomain.min;
  if (!linePath || points.length < 2 || xSpan <= 0) return '';
  const firstX = clamp(((points[0].x - xDomain.min) / xSpan) * 100, 0, 100);
  const lastX = clamp(((points[points.length - 1].x - xDomain.min) / xSpan) * 100, 0, 100);
  return `${linePath} L ${lastX.toFixed(3)} 100 L ${firstX.toFixed(3)} 100 Z`;
}

function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value));
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
  return unit ? `${txt}${unit}` : txt;
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
  return unit ? `${txt}${unit}` : txt;
}
