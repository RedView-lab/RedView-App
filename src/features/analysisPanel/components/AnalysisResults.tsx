import { useEffect, useMemo, useRef, useState, type CSSProperties } from 'react';
import { imgPlusCircle, imgIcon5, imgIcon6, imgIcon7 } from './assets';
import { AnalysisResultsGrid, type GridColumn } from './AnalysisResultsGrid';

export interface AnalysisChartPoint {
  x: number;
  y: number;
}

export interface AnalysisChartSeries {
  id: string;
  color: string;
  points: AnalysisChartPoint[];
  cellValues?: string[];
  fillColor?: string;
  strokeWidth?: number;
  opacity?: number;
}

export interface AnalysisDayWindow {
  id: string;
  startPercent: number;
  endPercent: number;
}

export interface AnalysisHoverSummary {
  seriesId: string;
  color: string;
  distanceLabel: string;
  ascentLabel: string;
  descentLabel: string;
  durationLabel: string;
  scheduleLabel: string;
}

export interface AnalysisCursor {
  xPercent: number;
  summaries: AnalysisHoverSummary[];
}

interface AnalysisResultsProps {
  series?: AnalysisChartSeries[];
  dayWindows?: AnalysisDayWindow[];
  cursor?: AnalysisCursor | null;
  /** Optional explicit X tick values (km). Disables auto-scaling when provided. */
  xAxisTicks?: number[];
  /** X axis numeric domain (km). */
  xDomain?: { min: number; max: number };
  /** Y axis numeric domain (m). */
  yDomain?: { min: number; max: number };
}

const DEFAULT_X_DOMAIN = { min: 0, max: 100 };
const DEFAULT_Y_DOMAIN = { min: 0, max: 3000 };
const DEFAULT_DAY_WINDOWS: AnalysisDayWindow[] = [
  { id: 'day-1', startPercent: 5.8, endPercent: 27.6 },
  { id: 'day-2', startPercent: 60.6, endPercent: 78.9 },
];

/** Target spacing (px) between successive major ticks on each axis. */
const X_MAJOR_TARGET_PX = 80;
const X_MINOR_TARGET_PX = 32;
const Y_MAJOR_TARGET_PX = 40;
const Y_MINOR_TARGET_PX = 18;
/** Width of the left-hand label gutter (must match grid label column). */
const LABEL_GUTTER_PX = 95;

const PLOT_Y_MIN = 0;
const PLOT_Y_MAX = 3000;
const FONT_OPSZ_STYLE: CSSProperties = { fontVariationSettings: "'opsz' 14" };

export function AnalysisResults({
  series = [],
  dayWindows = DEFAULT_DAY_WINDOWS,
  cursor = null,
  xAxisTicks,
  xDomain = DEFAULT_X_DOMAIN,
  yDomain = DEFAULT_Y_DOMAIN,
}: AnalysisResultsProps) {
  const plotSeries = series.filter((entry) => entry.points.length > 1);
  const hoverLeftPercent = cursor ? clamp(cursor.xPercent, 24, 76) : 50;

  const gridRef = useRef<HTMLDivElement>(null);
  const [gridSize, setGridSize] = useState({ width: 0, height: 0 });
  const totalChartWidth = Math.max(0, gridSize.width - LABEL_GUTTER_PX);

  useEffect(() => {
    const node = gridRef.current;
    if (!node) return;
    const ro = new ResizeObserver((entries) => {
      const cr = entries[0]?.contentRect;
      if (!cr) return;
      setGridSize((prev) => {
        if (Math.abs(prev.width - cr.width) < 0.5 && Math.abs(prev.height - cr.height) < 0.5) {
          return prev;
        }
        return { width: cr.width, height: cr.height };
      });
    });
    ro.observe(node);
    return () => ro.disconnect();
  }, []);

  const xMajorTicks = useMemo(() => {
    if (xAxisTicks && xAxisTicks.length > 0) {
      return [...xAxisTicks].sort((a, b) => a - b);
    }
    if (totalChartWidth <= 0) return buildNiceTicks(xDomain.min, xDomain.max, 4);
    const targetCount = Math.max(2, Math.round(totalChartWidth / X_MAJOR_TARGET_PX));
    return buildNiceTicks(xDomain.min, xDomain.max, targetCount);
  }, [xAxisTicks, totalChartWidth, xDomain.min, xDomain.max]);

  const provisionalColumns = useMemo(
    () => buildXColumns(xMajorTicks, totalChartWidth),
    [xMajorTicks, totalChartWidth],
  );

  const rightColumnWidth = useMemo(() => {
    if (totalChartWidth <= 0 || provisionalColumns.length === 0) return 48;
    return Math.max(48, totalChartWidth / provisionalColumns.length);
  }, [provisionalColumns.length, totalChartWidth]);

  const usableWidth = Math.max(0, totalChartWidth - rightColumnWidth);

  const xColumns = useMemo(
    () => buildXColumns(xMajorTicks, usableWidth),
    [xMajorTicks, usableWidth],
  );

  const yMajorTicks = useMemo(() => {
    const h = gridSize.height;
    if (h <= 0) return buildNiceTicks(yDomain.min, yDomain.max, 4).slice().reverse();
    const targetCount = Math.max(2, Math.round(h / Y_MAJOR_TARGET_PX));
    return buildNiceTicks(yDomain.min, yDomain.max, targetCount).slice().reverse();
  }, [gridSize.height, yDomain.min, yDomain.max]);

  const plotRows = useMemo(
    () => buildPlotRows(yMajorTicks, gridSize.height),
    [yMajorTicks, gridSize.height],
  );

  return (
    <div
      className="bg-[rgba(0,0,0,0.64)] content-stretch flex flex-[1_0_0] flex-col gap-[0.5px] items-start min-h-[148px] overflow-clip relative rounded-[5px] w-full"
      data-node-id="1894:39014"
      data-name="RESULTS"
    >
      <AnalysisResultsGrid
        ref={gridRef}
        columns={xColumns}
        plotRows={plotRows}
        rightColumnWidth={rightColumnWidth}
      >
        <div
          className="absolute inset-0 overflow-hidden pointer-events-none"
          data-node-id="1894:39015"
          data-name="PLOT"
        >
          {dayWindows.map((window) => (
            <div
              key={window.id}
              className="absolute inset-y-0 bg-[rgba(255,166,48,0.14)]"
              style={{
                left: `${clamp(window.startPercent, 0, 100)}%`,
                width: `${Math.max(0, window.endPercent - window.startPercent)}%`,
              }}
            />
          ))}

          <svg className="absolute inset-0 size-full" viewBox="0 0 100 100" preserveAspectRatio="none" aria-hidden="true">
            {plotSeries.map((entry) => {
              if (!entry.fillColor) return null;
              const areaPath = buildSeriesPath(entry.points, true);
              if (!areaPath) return null;
              return <path key={`${entry.id}-area`} d={areaPath} fill={entry.fillColor} opacity={entry.opacity ?? 1} />;
            })}

            {plotSeries.map((entry) => {
              const linePath = buildSeriesPath(entry.points, false);
              if (!linePath) return null;
              return (
                <path
                  key={entry.id}
                  d={linePath}
                  fill="none"
                  stroke={entry.color}
                  strokeWidth={entry.strokeWidth ?? 0.42}
                  strokeLinejoin="round"
                  strokeLinecap="round"
                  vectorEffect="non-scaling-stroke"
                  opacity={entry.opacity ?? 1}
                />
              );
            })}

            {cursor ? (
              <line
                x1={clamp(cursor.xPercent, 0, 100)}
                x2={clamp(cursor.xPercent, 0, 100)}
                y1="0"
                y2="100"
                stroke="rgba(255,255,255,0.96)"
                strokeWidth="0.22"
                vectorEffect="non-scaling-stroke"
              />
            ) : null}
          </svg>

          {dayWindows.map((window) => (
            <PhaseIcon
              key={`${window.id}-sun`}
              src={imgIcon6}
              name="sun"
              left={`calc(${clamp(window.startPercent, 0, 100)}% + 4px)`}
            />
          ))}

          {dayWindows.map((window) => (
            <PhaseIcon
              key={`${window.id}-moon`}
              src={imgIcon7}
              name="moon-01"
              left={`calc(${clamp(window.endPercent, 0, 100)}% - 12px)`}
            />
          ))}

          {cursor && cursor.summaries.length > 0 ? (
            <div
              className="absolute backdrop-blur-[60px] bg-[rgba(255,255,255,0.04)] content-stretch flex gap-[8px] items-start px-[4px] py-[8px] top-[24px]"
              style={{ left: `${hoverLeftPercent}%`, transform: 'translateX(-50%)' }}
            >
              {cursor.summaries.map((summary, index) => (
                <HoverSummaryCard key={summary.seriesId} summary={summary} showDivider={index > 0} />
              ))}
            </div>
          ) : null}
        </div>
      </AnalysisResultsGrid>
      <AxisRow columns={xColumns} rightColumnWidth={rightColumnWidth} />
      {series.map((s) => (
        <SeriesRow key={s.id} series={s} columns={xColumns} rightColumnWidth={rightColumnWidth} />
      ))}
      <AddLineRow columns={xColumns} rightColumnWidth={rightColumnWidth} />
    </div>
  );
}

function AxisRow({ columns, rightColumnWidth }: { columns: GridColumn[]; rightColumnWidth: number }) {
  const innerCols = columns.slice(0, -1);
  const lastCol = columns[columns.length - 1];

  return (
    <div
      className="border-[rgba(255,255,255,0.8)] border-b-[0.5px] border-solid border-t-[0.5px] content-stretch flex flex-[1_0_0] gap-[4px] items-center max-h-[24px] min-h-[16px] relative w-full"
      data-node-id="1894:39035"
      data-name="AXE HORYZONTAL"
    >
      <div className="content-stretch flex h-full items-center justify-end relative shrink-0 w-[91px]" data-node-id="1894:39036">
        <div
          className="flex flex-col font-['DM_Sans:SemiBold',sans-serif] font-semibold justify-center leading-[0] overflow-hidden relative shrink-0 text-[12px] text-ellipsis text-right text-white w-[40px] whitespace-nowrap"
          data-node-id="1894:39037"
          style={FONT_OPSZ_STYLE}
        >
          <p className="leading-[normal] overflow-hidden text-ellipsis"> </p>
        </div>
      </div>
      <div className="content-stretch flex flex-[1_0_0] h-full items-center min-w-px relative" data-node-id="1894:39038">
        {innerCols.map((col, index) => (
          <div
            key={`${index}-${col.value}`}
            className={
              index === 0
                ? 'border-[rgba(255,255,255,0.8)] border-l border-solid content-stretch flex flex-[1_0_0] h-full items-center min-w-px py-[2px] relative'
                : col.major
                  ? 'border-[rgba(255,255,255,0.32)] border-l-[0.5px] border-solid content-stretch flex flex-[1_0_0] h-full items-center min-w-px py-[2px] relative'
                  : 'border-[rgba(255,255,255,0.12)] border-l-[0.5px] border-dashed content-stretch flex flex-[1_0_0] h-full items-center min-w-px py-[2px] relative'
            }
          >
            {col.major && col.label ? (
              <div
                className="flex flex-col font-['DM_Sans:SemiBold',sans-serif] font-semibold justify-center leading-[0] overflow-hidden relative shrink-0 text-[12px] text-ellipsis text-white whitespace-nowrap pl-[4px]"
                style={FONT_OPSZ_STYLE}
              >
                <p className="leading-[normal] overflow-hidden text-ellipsis">{col.label}</p>
              </div>
            ) : null}
          </div>
        ))}
        <div
          className="bg-[rgba(0,0,0,0.64)] border-l border-solid border-white content-stretch flex h-full items-center justify-start px-[8px] py-[2px] relative shrink-0"
          style={{ width: `${rightColumnWidth}px` }}
        >
          {lastCol?.major && lastCol?.label ? (
             <div className="flex flex-col font-['DM_Sans:SemiBold',sans-serif] font-semibold justify-center leading-[0] overflow-hidden relative shrink-0 text-[12px] text-ellipsis text-white whitespace-nowrap pl-[4px]" style={FONT_OPSZ_STYLE}>
               <p className="leading-[normal] overflow-hidden text-ellipsis">{lastCol.label}</p>
             </div>
          ) : (
            <div className="flex flex-col font-['DM_Sans:SemiBold',sans-serif] font-semibold justify-center leading-[0] overflow-hidden relative shrink-0 text-[12px] text-ellipsis text-white w-[40px] whitespace-nowrap" style={FONT_OPSZ_STYLE}>
              <p className="leading-[normal] overflow-hidden text-ellipsis">{` `}</p>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

function AddLineRow({ columns, rightColumnWidth }: { columns: GridColumn[]; rightColumnWidth: number }) {
  const innerCols = columns.slice(0, -1);
  return (
    <div
      className="border-[rgba(255,255,255,0.08)] border-b-[0.5px] border-solid border-t-[0.5px] content-stretch flex flex-[1_0_0] gap-[4px] items-center max-h-[28px] min-h-[24px] relative w-full"
      data-node-id="1894:39064"
      data-name="ADDLINE"
    >
      <div className="bg-[rgba(255,255,255,0.08)] content-stretch flex gap-[4px] items-center pl-[6px] relative rounded-[4px] shrink-0 w-[91px]" data-node-id="1894:39065">
        <div className="relative shrink-0 size-[12px]" data-node-id="1894:39066" data-name="plus-circle">
          <img alt="" className="absolute block inset-0 max-w-none size-full" src={imgPlusCircle} />
        </div>
        <div className="flex flex-[1_0_0] flex-col font-['Rethink_Sans:Medium',sans-serif] font-medium justify-center leading-[0] min-w-px overflow-hidden relative text-[11px] text-ellipsis text-white whitespace-nowrap" data-node-id="1894:39068">
          <p className="leading-[normal] overflow-hidden text-ellipsis">Ajouter</p>
        </div>
        <div className="overflow-clip relative shrink-0 size-[20px]" data-node-id="1894:39069" data-name="chevron-down">
          <div className="absolute inset-[45%_36.67%_45%_38.33%]" data-node-id="I1894:39069;183:3259" data-name="Icon">
            <div className="absolute inset-[-41.67%_-16.67%]">
              <img alt="" className="block max-w-none size-full" src={imgIcon5} />
            </div>
          </div>
        </div>
      </div>
      <div className="content-stretch flex flex-[1_0_0] h-full items-center min-w-px relative" data-node-id="1894:39070">
        {innerCols.map((col, index) => (
          <div
            key={`${index}-${col.value}`}
            className={
              index === 0
                ? 'border-[rgba(255,255,255,0.8)] border-l border-solid content-stretch flex flex-[1_0_0] h-full items-center min-w-px relative'
                : col.major
                  ? 'border-[rgba(255,255,255,0.32)] border-l-[0.5px] border-solid content-stretch flex flex-[1_0_0] h-full items-center min-w-px relative'
                  : 'border-[rgba(255,255,255,0.12)] border-l-[0.5px] border-dashed content-stretch flex flex-[1_0_0] h-full items-center min-w-px relative'
            }
          />
        ))}
        <div
          className="bg-[rgba(0,0,0,0.64)] border-l border-solid border-[rgba(255,255,255,0.12)] content-stretch flex h-full items-center justify-end px-[8px] py-[2px] relative shrink-0"
          style={{ width: `${rightColumnWidth}px` }}
        >
          <div className="flex flex-col font-['DM_Sans:SemiBold',sans-serif] font-semibold justify-center leading-[0] overflow-hidden relative shrink-0 text-[12px] text-[rgba(255,255,255,0.64)] text-ellipsis w-[40px] whitespace-nowrap" style={FONT_OPSZ_STYLE}>
            <p className="leading-[normal] overflow-hidden text-ellipsis">{` `}</p>
          </div>
        </div>
      </div>
    </div>
  );
}

import { imgIcon1 } from './assets';

function SeriesRow({
  series,
  columns,
  rightColumnWidth,
}: {
  series: AnalysisChartSeries;
  columns: GridColumn[];
  rightColumnWidth: number;
}) {
  const innerCols = columns.slice(0, -1);
  let majorIndex = -1;
  return (
    <div className="border-[rgba(255,255,255,0.08)] border-b-[0.5px] border-solid border-t-[0.5px] content-stretch flex flex-[1_0_0] items-center max-h-[28px] min-h-[24px] relative w-full">
      <div className="bg-[rgba(0,0,0,0.64)] content-stretch flex flex-col h-full items-start justify-center px-[4px] relative shrink-0 w-[95px]">
        <div className="bg-[rgba(255,255,255,0.08)] content-stretch flex gap-[4px] items-center pl-[6px] relative rounded-[4px] shrink-0 w-[87px]">
          <div className="rounded-[2px] shrink-0 size-[12px]" style={{ backgroundColor: series.color }} />
          <div className="flex flex-[1_0_0] flex-col font-['Rethink_Sans:Medium',sans-serif] font-medium justify-center leading-[0] min-w-px overflow-hidden relative text-[11px] text-ellipsis text-white whitespace-nowrap">
            <p className="leading-[normal] overflow-hidden text-ellipsis">{series.id}</p>
          </div>
          <div className="overflow-clip relative shrink-0 size-[20px]">
            <div className="absolute inset-[45%_36.67%_45%_38.33%]">
              <div className="absolute inset-[-41.67%_-16.67%]">
                <img alt="" className="block max-w-none size-full" src={imgIcon5} />
              </div>
            </div>
          </div>
        </div>
      </div>
      <div className="content-stretch flex flex-[1_0_0] h-full items-center min-w-px relative">
        {innerCols.map((col, index) => (
          (() => {
            if (col.major) majorIndex += 1;
            const value = col.major ? series.cellValues?.[majorIndex] : undefined;
            return (
              <div
                key={`${index}-${col.value}`}
                className={
                  index === 0
                    ? 'border-[rgba(255,255,255,0.8)] border-l border-solid content-stretch flex flex-[1_0_0] h-full items-center min-w-px px-[8px] relative'
                    : col.major
                      ? 'border-[rgba(255,255,255,0.32)] border-l-[0.5px] border-solid content-stretch flex flex-[1_0_0] h-full items-center min-w-px px-[8px] relative'
                      : 'border-[rgba(255,255,255,0.12)] border-l-[0.5px] border-dashed content-stretch flex flex-[1_0_0] h-full items-center min-w-px px-[8px] relative'
                }
              >
                {value ? (
                  <div className="flex flex-col font-['DM_Sans:SemiBold',sans-serif] font-semibold justify-center leading-[0] overflow-hidden relative shrink-0 text-[12px] text-[rgba(255,255,255,0.64)] text-ellipsis w-[40px] whitespace-nowrap" style={FONT_OPSZ_STYLE}>
                    <p className="leading-[normal] overflow-hidden text-ellipsis">{value}</p>
                  </div>
                ) : null}
              </div>
            );
          })()
        ))}
        <div
          className="bg-[rgba(0,0,0,0.64)] border-l border-solid border-[rgba(255,255,255,0.12)] content-stretch flex h-full items-center justify-end px-[8px] py-[2px] relative shrink-0"
          style={{ width: `${rightColumnWidth}px` }}
        >
          <button type="button" className="content-stretch flex items-center justify-center overflow-clip p-[3.75px] relative rounded-[3.75px] shrink-0 size-[20px] hover:bg-[rgba(255,255,255,0.1)] transition-colors">
            <div className="overflow-clip relative shrink-0 size-[12.5px]">
              <div className="absolute inset-[8.33%_12.5%]">
                <div className="absolute inset-[-5.01%_-5.57%]">
                  <img alt="Supprimer" className="block max-w-none size-full" src={imgIcon1} />
                </div>
              </div>
            </div>
          </button>
        </div>
      </div>
    </div>
  );
}

function PhaseIcon({ src, name, left }: { src: string; name: string; left: string }) {
  return (
    <div
      className="absolute h-[17.005px] opacity-50 overflow-clip top-[4.25px] w-[16px]"
      style={{ left }}
      data-name={name}
    >
      <div className="absolute inset-[8.33%]" data-name="Icon">
        <div className="absolute inset-[-4.7%_-5%]">
          <img alt="" className="block max-w-none size-full" src={src} />
        </div>
      </div>
    </div>
  );
}

function HoverSummaryCard({
  summary,
  showDivider,
}: {
  summary: AnalysisHoverSummary;
  showDivider: boolean;
}) {
  return (
    <>
      {showDivider ? <div className="self-stretch w-px bg-[rgba(255,255,255,0.16)]" /> : null}
      <div className="content-stretch flex gap-[8px] items-start px-[6px] relative shrink-0">
        <div className="rounded-[2px] shrink-0 size-[12px]" style={{ background: summary.color }} />
        <div className="content-stretch flex flex-col font-['Rethink_Sans:Bold',sans-serif] font-bold gap-[4px] items-start leading-[0] relative shrink-0 text-[12px] text-white">
          <HoverLine value={summary.distanceLabel} wide={false} />
          <HoverLine value={summary.ascentLabel} />
          <HoverLine value={summary.descentLabel} />
          <HoverLine value={summary.durationLabel} />
          <HoverLine value={summary.scheduleLabel} />
        </div>
      </div>
    </>
  );
}

function HoverLine({ value, wide = true }: { value: string; wide?: boolean }) {
  return (
    <div className={wide ? 'flex flex-col justify-center relative shrink-0 w-[74px]' : 'flex flex-col justify-center relative shrink-0 whitespace-nowrap'}>
      <p className="leading-[normal]">{value}</p>
    </div>
  );
}

function buildSeriesPath(points: AnalysisChartPoint[], closeToBaseline: boolean): string {
  if (points.length < 2) return '';

  const commands = points
    .map((point, index) => {
      const x = formatPathNumber(clamp(point.x, 0, 100));
      const y = formatPathNumber(projectY(point.y));
      return `${index === 0 ? 'M' : 'L'} ${x} ${y}`;
    })
    .join(' ');

  if (!closeToBaseline) {
    return commands;
  }

  const firstX = formatPathNumber(clamp(points[0].x, 0, 100));
  const lastX = formatPathNumber(clamp(points[points.length - 1].x, 0, 100));
  return `${commands} L ${lastX} 100 L ${firstX} 100 Z`;
}

function projectY(value: number): number {
  const clamped = clamp(value, PLOT_Y_MIN, PLOT_Y_MAX);
  const ratio = (clamped - PLOT_Y_MIN) / (PLOT_Y_MAX - PLOT_Y_MIN);
  return 100 - ratio * 100;
}

function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value));
}

function formatPathNumber(value: number): string {
  return value.toFixed(3).replace(/\.0+$|(?<=\.\d*[1-9])0+$/u, '');
}

/**
 * Compute a "nice" step (1, 2, 2.5, 5 or 10) × 10ⁿ for the given range and
 * desired number of intervals. Returns at least two ticks aligned on the step.
 */
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
  for (let v = start; v <= max + step * 1e-6; v += step) {
    const rounded = Math.round(v / step) * step;
    ticks.push(Number(rounded.toFixed(10)));
  }
  if (ticks.length === 0 || ticks[0] > min + step * 1e-6) ticks.unshift(min);
  if (ticks[ticks.length - 1] < max - step * 1e-6) ticks.push(max);
  // Deduplicate while preserving order.
  const seen = new Set<number>();
  return ticks.filter((v) => {
    if (seen.has(v)) return false;
    seen.add(v);
    return true;
  });
}

/**
 * Build the X axis column descriptors. Inserts evenly spaced minor columns
 * between consecutive majors when the available width allows it.
 */
function buildXColumns(majors: number[], usableWidth: number): GridColumn[] {
  if (majors.length === 0) return [];
  if (majors.length === 1) {
    return [{ value: majors[0], major: true, label: formatTickLabel(majors[0]) }];
  }
  const intervalPx = usableWidth > 0 ? usableWidth / (majors.length - 1) : 0;
  const minorPerInterval =
    intervalPx > 0 ? Math.max(0, Math.floor(intervalPx / X_MINOR_TARGET_PX) - 1) : 0;
  const cols: GridColumn[] = [];
  for (let i = 0; i < majors.length - 1; i++) {
    cols.push({ value: majors[i], major: true, label: formatTickLabel(majors[i]) });
    if (minorPerInterval > 0) {
      const segment = (majors[i + 1] - majors[i]) / (minorPerInterval + 1);
      for (let m = 1; m <= minorPerInterval; m++) {
        cols.push({ value: majors[i] + segment * m, major: false });
      }
    }
  }
  const last = majors[majors.length - 1];
  cols.push({ value: last, major: true, label: formatTickLabel(last) });
  return cols;
}

/**
 * Build the Y plot rows. Majors come from {@link buildNiceTicks} sorted
 * descending; minors are inserted as `null` rows when vertical space allows.
 * Mirrors the original spacing: an optional leading minor pushes the top
 * label slightly below the chart edge for readability.
 */
function buildPlotRows(majorsDescending: number[], usableHeight: number): Array<number | null> {
  if (majorsDescending.length === 0) return [null];
  const N = majorsDescending.length;
  const intervalPx = N > 1 && usableHeight > 0 ? usableHeight / (N - 1) : usableHeight;
  const minorPerInterval =
    intervalPx > 0 ? Math.max(0, Math.floor(intervalPx / Y_MINOR_TARGET_PX) - 1) : 0;
  const rows: Array<number | null> = [];
  if (minorPerInterval >= 1 && usableHeight > 48) rows.push(null);
  for (let i = 0; i < N; i++) {
    rows.push(majorsDescending[i]);
    if (i < N - 1) {
      for (let m = 0; m < minorPerInterval; m++) rows.push(null);
    }
  }
  return rows;
}

function formatTickLabel(value: number): string {
  if (Number.isInteger(value)) return String(value);
  return Number(value.toFixed(2)).toString();
}
