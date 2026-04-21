import type { CSSProperties } from 'react';
import { imgPlusCircle, imgIcon5, imgIcon6, imgIcon7 } from './assets';
import { AnalysisResultsGrid } from './AnalysisResultsGrid';

export interface AnalysisChartPoint {
  x: number;
  y: number;
}

export interface AnalysisChartSeries {
  id: string;
  color: string;
  points: AnalysisChartPoint[];
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
  xAxisTicks?: number[];
}

const DEFAULT_X_AXIS_TICKS = [0, 10, 20, 30, 40, 50, 60, 70, 80, 90, 100];
const DEFAULT_DAY_WINDOWS: AnalysisDayWindow[] = [
  { id: 'day-1', startPercent: 5.8, endPercent: 27.6 },
  { id: 'day-2', startPercent: 60.6, endPercent: 78.9 },
];

const PLOT_Y_MIN = 0;
const PLOT_Y_MAX = 3000;
const FONT_OPSZ_STYLE: CSSProperties = { fontVariationSettings: "'opsz' 14" };

export function AnalysisResults({
  series = [],
  dayWindows = DEFAULT_DAY_WINDOWS,
  cursor = null,
  xAxisTicks = DEFAULT_X_AXIS_TICKS,
}: AnalysisResultsProps) {
  const plotSeries = series.filter((entry) => entry.points.length > 1);
  const hoverLeftPercent = cursor ? clamp(cursor.xPercent, 24, 76) : 50;

  return (
    <div
      className="bg-[rgba(0,0,0,0.64)] content-stretch flex flex-[1_0_0] flex-col gap-[0.5px] items-start min-h-[148px] overflow-clip relative rounded-[5px] w-full"
      data-node-id="1894:39014"
      data-name="RESULTS"
    >
      <div
        className="absolute inset-[17px_0_70px_97px] overflow-hidden pointer-events-none"
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

      <AnalysisResultsGrid columnCount={xAxisTicks.length} />
      <AxisRow ticks={xAxisTicks} />
      <AddLineRow columnCount={xAxisTicks.length} />
    </div>
  );
}

function AxisRow({ ticks }: { ticks: number[] }) {
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
        {ticks.map((tick, index) => (
          <div
            key={tick}
            className={index === 0
              ? "border-[rgba(255,255,255,0.8)] border-l border-solid content-stretch flex flex-[1_0_0] h-full items-center min-w-px px-[8px] py-[2px] relative"
              : "border-[rgba(255,255,255,0.24)] border-l-[0.5px] border-solid content-stretch flex flex-[1_0_0] h-full items-center min-w-px px-[8px] py-[2px] relative"}
          >
            <div
              className="flex flex-col font-['DM_Sans:SemiBold',sans-serif] font-semibold justify-center leading-[0] overflow-hidden relative shrink-0 text-[12px] text-ellipsis text-white w-[40px] whitespace-nowrap"
              style={FONT_OPSZ_STYLE}
            >
              <p className="leading-[normal] overflow-hidden text-ellipsis">{tick}</p>
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}

function AddLineRow({ columnCount }: { columnCount: number }) {
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
        {Array.from({ length: columnCount }).map((_, index) => (
          <div
            key={index}
            className={index === 0
              ? "border-[rgba(255,255,255,0.8)] border-l border-solid content-stretch flex flex-[1_0_0] h-full items-center min-w-px px-[8px] relative"
              : "border-[rgba(255,255,255,0.24)] border-l-[0.5px] border-solid content-stretch flex flex-[1_0_0] h-full items-center min-w-px px-[8px] relative"}
          >
            <div
              className="flex flex-col font-['DM_Sans:SemiBold',sans-serif] font-semibold justify-center leading-[0] overflow-hidden relative shrink-0 text-[12px] text-[rgba(255,255,255,0.64)] text-ellipsis w-[40px] whitespace-nowrap"
              style={FONT_OPSZ_STYLE}
            >
              <p className="leading-[normal] overflow-hidden text-ellipsis"> </p>
            </div>
          </div>
        ))}
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
