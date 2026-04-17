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
  onSelectionChange,
}: TimelinePanelProps) {
  // Selection is local UI state; parent is notified via onSelectionChange.
  const [selectedIds, setSelectedIds] = useState<Set<string>>(() => new Set());

  const handleToggleSelect = (id: string, selected: boolean) => {
    setSelectedIds((prev) => {
      const next = new Set(prev);
      if (selected) next.add(id);
      else next.delete(id);
      onSelectionChange?.(Array.from(next));
      return next;
    });
  };

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
          <TimelineSheetView
            items={items}
            selectedIds={selectedIds}
            onToggleSelect={handleToggleSelect}
            onToggleVisibility={onToggleItem}
            onToggleFavorite={onFavoriteItem}
            onRemove={onRemoveItem}
            onAdd={onAdd}
            onOpenKindMenu={onOpenKindMenu}
          />
        ) : (
          <TimelineTimelineView
            items={items}
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
