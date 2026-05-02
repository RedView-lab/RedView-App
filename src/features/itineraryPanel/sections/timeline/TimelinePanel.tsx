/**
 * Main "Feuille de route" / "Timeline" section — composes the sub-views.
 *
 * This component is purely presentational; all state mutations go through the
 * callback props so the parent container can wire them to a backend,
 * optimistic updates, undo/redo etc.
 */
import { useEffect, useMemo, useRef, useState, type MouseEvent } from 'react';
import type { PredictionResult } from '@/features/fitPredictor';
import type {
  PoiCategory,
  RhythmState,
  TimelineAddItemKind,
  TimelineAddItemOptions,
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
import { buildScheduledTimelineState, parseStartReference } from './TimelineTimelineView/utils';

interface TimelinePanelProps {
  items: TimelineItem[];
  rhythm?: RhythmState;
  prediction?: PredictionResult | null;
  view: TimelineView;
  railConfig?: Partial<TimelineRailConfig>;
  isFullscreen?: boolean;

  onChangeView?: (v: TimelineView) => void;
  onOpenSettings?: () => void;
  onToggleFullscreen?: () => void;
  onAdd?: (kind: TimelineAddItemKind, options?: TimelineAddItemOptions) => void;

  onToggleItem?: (id: string, visible: boolean) => void;
  onMovePause?: (id: string, distanceKm: number) => void;
  onChangePauseDuration?: (id: string, durationMin: number) => void;
  onChangeIntervalPauseDuration?: (pauseIntervalId: string, durationMin: number) => void;
  onChangeFavoritePoiPauseDuration?: (category: PoiCategory, durationMin: number) => void;
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
  isFullscreen,
  onChangeView,
  onOpenSettings,
  onToggleFullscreen,
  onAdd,
  onToggleItem,
  onMovePause,
  onChangePauseDuration,
  onChangeIntervalPauseDuration,
  onChangeFavoritePoiPauseDuration,
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
  const pauseInsertionResolverRef = useRef<(() => number | null) | null>(null);

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
    const addOptions = kind === 'pause' && view === 'timeline'
      ? buildPauseAddOptions(pauseInsertionResolverRef.current?.())
      : undefined;
    onAdd?.(kind, addOptions);
  };

  const intervalPauseSheetItems = useMemo(() => {
    if (view !== 'sheet') return [];

    const reference = parseStartReference(rhythm);
    const { autoPauses } = buildScheduledTimelineState(items, prediction, reference, rhythm);

    return autoPauses.map((pause) => ({
      id: pause.id,
      kind: 'pause' as const,
      label: pause.label,
      distanceKm: pause.distanceKm,
      durationMin: pause.durationMin,
      favorite: true,
      visible: pause.visible,
      autoGenerated: 'intervalPause' as const,
    }));
  }, [items, prediction, rhythm, view]);

  const visibleSheetItems = useMemo(
    () => buildSheetItemsWithIntervalPauses(items, intervalPauseSheetItems)
      .filter((item) => matchesTimelineFilter(item, 'sheet', filters)),
    [filters, intervalPauseSheetItems, items],
  );

  const visibleTimelineItems = useMemo(
    () => items.filter((item) => matchesTimelineFilter(item, 'timeline', filters)),
    [filters, items],
  );

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
      className={`rvi-timeline rvi-timeline--${view}${isFullscreen ? ' rvi-timeline--fullscreen' : ''}`}
      aria-label="Feuille de route"
    >
      <TimelineHeader
        view={view}
        onChangeView={onChangeView}
        onOpenSettings={handleOpenSettings}
        settingsActive={view === 'timeline' && timelineEditOpen}
        fullscreenActive={isFullscreen}
        onToggleFullscreen={onToggleFullscreen}
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
              items={visibleSheetItems}
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
              items={visibleTimelineItems}
              rhythm={rhythm}
              prediction={prediction}
              config={railConfig}
              markerStepKm={timelineMarkerStepKm}
              hourZoom={timelineZoomLevel}
              selectedIds={selectedIds}
              onToggleSelect={handleToggleSelect}
              onToggleVisibility={onToggleItem}
              onMovePause={onMovePause}
              onChangePauseDuration={onChangePauseDuration}
              onChangeIntervalPauseDuration={onChangeIntervalPauseDuration}
              onChangeFavoritePoiPauseDuration={onChangeFavoritePoiPauseDuration}
              onRegisterPauseInsertionResolver={(resolver) => {
                pauseInsertionResolverRef.current = resolver;
              }}
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

function buildPauseAddOptions(distanceKm: number | null | undefined): TimelineAddItemOptions | undefined {
  if (!Number.isFinite(distanceKm)) return undefined;
  return {
    distanceKm: Math.max(0, Number((distanceKm as number).toFixed(3))),
  };
}

function matchesTimelineFilter(
  item: TimelineItem,
  view: TimelineView,
  filters: TimelineFilterState,
): boolean {
  if (item.favorite && !filters.favorite) return false;
  if (item.kind === 'start' || item.kind === 'end') return filters.etape;
  if (item.kind === 'waypoint') return filters.waypoint;
  if (item.kind === 'pause') return filters.pause;
  if (view === 'timeline' && item.kind === 'poi' && !item.favorite) return false;
  return filters.poi;
}

function buildSheetItemsWithIntervalPauses(
  items: TimelineItem[],
  intervalPauses: TimelineItem[],
): TimelineItem[] {
  if (intervalPauses.length === 0) return items;

  const sortedIntervalPauses = [...intervalPauses].sort(
    (left, right) => (left.distanceKm ?? Number.POSITIVE_INFINITY) - (right.distanceKm ?? Number.POSITIVE_INFINITY),
  );

  const merged: TimelineItem[] = [];
  let nextIntervalIndex = 0;
  let lastResolvedDistanceKm = Number.NEGATIVE_INFINITY;

  items.forEach((item) => {
    const itemDistanceKm = item.distanceKm;
    if (itemDistanceKm !== null) {
      while (nextIntervalIndex < sortedIntervalPauses.length) {
        const intervalPause = sortedIntervalPauses[nextIntervalIndex]!;
        const intervalDistanceKm = intervalPause.distanceKm ?? Number.POSITIVE_INFINITY;
        if (intervalDistanceKm > itemDistanceKm || intervalDistanceKm <= lastResolvedDistanceKm) break;
        merged.push(intervalPause);
        nextIntervalIndex += 1;
      }
      lastResolvedDistanceKm = itemDistanceKm;
    }

    merged.push(item);
  });

  while (nextIntervalIndex < sortedIntervalPauses.length) {
    merged.push(sortedIntervalPauses[nextIntervalIndex]!);
    nextIntervalIndex += 1;
  }

  return merged;
}
