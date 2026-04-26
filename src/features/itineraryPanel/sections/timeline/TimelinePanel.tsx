/**
 * Main "Feuille de route" / "Timeline" section — composes the sub-views.
 *
 * This component is purely presentational; all state mutations go through the
 * callback props so the parent container can wire them to a backend,
 * optimistic updates, undo/redo etc.
 */
import { useEffect, useState, type MouseEvent } from 'react';
import type { PredictionResult } from '@/features/fitPredictor';
import type {
  RhythmState,
  TimelineAddItemKind,
  TimelineItem,
  TimelineRailConfig,
  TimelineView,
} from '../../types';
import { KindBadge } from './KindBadge';
import { TimelineEditPanel } from './TimelineEditPanel';
import { TimelineHeader } from './TimelineHeader';
import { TimelineSheetView } from './TimelineSheetView';
import { TimelineTimelineView } from './TimelineTimelineView';
import {
  TimelineKindMenu,
  type TimelineKindMenuOption,
} from './TimelineKindMenu.tsx';
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
  rhythm?: RhythmState;
  prediction?: PredictionResult | null;
  view: TimelineView;
  railConfig?: Partial<TimelineRailConfig>;

  onChangeView?: (v: TimelineView) => void;
  onSearch?: () => void;
  onOpenSettings?: () => void;
  onAdd?: (kind: TimelineAddItemKind) => void;

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
  rhythm,
  prediction,
  view,
  railConfig,
  onChangeView,
  onSearch,
  onOpenSettings,
  onAdd,
  onToggleItem,
  onFavoriteItem,
  onRemoveItem,
  onSelectPlace,
  onSelectionChange,
}: TimelinePanelProps) {
  // Selection is local UI state; parent is notified via onSelectionChange.
  const [selectedIds, setSelectedIds] = useState<Set<string>>(() => new Set());
  const [addMenuAnchor, setAddMenuAnchor] = useState<HTMLElement | null>(null);
  const [timelineEditOpen, setTimelineEditOpen] = useState(false);
  const [timelineMarkerStepKm, setTimelineMarkerStepKm] = useState(50);
  const [timelineZoomLevel, setTimelineZoomLevel] = useState(1);

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

  const handleOpenKindMenu = (event: MouseEvent<HTMLButtonElement>) => {
    const nextAnchor = event.currentTarget.closest('.rvi-tl-add, .rvi-tl-add-split');
    const resolvedAnchor =
      nextAnchor instanceof HTMLElement ? nextAnchor : event.currentTarget;
    setAddMenuAnchor((current) => (current === resolvedAnchor ? null : resolvedAnchor));
  };

  const handleCloseKindMenu = () => {
    setAddMenuAnchor(null);
  };

  useEffect(() => {
    if (view !== 'timeline') {
      setTimelineEditOpen(false);
    }
  }, [view]);

  const handleOpenSettings = () => {
    if (view === 'timeline') {
      setTimelineEditOpen((current) => !current);
      return;
    }
    onOpenSettings?.();
  };

  const handleSelectAddKind = (kind: TimelineAddItemKind) => {
    onAdd?.(kind);
  };

  // Apply filter chips to the items list before rendering.
  const visibleItems = items.filter((it) => {
    if (it.favorite && !filters.favorite) return false;
    if (it.kind === 'start' || it.kind === 'end') return filters.etape;
    if (it.kind === 'waypoint') return filters.waypoint;
    if (it.kind === 'pause') return filters.pause;
    if (view === 'timeline' && it.kind === 'poi' && !it.favorite) return false;
    // water + supermarket + poi (corridor-injected) → all under the POI filter
    return filters.poi;
  });

  const addMenuOptions: TimelineKindMenuOption[] = [
    {
      value: 'step',
      label: 'Étape',
      icon: <span className="rvi-tl-kind-menu__step-dot" />,
    },
    {
      value: 'waypoint',
      label: 'Waypoint',
      icon: <KindBadge kind="waypoint" />,
    },
    {
      value: 'poi',
      label: 'POI',
      icon: <KindBadge kind="poi" />,
    },
    {
      value: 'pause',
      label: 'Pause',
      icon: <KindBadge kind="pause" />,
    },
    {
      value: 'start',
      label: 'Départ',
      icon: <KindBadge kind="start" />,
    },
    {
      value: 'end',
      label: 'Destination',
      icon: <KindBadge kind="end" />,
    },
  ];

  return (
    <section
      className={`rvi-timeline rvi-timeline--${view}`}
      aria-label="Feuille de route"
    >
      <TimelineHeader
        view={view}
        onChangeView={onChangeView}
        onSearch={onSearch}
        onOpenSettings={handleOpenSettings}
        settingsActive={view === 'timeline' && timelineEditOpen}
        onAdd={handleOpenKindMenu}
        onOpenKindMenu={handleOpenKindMenu}
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
              onAdd={handleOpenKindMenu}
              onOpenKindMenu={handleOpenKindMenu}
              onSelectPlace={onSelectPlace}
            />
          </>
        ) : (
          <>
            {timelineEditOpen ? (
              <TimelineEditPanel
                filters={filters}
                markerStepKm={timelineMarkerStepKm}
                zoomLevel={timelineZoomLevel}
                onChangeFilters={setFilters}
                onChangeMarkerStepKm={setTimelineMarkerStepKm}
                onChangeZoomLevel={setTimelineZoomLevel}
              />
            ) : null}

            <TimelineTimelineView
              items={visibleItems}
              rhythm={rhythm}
              prediction={prediction}
              config={railConfig}
              markerStepKm={timelineMarkerStepKm}
              hourZoom={timelineZoomLevel}
              selectedIds={selectedIds}
              onToggleSelect={handleToggleSelect}
              onToggleVisibility={onToggleItem}
              onToggleFavorite={onFavoriteItem}
              onRemove={onRemoveItem}
            />
          </>
        )}
      </div>

      <TimelineKindMenu
        anchorEl={addMenuAnchor}
        open={!!addMenuAnchor}
        options={addMenuOptions}
        onClose={handleCloseKindMenu}
        onSelect={handleSelectAddKind}
      />
    </section>
  );
}
