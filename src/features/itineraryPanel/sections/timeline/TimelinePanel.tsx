/**
 * Main "Feuille de route" / "Timeline" section — composes the sub-views.
 *
 * This component is purely presentational; all state mutations go through the
 * callback props so the parent container can wire them to a backend,
 * optimistic updates, undo/redo etc.
 */
import { useState } from 'react';
import type { TimelineItem, TimelineRailConfig, TimelineView } from '../../types';
import { TimelineHeader } from './TimelineHeader';
import { TimelineSheetView } from './TimelineSheetView';
import { TimelineTimelineView } from './TimelineTimelineView';
import {
  TimelineFilters,
  type TimelineFilterState,
  DEFAULT_TIMELINE_FILTER,
} from './TimelineFilters';
import {
  TimelineTableSettings,
  type TimelineTableSettingsState,
  DEFAULT_TIMELINE_TABLE_SETTINGS,
} from './TimelineTableSettings';

interface TimelinePanelProps {
  items: TimelineItem[];
  view: TimelineView;
  railConfig?: Partial<TimelineRailConfig>;

  onChangeView?: (v: TimelineView) => void;
  onSearch?: () => void;
  onOpenSettings?: () => void;
  onAdd?: () => void;
  onOpenKindMenu?: () => void;

  onToggleItem?: (id: string, visible: boolean) => void;
  onFavoriteItem?: (id: string, favorite: boolean) => void;
  onRemoveItem?: (id: string) => void;
  onSelectPlace?: (
    id: string,
    place: { name: string; fullName: string; lat: number; lon: number },
  ) => void;

  /** Optional multi-select callback. */
  onSelectionChange?: (selectedIds: string[]) => void;
}

export function TimelinePanel({
  items,
  view,
  railConfig,
  onChangeView,
  onSearch,
  onOpenSettings,
  onAdd,
  onOpenKindMenu,
  onToggleItem,
  onFavoriteItem,
  onRemoveItem,
  onSelectPlace,
  onSelectionChange,
}: TimelinePanelProps) {
  // Selection is local UI state; parent is notified via onSelectionChange.
  const [selectedIds, setSelectedIds] = useState<Set<string>>(() => new Set());

  // Filter + table-settings state — local for now; the wiring to backend
  // will move these into the project state once persistence lands.
  const [filters, setFilters] = useState<TimelineFilterState>(
    DEFAULT_TIMELINE_FILTER,
  );
  const [tableSettings, setTableSettings] = useState<TimelineTableSettingsState>(
    DEFAULT_TIMELINE_TABLE_SETTINGS,
  );

  const handleToggleSelect = (id: string, selected: boolean) => {
    setSelectedIds((prev) => {
      const next = new Set(prev);
      if (selected) next.add(id);
      else next.delete(id);
      onSelectionChange?.(Array.from(next));
      return next;
    });
  };

  // Apply filter chips to the items list before rendering.
  const visibleItems = items.filter((it) => {
    if (it.kind === 'start' || it.kind === 'end') return filters.etape;
    if (it.kind === 'waypoint') return filters.waypoint;
    if (it.kind === 'pause') return filters.pause;
    // water + supermarket + future POI variants
    return filters.poi;
  });

  return (
    <section
      className={`rvi-timeline rvi-timeline--${view}`}
      aria-label="Feuille de route"
    >
      <TimelineHeader
        view={view}
        onChangeView={onChangeView}
        onSearch={onSearch}
        onOpenSettings={onOpenSettings}
        onAdd={onAdd}
        onOpenKindMenu={onOpenKindMenu}
      />

      <div className="rvi-timeline__body">
        {view === 'sheet' ? (
          <>
            <TimelineFilters value={filters} onChange={setFilters} />
            <TimelineTableSettings
              value={tableSettings}
              onChange={setTableSettings}
            />
            <hr className="rvi-tl-divider" aria-hidden />
            <TimelineSheetView
              items={visibleItems}
              selectedIds={selectedIds}
              onToggleSelect={handleToggleSelect}
              onToggleVisibility={onToggleItem}
              onToggleFavorite={onFavoriteItem}
              onRemove={onRemoveItem}
              onAdd={onAdd}
              onOpenKindMenu={onOpenKindMenu}
              onSelectPlace={onSelectPlace}
            />
          </>
        ) : (
          <TimelineTimelineView
            items={visibleItems}
            config={railConfig}
            selectedIds={selectedIds}
            onToggleSelect={handleToggleSelect}
            onToggleVisibility={onToggleItem}
            onToggleFavorite={onFavoriteItem}
            onRemove={onRemoveItem}
          />
        )}
      </div>
    </section>
  );
}
