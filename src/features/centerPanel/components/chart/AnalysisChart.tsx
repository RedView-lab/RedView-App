import { Fragment, useEffect, useMemo, useRef, useState, type CSSProperties } from 'react';
import { IconPlusCircle, IconTrash } from '@/features/controlPanel/icons';
import { IconChevronDown, IconMoon, IconSun } from '../CenterPanelIcons';
import { PoiBadge } from '@/features/itineraryPanel/sections/timeline/KindBadge';
import type { ChartPoiAnnotation } from './annotations/buildPoiAnnotations';
import type { ChartDayNightOverlay } from './dayNight';
import { useChartHover } from './useChartHover';
import {
  computeDomain,
  computeXDomain,
  formatAxisValue,
  isInclinationMetric,
  metricIsAvailable,
  unitForMetric,
  type AxisDomain,
  type AxisMetricId,
  type ChartMetricId,
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
  poiAnnotations?: ChartPoiAnnotation[];
  dayNightOverlay?: ChartDayNightOverlay | null;
  axis1Metric: AxisMetricId;
  axis2Metric: AxisMetricId;
  xMode: AxisMode;
  detailZoom: number;
  detailOffset: number;
  onDetailOffsetChange?: (value: number) => void;
  showSeriesRows?: boolean;
}

export function AnalysisChart({
  series,
  backdropProfiles = [],
  poiAnnotations = [],
  dayNightOverlay = null,
  axis1Metric,
  axis2Metric,
  xMode,
  detailZoom,
  detailOffset,
  onDetailOffsetChange,
  showSeriesRows = true,
}: AnalysisChartProps) {
  const { ref: plotAreaRef, hover } = useChartHover<HTMLDivElement>();
  const seriesCanvasRef = useRef<HTMLCanvasElement>(null);
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

    // Coalesce ResizeObserver bursts (panel drag, exporter height changes,
    // window resize) into a single RAF-batched update so we don't recompute
    // 20+ axis/tick useMemos on every intermediate pixel.
    let rafId = 0;
    let pendingW = 0;
    let pendingH = 0;
    const ro = new ResizeObserver((entries) => {
      const cr = entries[0]?.contentRect;
      if (!cr) return;
      pendingW = cr.width;
      pendingH = cr.height;
      if (rafId !== 0) return;
      rafId = window.requestAnimationFrame(() => {
        rafId = 0;
        update(pendingW, pendingH);
      });
    });

    ro.observe(node);
    return () => {
      ro.disconnect();
      if (rafId !== 0) window.cancelAnimationFrame(rafId);
    };
  }, [plotAreaRef]);

  const xDomain = useMemo<AxisDomain>(() => {
    const dom = computeXDomain(series.map((entry) => entry.points), xMode);
    if (dom) return dom;
    if (xMode === 'distance') return { min: 0, max: 90 };
    if (xMode === 'heure') return { min: 0, max: 24 };
    return { min: 0, max: 6 };
  }, [series, xMode]);

  const visibleFraction = useMemo(
    () => detailZoomToVisibleFraction(normalizeUnitInterval(detailZoom)),
    [detailZoom],
  );

  const normalizedDetailOffset = useMemo(
    () => normalizeUnitInterval(detailOffset),
    [detailOffset],
  );

  const plotXDomain = useMemo(
    () => buildVisibleXDomain(xDomain, visibleFraction, normalizedDetailOffset),
    [normalizedDetailOffset, visibleFraction, xDomain],
  );

  const xTicks = useMemo(() => {
    const target = Math.max(2, Math.round(plotSize.width / X_MAJOR_TARGET_PX));
    return buildNiceTicks(plotXDomain.min, plotXDomain.max, target || DEFAULT_TICK_COUNT);
  }, [plotSize.width, plotXDomain.max, plotXDomain.min]);

  const displaySeries = series;

  const visibleSeries = useMemo(
    () =>
      displaySeries.map((entry) => ({
        ...entry,
        points: clipPointsToXDomain(entry.points, plotXDomain),
      })),
    [displaySeries, plotXDomain],
  );

  const axis1Series = useMemo(() => series.filter((entry) => entry.axis === 1), [series]);
  const axis2Series = useMemo(() => series.filter((entry) => entry.axis === 2), [series]);

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

  const xAxisLabels = useMemo(
    () => buildResponsiveXAxisLabels(xPositions, xMode, plotSize.width),
    [plotSize.width, xMode, xPositions],
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

  const backdropSeries = useMemo(() => {
    if (!backdropYDomain) return [];
    return backdropProfiles.map((profile) => {
      const visiblePoints = compressPointsForPlot(
        clipPointsToXDomain(profile.points, plotXDomain),
        plotXDomain,
        plotSize.width,
      );
      return {
        id: profile.id,
        points: visiblePoints,
      };
    });
  }, [backdropProfiles, backdropYDomain, plotSize.width, plotXDomain]);

  const visiblePoiAnnotations = useMemo(() => {
    if (!backdropYDomain || poiAnnotations.length === 0) return [];

    return poiAnnotations
      .filter((annotation) => annotation.x >= plotXDomain.min && annotation.x <= plotXDomain.max)
      .map((annotation) => ({
        ...annotation,
        xRatio: ratioFor(annotation.x, plotXDomain),
        yRatio: 1 - ratioFor(annotation.y, backdropYDomain),
      }));
  }, [backdropYDomain, plotXDomain, poiAnnotations]);

  const dayNightBands = useMemo(
    () =>
      (dayNightOverlay?.dayWindows ?? [])
        .map((window) => ({
          id: window.id,
          startRatio: ratioFor(window.startX, plotXDomain),
          endRatio: ratioFor(window.endX, plotXDomain),
        }))
        .filter((window) => window.endRatio - window.startRatio > 1e-4),
    [dayNightOverlay, plotXDomain],
  );

  const nightFrames = useMemo(() => {
    if (dayNightBands.length === 0) return [];

    const frames: Array<{ id: string; startRatio: number; endRatio: number }> = [];
    let cursor = 0;
    for (const band of dayNightBands) {
      if (band.startRatio - cursor > 1e-4) {
        frames.push({
          id: `night-${frames.length + 1}`,
          startRatio: cursor,
          endRatio: band.startRatio,
        });
      }
      cursor = Math.max(cursor, band.endRatio);
    }
    if (1 - cursor > 1e-4) {
      frames.push({ id: `night-${frames.length + 1}`, startRatio: cursor, endRatio: 1 });
    }
    return frames.filter((frame) => frame.endRatio - frame.startRatio > 0.06);
  }, [dayNightBands]);

  const seriesLayers = useMemo(
    () =>
      visibleSeries.map((entry) => ({
        id: entry.id,
        color: entry.color,
        lineWidth: 1.4,
        points: compressPointsForPlot(entry.points, plotXDomain, plotSize.width),
        yDomain: entry.axis === 2 ? plotY2Domain : plotYDomain,
      })),
    [plotSize.width, plotXDomain, plotY2Domain, plotYDomain, visibleSeries],
  );

  useEffect(() => {
    drawAnalysisChartCanvas(seriesCanvasRef.current, {
      width: plotSize.width,
      height: plotSize.height,
      xDomain: plotXDomain,
      backdropYDomain,
      backdropSeries,
      seriesLayers,
    });
  }, [backdropSeries, backdropYDomain, plotSize.height, plotSize.width, plotXDomain, seriesLayers]);

  const hoverData = useMemo(() => {
    if (!hover || !visibleSeries.length) return null;
    const hoveredX = plotXDomain.min + hover.ratioX * (plotXDomain.max - plotXDomain.min);
    return visibleSeries.map((entry) => ({
      id: entry.id,
      itineraryName: entry.itineraryName,
      color: entry.color,
      axis: entry.axis,
      metric: entry.metricId,
      value: interpolateY(entry.points, hoveredX),
    }));
  }, [hover, plotXDomain, visibleSeries]);

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
            {dayNightBands.map(({ id, startRatio, endRatio }) => (
              <div
                key={id}
                className="rvchart__day-night-band"
                style={{
                  left: `${startRatio * 100}%`,
                  width: `${(endRatio - startRatio) * 100}%`,
                }}
              />
            ))}
            {dayNightBands.map(({ id, startRatio, endRatio }) =>
              endRatio - startRatio > 0.06 ? (
                <div
                  key={`${id}-sun`}
                  className="rvchart__day-night-corner-icon rvchart__day-night-corner-icon--sun"
                  style={{ left: `calc(${startRatio * 100}% + 6px)` }}
                >
                  <IconSun size={16} />
                </div>
              ) : null,
            )}
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
            {nightFrames.map(({ id, startRatio }) => (
              <div
                key={id}
                className="rvchart__day-night-corner-icon rvchart__day-night-corner-icon--moon"
                style={{ left: `calc(${startRatio * 100}% + 6px)` }}
              >
                <IconMoon size={16} />
              </div>
            ))}
          </div>

          <canvas
            ref={seriesCanvasRef}
            className="rvchart__layer rvchart__layer--series"
            aria-hidden="true"
          />

          <div className="rvchart__layer rvchart__layer--markers" aria-hidden="true">
            {visiblePoiAnnotations.map((annotation) => (
              <div
                key={annotation.id}
                className="rvchart__poi-marker"
                style={{
                  left: `${annotation.xRatio * 100}%`,
                  top: `${annotation.yRatio * 100}%`,
                }}
                title={`${annotation.itineraryName} · ${annotation.categoryLabel} · ${annotation.label}`}
              >
                {annotation.poiCategory ? (
                  <PoiBadge category={annotation.poiCategory} size={22} />
                ) : (
                  <span className="rvchart__poi-marker-fallback">POI</span>
                )}
              </div>
            ))}
          </div>

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
          {xAxisLabels.map(({ value, ratio, label }) => (
            <div
              key={`xa-${value}-${ratio.toFixed(4)}`}
              className="rvchart__xaxis-cell"
              style={{
                left: `${ratio * 100}%`,
                transform: xAnchorTransformFor(ratio),
              }}
            >
              {label}
            </div>
          ))}
        </div>
        <div />
      </div>

      <div className="rvchart__viewport" aria-label="Déplacement horizontal du graphique">
        <div />
        <div className="rvchart__viewport-track">
          <div
            className="rvchart__viewport-window"
            style={{
              width: `${visibleFraction * 100}%`,
              left: `${normalizedDetailOffset * (1 - visibleFraction) * 100}%`,
            }}
          />
          <input
            className="rvchart__viewport-input"
            type="range"
            min="0"
            max="1000"
            step="1"
            value={Math.round(normalizedDetailOffset * 1000)}
            onChange={(event) => onDetailOffsetChange?.(Number(event.target.value) / 1000)}
            disabled={visibleFraction >= 0.999}
            aria-label="Déplacer la zone visible du graphique"
          />
        </div>
        <div />
      </div>

      {showSeriesRows
        ? visibleSeries.length === 0
          ? <EmptySeriesRow axis1={axis1Metric} axis2={axis2Metric} />
          : visibleSeries.map((entry) => (
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

interface CanvasBackdropLayer {
  id: string;
  points: { x: number; y: number }[];
}

interface CanvasSeriesLayer {
  id: string;
  color: string;
  lineWidth: number;
  points: { x: number; y: number }[];
  yDomain: AxisDomain;
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
            style={{
              left: `${ratio * 100}%`,
              transform: xAnchorTransformFor(ratio),
            }}
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
    metric: ChartMetricId;
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
                <div>{formatXAxisValue(xValue, xMode)}</div>
              </div>
            </div>
          </section>
        </Fragment>
      ))}
    </div>
  );
}

function defaultDomainFor(metric: ChartMetricId): AxisDomain {
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

function normalizeMetricDomain(metric: ChartMetricId, domain: AxisDomain): AxisDomain {
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

function clipPointsToXDomain(
  points: { x: number; y: number }[],
  xDomain: AxisDomain,
): { x: number; y: number }[] {
  if (points.length === 0) return [];

  const firstX = points[0]?.x ?? 0;
  const lastX = points[points.length - 1]?.x ?? 0;
  const clipped = points
    .filter((point) => point.x >= xDomain.min && point.x <= xDomain.max)
    .map((point) => ({ ...point }));

  if (xDomain.min >= firstX && xDomain.min <= lastX) {
    clipped.push({ x: xDomain.min, y: interpolateY(points, xDomain.min) });
  }
  if (xDomain.max >= firstX && xDomain.max <= lastX) {
    clipped.push({ x: xDomain.max, y: interpolateY(points, xDomain.max) });
  }

  clipped.sort((left, right) => left.x - right.x);

  const deduped: { x: number; y: number }[] = [];
  for (const point of clipped) {
    const prev = deduped[deduped.length - 1];
    if (prev && Math.abs(prev.x - point.x) < 1e-6) {
      deduped[deduped.length - 1] = point;
      continue;
    }
    deduped.push(point);
  }

  return deduped;
}

function compressPointsForPlot(
  points: { x: number; y: number }[],
  xDomain: AxisDomain,
  plotWidth: number,
): { x: number; y: number }[] {
  const bucketCount = Math.max(32, Math.round(plotWidth * 1.5));
  const span = xDomain.max - xDomain.min;
  if (points.length <= bucketCount * 2 || span <= 0 || plotWidth <= 0) return points;

  const compressed: { x: number; y: number }[] = [];
  let activeBucket = -1;
  let bucketPoints: { x: number; y: number }[] = [];

  const pushPoint = (point: { x: number; y: number }) => {
    const previous = compressed[compressed.length - 1];
    if (previous && Math.abs(previous.x - point.x) < 1e-6 && Math.abs(previous.y - point.y) < 1e-6) {
      return;
    }
    compressed.push(point);
  };

  const flushBucket = () => {
    if (bucketPoints.length === 0) return;

    let minPoint = bucketPoints[0];
    let maxPoint = bucketPoints[0];
    for (const point of bucketPoints) {
      if (point.y < minPoint.y) minPoint = point;
      if (point.y > maxPoint.y) maxPoint = point;
    }

    const ordered = [bucketPoints[0], minPoint, maxPoint, bucketPoints[bucketPoints.length - 1]]
      .filter((point, index, arr) => arr.indexOf(point) === index)
      .sort((left, right) => left.x - right.x);

    for (const point of ordered) pushPoint(point);
    bucketPoints = [];
  };

  for (const point of points) {
    const ratio = (point.x - xDomain.min) / span;
    const nextBucket = clamp(Math.floor(ratio * bucketCount), 0, bucketCount - 1);
    if (nextBucket !== activeBucket) {
      flushBucket();
      activeBucket = nextBucket;
    }
    bucketPoints.push(point);
  }

  flushBucket();
  return compressed;
}

function ratioFor(value: number, domain: AxisDomain): number {
  const span = domain.max - domain.min;
  if (span <= 0) return 0;
  return Math.max(0, Math.min(1, (value - domain.min) / span));
}

function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value));
}

function normalizeUnitInterval(value: number): number {
  if (!Number.isFinite(value)) return 0;
  return clamp(value, 0, 1);
}

function detailZoomToVisibleFraction(detailZoom: number): number {
  return 1 - normalizeUnitInterval(detailZoom) * (1 - MIN_VISIBLE_FRACTION);
}

function buildVisibleXDomain(
  xDomain: AxisDomain,
  visibleFraction: number,
  detailOffset: number,
): AxisDomain {
  const span = xDomain.max - xDomain.min;
  if (span <= 0) return xDomain;

  const visibleSpan = span * clamp(visibleFraction, MIN_VISIBLE_FRACTION, 1);
  const remainingSpan = Math.max(0, span - visibleSpan);
  const start = xDomain.min + remainingSpan * normalizeUnitInterval(detailOffset);
  return {
    min: start,
    max: start + visibleSpan,
  };
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

function drawAnalysisChartCanvas(
  canvas: HTMLCanvasElement | null,
  input: {
    width: number;
    height: number;
    xDomain: AxisDomain;
    backdropYDomain: AxisDomain | null;
    backdropSeries: CanvasBackdropLayer[];
    seriesLayers: CanvasSeriesLayer[];
  },
) {
  const ctx = prepareCanvas2d(canvas, input.width, input.height);
  if (!ctx) return;

  if (input.backdropYDomain) {
    for (const layer of input.backdropSeries) {
      drawCanvasArea(ctx, layer.points, input.xDomain, input.backdropYDomain, 'rgba(245, 248, 252, 0.08)');
    }
    for (const layer of input.backdropSeries) {
      drawCanvasLine(ctx, layer.points, input.xDomain, input.backdropYDomain, 'rgba(245, 248, 252, 0.4)', 1.15);
    }
  }

  for (const layer of input.seriesLayers) {
    drawCanvasLine(ctx, layer.points, input.xDomain, layer.yDomain, layer.color, layer.lineWidth);
  }
}

function prepareCanvas2d(canvas: HTMLCanvasElement | null, width: number, height: number) {
  if (!canvas) return null;

  const cssWidth = Math.max(0, width);
  const cssHeight = Math.max(0, height);
  const dpr = window.devicePixelRatio || 1;

  canvas.style.width = `${cssWidth}px`;
  canvas.style.height = `${cssHeight}px`;
  canvas.width = Math.max(1, Math.round(cssWidth * dpr));
  canvas.height = Math.max(1, Math.round(cssHeight * dpr));

  const ctx = canvas.getContext('2d');
  if (!ctx) return null;

  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.clearRect(0, 0, cssWidth, cssHeight);
  return ctx;
}

function drawCanvasLine(
  ctx: CanvasRenderingContext2D,
  points: { x: number; y: number }[],
  xDomain: AxisDomain,
  yDomain: AxisDomain,
  color: string,
  lineWidth: number,
) {
  if (points.length < 2) return;

  const width = Number(ctx.canvas.style.width.replace('px', '')) || ctx.canvas.width;
  const height = Number(ctx.canvas.style.height.replace('px', '')) || ctx.canvas.height;

  ctx.save();
  ctx.beginPath();
  points.forEach((point, index) => {
    const x = ratioFor(point.x, xDomain) * width;
    const y = (1 - ratioFor(point.y, yDomain)) * height;
    if (index === 0) ctx.moveTo(x, y);
    else ctx.lineTo(x, y);
  });
  ctx.strokeStyle = color;
  ctx.lineWidth = lineWidth;
  ctx.lineJoin = 'round';
  ctx.lineCap = 'round';
  ctx.stroke();
  ctx.restore();
}

function drawCanvasArea(
  ctx: CanvasRenderingContext2D,
  points: { x: number; y: number }[],
  xDomain: AxisDomain,
  yDomain: AxisDomain,
  fill: string,
) {
  if (points.length < 2) return;

  const width = Number(ctx.canvas.style.width.replace('px', '')) || ctx.canvas.width;
  const height = Number(ctx.canvas.style.height.replace('px', '')) || ctx.canvas.height;

  ctx.save();
  ctx.beginPath();
  points.forEach((point, index) => {
    const x = ratioFor(point.x, xDomain) * width;
    const y = (1 - ratioFor(point.y, yDomain)) * height;
    if (index === 0) ctx.moveTo(x, y);
    else ctx.lineTo(x, y);
  });
  const lastX = ratioFor(points[points.length - 1]?.x ?? xDomain.min, xDomain) * width;
  const firstX = ratioFor(points[0]?.x ?? xDomain.min, xDomain) * width;
  ctx.lineTo(lastX, height);
  ctx.lineTo(firstX, height);
  ctx.closePath();
  ctx.fillStyle = fill;
  ctx.fill();
  ctx.restore();
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

function buildResponsiveXAxisLabels(
  positions: Array<{ value: number; ratio: number }>,
  xMode: AxisMode,
  plotWidth: number,
): Array<{ value: number; ratio: number; label: string }> {
  if (positions.length === 0) return [];

  const density = chooseXAxisLabelDensity(positions, plotWidth);
  const candidates = positions.map((position) => ({
    ...position,
    label: formatXTick(position.value, xMode, density),
  }));

  if (candidates.length <= 2 || plotWidth <= 0) return candidates;

  const estimatedLabelWidths = candidates.map((position) =>
    estimateXAxisLabelWidth(position.label, xMode),
  );

  const accepted: Array<{ value: number; ratio: number; label: string }> = [];
  let lastRight = -Infinity;

  for (let index = 0; index < candidates.length; index += 1) {
    const position = candidates[index];
    const isFirst = index === 0;
    const isLast = index === candidates.length - 1;
    const width = estimatedLabelWidths[index] ?? 0;
    const center = position.ratio * plotWidth;
    const left = isFirst ? center : center - width / 2;
    const right = isLast ? center : center + width / 2;
    const minGap = isFirst || isLast ? 6 : 10;

    if (!isFirst && left < lastRight + minGap && !isLast) continue;

    accepted.push(position);
    lastRight = right;
  }

  const first = candidates[0];
  const last = candidates[candidates.length - 1];
  if (accepted[0] !== first) accepted.unshift(first);
  if (accepted[accepted.length - 1] !== last) {
    const prev = accepted[accepted.length - 1];
    const lastWidth = estimatedLabelWidths[estimatedLabelWidths.length - 1] ?? 0;
    const lastLeft = last.ratio * plotWidth - lastWidth;
    const prevCenter = prev.ratio * plotWidth;
    if (lastLeft < prevCenter + 10 && accepted.length > 1) {
      accepted.splice(accepted.length - 1, 1, last);
    } else {
      accepted.push(last);
    }
  }

  return accepted;
}

function chooseXAxisLabelDensity(
  positions: Array<{ value: number; ratio: number }>,
  plotWidth: number,
): 'full' | 'compact' | 'tight' {
  if (positions.length <= 1 || plotWidth <= 0) return 'full';

  let minSpacingPx = Infinity;
  for (let index = 1; index < positions.length; index += 1) {
    const spacingPx = (positions[index].ratio - positions[index - 1].ratio) * plotWidth;
    if (spacingPx > 0) minSpacingPx = Math.min(minSpacingPx, spacingPx);
  }

  if (!Number.isFinite(minSpacingPx)) return 'full';
  if (minSpacingPx < 42) return 'tight';
  if (minSpacingPx < 68) return 'compact';
  return 'full';
}

function estimateXAxisLabelWidth(label: string, xMode: AxisMode): number {
  const charWidth = xMode === 'distance' ? 6.8 : 7.2;
  const basePadding = 14;
  return Math.max(26, Math.ceil(label.length * charWidth + basePadding));
}

function formatAxisLabel(value: number, metric: ChartMetricId): string {
  if (!Number.isFinite(value)) return '--';
  let txt: string;
  if (Number.isInteger(value)) txt = String(value);
  else if (Math.abs(value) >= 100) txt = String(Math.round(value));
  else if (Math.abs(value) >= 10) txt = value.toFixed(1);
  else txt = Number(value.toFixed(2)).toString();
  const unit = unitForMetric(metric);
  return unit ? `${txt}${unit}` : txt;
}

function formatXTick(
  value: number,
  xMode: AxisMode,
  density: 'full' | 'compact' | 'tight' = 'full',
): string {
  if (xMode === 'distance') {
    return formatDistanceTick(value, density);
  }
  if (xMode === 'heure') return formatClockHours(value, density);
  return formatHours(value, density);
}

function formatXAxisValue(value: number, xMode: AxisMode): string {
  if (xMode === 'distance') return `${value.toFixed(1)} km`;
  if (xMode === 'heure') return formatClockHours(value);
  return formatHours(value);
}

function xAnchorTransformFor(ratio: number): string {
  if (ratio <= 0.02) return 'translateX(0%)';
  if (ratio >= 0.98) return 'translateX(-100%)';
  return 'translateX(-50%)';
}

function formatDistanceTick(
  value: number,
  density: 'full' | 'compact' | 'tight',
): string {
  if (!Number.isFinite(value)) return '--';
  if (density === 'tight') return `${Math.round(value)}`;
  if (density === 'compact') return Number(value.toFixed(0)).toString();
  if (Number.isInteger(value)) return String(value);
  return value.toFixed(1);
}

function formatHours(
  hours: number,
  density: 'full' | 'compact' | 'tight' = 'full',
): string {
  if (!Number.isFinite(hours)) return '--';
  const totalMin = Math.round(hours * 60);
  const h = Math.floor(totalMin / 60);
  const m = Math.abs(totalMin % 60);
  if (density === 'tight') return `${h}h`;
  if (density === 'compact' && m === 0) return `${h}h`;
  return `${h}h${m.toString().padStart(2, '0')}`;
}

function formatClockHours(
  hours: number,
  density: 'full' | 'compact' | 'tight' = 'full',
): string {
  if (!Number.isFinite(hours)) return '--:--';
  const totalMinutes = Math.round(hours * 60);
  const dayOffset = Math.floor(totalMinutes / 1440);
  const minutesInDay = ((totalMinutes % 1440) + 1440) % 1440;
  const hh = String(Math.floor(minutesInDay / 60)).padStart(2, '0');
  const mm = String(minutesInDay % 60).padStart(2, '0');
  const prefix = dayOffset > 0 ? `J+${dayOffset} ` : '';
  if (density === 'tight') return `${prefix}${hh}`;
  if (density === 'compact') return `${prefix}${hh}h`;
  return `${prefix}${hh}:${mm}`;
}

function formatCellValue(value: number, metric: ChartMetricId): string {
  if (!Number.isFinite(value)) return '--';
  const unit = unitForMetric(metric);
  let txt: string;
  if (Math.abs(value) >= 100) txt = String(Math.round(value));
  else if (Math.abs(value) >= 10) txt = value.toFixed(1);
  else txt = value.toFixed(2).replace(/\.?0+$/u, '');
  return unit ? `${txt}${unit}` : txt;
}

const MIN_VISIBLE_FRACTION = 0.12;
