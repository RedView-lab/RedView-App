import type { CSSProperties } from 'react';

interface AnalysisResultsGridProps {
  columnCount?: number;
  plotRows?: Array<number | null>;
}

const DEFAULT_PLOT_ROWS: Array<number | null> = [null, 3000, null, 2000, null, 1000, null, 0];
const FONT_OPSZ_STYLE: CSSProperties = { fontVariationSettings: "'opsz' 14" };

export function AnalysisResultsGrid({
  columnCount = 11,
  plotRows = DEFAULT_PLOT_ROWS,
}: AnalysisResultsGridProps) {
  return (
    <>
      {plotRows.map((tick, index) => (
        <GridRow key={`${index}-${tick ?? 'empty'}`} label={tick != null ? String(tick) : ''} columnCount={columnCount} />
      ))}
    </>
  );
}

function GridRow({ label, columnCount }: { label: string; columnCount: number }) {
  return (
    <div className="border-[rgba(255,255,255,0.08)] border-b-[0.5px] border-solid border-t-[0.5px] content-stretch flex flex-[1_0_0] items-end min-h-[16px] relative w-full">
      <div className="bg-[rgba(0,0,0,0.64)] content-stretch flex h-full items-end justify-end px-[4px] py-[2px] relative shrink-0 w-[95px]">
        <div
          className="flex flex-col font-['DM_Sans:SemiBold',sans-serif] font-semibold justify-center leading-[0] overflow-hidden relative shrink-0 text-[12px] text-[rgba(255,255,255,0.64)] text-ellipsis text-right w-[40px] whitespace-nowrap"
          style={FONT_OPSZ_STYLE}
        >
          <p className="leading-[normal] overflow-hidden text-ellipsis">{label || ' '}</p>
        </div>
      </div>
      <div className="content-stretch flex flex-[1_0_0] h-full items-center min-w-px relative">
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
