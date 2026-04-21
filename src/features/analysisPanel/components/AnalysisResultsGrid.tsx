import { forwardRef, type CSSProperties } from 'react';

export interface GridColumn {
  /** Numeric value of this column boundary (left edge). */
  value: number;
  /** Major columns get a stronger border + label. */
  major: boolean;
  /** Optional label rendered for major columns. */
  label?: string;
}

interface AnalysisResultsGridProps {
  columns: GridColumn[];
  plotRows: Array<number | null>;
  rightColumnWidth: number;
  children?: React.ReactNode;
}

const FONT_OPSZ_STYLE: CSSProperties = { fontVariationSettings: "'opsz' 14" };

/**
 * Wrapper containing all horizontal grid rows. Forwards a ref so the parent
 * can measure available width / height and recompute dynamic ticks.
 */
export const AnalysisResultsGrid = forwardRef<HTMLDivElement, AnalysisResultsGridProps>(
  function AnalysisResultsGrid({ columns, plotRows, rightColumnWidth, children }, ref) {
    return (
      <div
        ref={ref}
        className="content-stretch flex flex-[1_0_0] flex-col items-stretch min-h-0 relative w-full"
      >
        <div
          className="absolute inset-y-0 z-10"
          style={{ left: '95px', right: `${rightColumnWidth}px`, pointerEvents: 'none' }}
        >
          {children}
        </div>
        {plotRows.map((tick, index) => (
          <GridRow
            key={`${index}-${tick ?? 'empty'}`}
            label={tick != null ? String(tick) : ''}
            columns={columns}
            rightColumnWidth={rightColumnWidth}
          />
        ))}
      </div>
    );
  },
);

function GridRow({
  label,
  columns,
  rightColumnWidth,
}: {
  label: string;
  columns: GridColumn[];
  rightColumnWidth: number;
}) {
  return (
    <div className="border-[rgba(255,255,255,0.08)] border-b-[0.5px] border-solid border-t-[0.5px] content-stretch flex flex-[1_0_0] items-end min-h-[12px] relative w-full">
      <div className="bg-[rgba(0,0,0,0.64)] content-stretch flex h-full items-end justify-end px-[4px] py-[2px] relative shrink-0 w-[95px]">
        <div
          className="flex flex-col font-['DM_Sans:SemiBold',sans-serif] font-semibold justify-center leading-[0] overflow-hidden relative shrink-0 text-[12px] text-[rgba(255,255,255,0.64)] text-ellipsis text-right w-[40px] whitespace-nowrap"
          style={FONT_OPSZ_STYLE}
        >
          <p className="leading-[normal] overflow-hidden text-ellipsis">{label || ' '}</p>
        </div>
      </div>
      <div className="content-stretch flex flex-[1_0_0] h-full items-center min-w-px relative">
        {columns.map((col, index) => (
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
          className="bg-[rgba(0,0,0,0.64)] border-l border-solid border-[rgba(255,255,255,0.12)] content-stretch flex h-full items-end justify-end px-[4px] py-[2px] relative shrink-0"
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
