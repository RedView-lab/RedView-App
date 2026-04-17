/**
 * "Timeline" — proportional vertical km-rail view.
 *
 * Renders a stack of fixed-height rows representing `kmPerRow` km each; items
 * are absolutely-positioned on top at an offset proportional to their
 * `distanceKm`. The rail auto-sizes to the furthest item.
 *
 * Design references: Figma 1539:21068.
 */
import { useMemo } from 'react';
import type { TimelineItem, TimelineRailConfig } from '../../types';
import { DEFAULT_TIMELINE_RAIL } from '../../types';
import { TimelineRow } from './TimelineRow';

interface TimelineTimelineViewProps {
  items: TimelineItem[];
  config?: Partial<TimelineRailConfig>;
  selectedIds?: ReadonlySet<string>;
  onToggleSelect?: (id: string, selected: boolean) => void;
  onToggleVisibility?: (id: string, visible: boolean) => void;
  onToggleFavorite?: (id: string, favorite: boolean) => void;
  onRemove?: (id: string) => void;
}

const RAIL_HEADER_HEIGHT_PX = 30;
const RAIL_ITEM_HEIGHT_PX = 32;
const MIN_ROWS = 10;

export function TimelineTimelineView({
  items,
  config,
  selectedIds,
  onToggleSelect,
  onToggleVisibility,
  onToggleFavorite,
  onRemove,
}: TimelineTimelineViewProps) {
  const { kmPerRow, rowHeightPx } = { ...DEFAULT_TIMELINE_RAIL, ...config };

  const { positioned, totalRows } = useMemo(() => {
    const withDistance = items.filter((i) => i.distanceKm !== null);
    const maxKm = withDistance.reduce(
      (acc, i) => Math.max(acc, i.distanceKm ?? 0),
      0,
    );
    const rows = Math.max(MIN_ROWS, Math.ceil(maxKm / kmPerRow) + 1);
    const placed = withDistance.map((item) => ({
      item,
      topPx: ((item.distanceKm ?? 0) / kmPerRow) * rowHeightPx,
    }));
    return { positioned: placed, totalRows: rows };
  }, [items, kmPerRow, rowHeightPx]);

  const railHeight = totalRows * rowHeightPx;

  return (
    <div className="rvi-tl-list rvi-tl-list--timeline" aria-label="Timeline kilométrique">
      <div className="rvi-tl-list__header">
        <span className="rvi-tl-list__col-type">Type</span>
        <span className="rvi-tl-list__col-flex" />
        <span className="rvi-tl-list__col-actions" aria-hidden />
      </div>

      <div className="rvi-tl-rail" style={{ height: railHeight }}>
        {/* Background rail rows with km labels */}
        <div className="rvi-tl-rail__rows" aria-hidden>
          {Array.from({ length: totalRows }).map((_, idx) => (
            <div
              key={idx}
              className="rvi-tl-rail__row"
              style={{ height: rowHeightPx }}
            >
              <span className="rvi-tl-rail__label">{idx * kmPerRow}</span>
            </div>
          ))}
        </div>

        {/* Items, positioned on top of the rail */}
        <div className="rvi-tl-rail__items">
          {positioned.map(({ item, topPx }, idx) => (
            <div
              key={item.id}
              className="rvi-tl-rail__item"
              style={{
                top: topPx,
                animationDelay: `${Math.min(idx * 18, 240)}ms`,
              }}
            >
              <TimelineRow
                item={item}
                compact
                selected={selectedIds?.has(item.id)}
                onToggleSelect={onToggleSelect}
                onToggleVisibility={onToggleVisibility}
                onToggleFavorite={onToggleFavorite}
                onRemove={onRemove}
              />
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}

// Re-export helpful constants for tests / consumers.
export { RAIL_HEADER_HEIGHT_PX, RAIL_ITEM_HEIGHT_PX };
