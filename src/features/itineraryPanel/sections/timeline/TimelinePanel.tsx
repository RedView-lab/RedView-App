/**
 * Main "Feuille de route" / "Timeline" section — composes the sub-views.
 *
 * This component is purely presentational; all state mutations go through the
 * callback props so the parent container can wire them to a backend,
 * optimistic updates, undo/redo etc.
 */
import { useEffect, useMemo, useRef, useState, type MouseEvent } from 'react';
import type { PredictionResult } from '@/features/fitPredictor';
import { useAppI18n } from '@/shared/i18n';
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
  type TimelineFilterState,
  DEFAULT_TIMELINE_FILTER,
} from './TimelineFilters';
import { TimelineSheetFilterPanel } from './TimelineSheetFilterPanel';
import { matchesPoiCategory } from './poiCategoryMatch';
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
  tableSettings?: TimelineTableSettingsState;
  globalFilters?: TimelineFilterState;

  onChangeView?: (v: TimelineView) => void;
  onOpenSettings?: () => void;
  onToggleFullscreen?: () => void;
  onAdd?: (kind: TimelineAddItemKind, options?: TimelineAddItemOptions) => void;
  onChangeTableSettings?: (next: TimelineTableSettingsState) => void;

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

  selectedIds?: string[];
  onSelectRow?: (id: string, item: TimelineItem) => void;
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
  tableSettings,
  globalFilters,
  selectedIds: selectedIdsProp,
  onSelectRow,
  onChangeView,
  onOpenSettings,
  onToggleFullscreen,
  onAdd,
  onChangeTableSettings,
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
  const { t } = useAppI18n();
  const [localSelectedIds, setLocalSelectedIds] = useState<Set<string>>(() => new Set());
  const selectedIds = useMemo(() => {
    if (selectedIdsProp !== undefined) {
      return new Set(selectedIdsProp);
    }
    return localSelectedIds;
  }, [selectedIdsProp, localSelectedIds]);

  const [addMenuAnchor, setAddMenuAnchor] = useState<HTMLElement | null>(null);
  const [timelineEditOpen, setTimelineEditOpen] = useState(false);
  const [timelineMarkerStepKm, setTimelineMarkerStepKm] = useState(50);
  const [timelineZoomLevel, setTimelineZoomLevel] = useState(1);
  const pauseInsertionResolverRef = useRef<(() => number | null) | null>(null);

  // Table-settings state — local for now; the wiring to backend
  // will move these into the project state once persistence lands.
  const [localTableSettings, setLocalTableSettings] = useState<TimelineTableSettingsState>(
    DEFAULT_TIMELINE_TABLE_SETTINGS,
  );
  const resolvedTableSettings = tableSettings ?? localTableSettings;
  const handleChangeTableSettings = onChangeTableSettings ?? setLocalTableSettings;

  // Local table filters: when overridden (non-null), filters apply ONLY to this table.
  // When null, the table synchronizes with globalFilters from the top of the screen.
  const [localFilters, setLocalFilters] = useState<TimelineFilterState | null>(null);
  const effectiveFilters = useMemo<TimelineFilterState>(() => {
    return localFilters ?? globalFilters ?? DEFAULT_TIMELINE_FILTER;
  }, [localFilters, globalFilters]);

  const [sheetSettingsOpen, setSheetSettingsOpen] = useState(false);

  const handleToggleSelect = (id: string, selected: boolean) => {
    const next = new Set(selectedIds);
    if (selected) next.add(id);
    else next.delete(id);
    if (selectedIdsProp === undefined) {
      setLocalSelectedIds(next);
    }
    onSelectionChange?.(Array.from(next));
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

  useEffect(() => {
    if (!isFullscreen) return;
    if (view === 'timeline') {
      setTimelineEditOpen(true);
    } else if (view === 'sheet') {
      setSheetSettingsOpen(true);
    }
  }, [isFullscreen, view]);

  const handleOpenSettings = () => {
    if (view === 'timeline') {
      setTimelineEditOpen((current) => !current);
      return;
    }
    setSheetSettingsOpen((current) => !current);
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
      .filter((item) => matchesTimelineFilter(item, 'sheet', effectiveFilters)),
    [effectiveFilters, intervalPauseSheetItems, items],
  );

  const visibleTimelineItems = useMemo(
    () => items.filter((item) => matchesTimelineFilter(item, 'timeline', effectiveFilters)),
    [effectiveFilters, items],
  );

  const addMenuOptions: TimelineKindMenuOption[] = [
    {
      value: 'step',
      label: t('Étape'),
      icon: <span className="rvi-tl-kind-menu__step-dot" />,
    },
    {
      value: 'waypoint',
      label: t('Waypoint'),
      icon: <KindBadge kind="waypoint" />,
    },
    {
      value: 'poi',
      label: t('POI'),
      icon: <KindBadge kind="poi" />,
    },
    {
      value: 'pause',
      label: t('Pause'),
      icon: <KindBadge kind="pause" />,
    },
    {
      value: 'start',
      label: t('Départ'),
      icon: <KindBadge kind="start" />,
    },
    {
      value: 'end',
      label: t('Destination'),
      icon: <KindBadge kind="end" />,
    },
  ];

  const showTimelineTopbar = view === 'timeline' && timelineEditOpen;
  const showSheetTopbar = view === 'sheet' && sheetSettingsOpen;

  return (
    <section
      className={`rvi-timeline rvi-timeline--${view}${isFullscreen ? ' rvi-timeline--fullscreen' : ''}`}
      aria-label={t('Feuille de route')}
    >
      <div className="rvi-timeline__topbar">
        <TimelineHeader
          view={view}
          onChangeView={onChangeView}
          onOpenSettings={handleOpenSettings}
          settingsActive={view === 'timeline' ? timelineEditOpen : sheetSettingsOpen}
          fullscreenActive={isFullscreen}
          onToggleFullscreen={onToggleFullscreen}
          onAdd={handleOpenKindMenu}
          onOpenKindMenu={handleOpenKindMenu}
        />

        {showTimelineTopbar ? (
          <TimelineEditPanel
            filters={effectiveFilters}
            markerStepKm={timelineMarkerStepKm}
            zoomLevel={timelineZoomLevel}
            onChangeFilters={setLocalFilters}
            onChangeMarkerStepKm={setTimelineMarkerStepKm}
            onChangeZoomLevel={setTimelineZoomLevel}
          />
        ) : null}

        {showSheetTopbar ? (
          <TimelineSheetFilterPanel
            filters={effectiveFilters}
            isOverridden={localFilters !== null}
            onChangeFilters={setLocalFilters}
            onResetToGlobal={() => setLocalFilters(null)}
          />
        ) : null}
      </div>

      <div className="rvi-timeline__body">
        {view === 'sheet' ? (
          <>
            <TimelineTableSettings
              value={resolvedTableSettings}
              onChange={handleChangeTableSettings}
            />
            <hr className="rvi-tl-divider" aria-hidden />
            <TimelineSheetView
              items={visibleSheetItems}
              rhythm={rhythm}
              prediction={prediction}
              columns={resolvedTableSettings.columns}
              sort={resolvedTableSettings.sort}
              onChangeSort={(next) =>
                handleChangeTableSettings({ ...resolvedTableSettings, sort: next })
              }
              selectedIds={selectedIds}
              onSelectRow={onSelectRow}
              onToggleSelect={handleToggleSelect}
              onToggleVisibility={onToggleItem}
              onToggleFavorite={onFavoriteItem}
              onRemove={onRemoveItem}
              onAdd={handleOpenKindMenu}
              onOpenKindMenu={handleOpenKindMenu}
              onSelectPlace={onSelectPlace}
              onMovePause={onMovePause}
              onChangePauseDuration={onChangePauseDuration}
              onChangeIntervalPauseDuration={onChangeIntervalPauseDuration}
            />
          </>
        ) : (
          <TimelineTimelineView
            items={visibleTimelineItems}
            rhythm={rhythm}
            prediction={prediction}
            config={railConfig}
            filters={effectiveFilters}
            markerStepKm={timelineMarkerStepKm}
            hourZoom={timelineZoomLevel}
            selectedIds={selectedIds}
            onSelectRow={onSelectRow}
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
  const isFav = Boolean(item.favorite);
  if (isFav && filters.favorite) {
    if (item.kind === 'poi' && filters.categories && filters.categories.size > 0) {
      return matchesPoiCategory(item.poiCategory, filters.categories);
    }
    return true;
  }

  if (item.kind === 'start' || item.kind === 'end') {
    return filters.etape !== false;
  }
  if (item.kind === 'waypoint') {
    return Boolean(filters.waypoint);
  }
  if (item.kind === 'pause') {
    return Boolean(filters.pause);
  }
  if (item.kind === 'poi') {
    if (!filters.poi) return false;
    if (view === 'timeline' && !item.favorite) return false;
    if (filters.categories && filters.categories.size > 0) {
      return matchesPoiCategory(item.poiCategory, filters.categories);
    }
    return true;
  }
  return true;
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
