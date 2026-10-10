/**
 * Section principale « Feuille de route » / « Agenda » — compose les sous-vues
 * (l'agenda est la vue d'id `'timeline'`).
 *
 * Ce composant est purement présentationnel ; toutes les modifications d'état
 * passent par les props de rappel pour que le conteneur parent puisse les
 * relier à un backend, des mises à jour optimistes, l'annulation/le rétablissement, etc.
 */
import { useMemo, useRef, useState, type MouseEvent } from 'react';
import type { PredictionResult } from '@/features/fitPredictor';
import { useAppI18n } from '@/shared/i18n';
import type { SportDiscipline } from '@/shared/lib/discipline';
import type {
  PoiAutoSortPickRef,
  RhythmState,
  TimelineAddItemKind,
  TimelineAddItemOptions,
  TimelineItem,
  TimelineRailConfig,
  TimelineView,
} from '../../types';
import { TimelineEditPanel } from './TimelineEditPanel';
import { TimelineHeader } from './TimelineHeader';
import { TimelineSheetView } from './TimelineSheetView';
import { TimelineTimelineView } from './TimelineTimelineView';
import { TimelineKindMenu } from './TimelineKindMenu.tsx';
import { TIMELINE_ADD_MENU_OPTIONS } from './timelineAddMenuOptions';
import {
  type TimelineFilterState,
  DEFAULT_TIMELINE_FILTER,
} from './TimelineFilters';
import { sameTimelineFilters } from './timelineFilterUtils';
import { TimelineFilterBar } from './TimelineFilterBar';
import { matchesPoiCategory } from './poiCategoryMatch';
import { TimelineTableSettings } from './TimelineTableSettings';
import {
  DEFAULT_TIMELINE_TABLE_SETTINGS,
  type TimelineTableSettingsState,
} from './timelineTableSettingsState';
import { buildScheduledTimelineState, parseStartReference } from './TimelineTimelineView/utils';
import { indexPoiAutoSortPicks, keepsTimelineItemWithPoiAutoSort } from '../../lib/schedule/poiAutoSort';

interface TimelinePanelProps {
  items: TimelineItem[];
  /** Tri auto actif : POI retenus, seuls (avec les favoris) gardés dans la feuille de route. */
  poiAutoSortPicks?: readonly PoiAutoSortPickRef[] | null;
  rhythm?: RhythmState;
  prediction?: PredictionResult | null;
  /** Sport de l'itinéraire : trail / course affichent des allures et masquent les colonnes de puissance. */
  discipline?: SportDiscipline;
  view: TimelineView;
  railConfig?: Partial<TimelineRailConfig>;
  isFullscreen?: boolean;
  tableSettings?: TimelineTableSettingsState;
  globalFilters?: TimelineFilterState;
  /** Nom GPS de chaque ligne de POI (colonne « Nom GPS » de la feuille de route). */
  gpsNames?: ReadonlyMap<string, string> | null;

  onChangeView?: (v: TimelineView) => void;
  onOpenSettings?: () => void;
  onToggleFullscreen?: () => void;
  onAdd?: (kind: TimelineAddItemKind, options?: TimelineAddItemOptions) => void;
  onChangeTableSettings?: (next: TimelineTableSettingsState) => void;

  onToggleItem?: (id: string, visible: boolean) => void;
  onMovePause?: (id: string, distanceKm: number) => void;
  onChangePauseDuration?: (id: string, durationMin: number) => void;
  onChangeIntervalPauseDuration?: (pauseIntervalId: string, durationMin: number) => void;
  onFavoriteItem?: (id: string, favorite: boolean) => void;
  /** Nom saisi dans la colonne « Nom » d'un POI (vide = nom d'origine). */
  onRenameItem?: (id: string, label: string) => void;
  onRemoveItem?: (id: string) => void;
  onSelectPlace?: (
    id: string,
    place: { name: string; fullName: string; lat: number; lon: number },
  ) => void;

  selectedIds?: string[];
  onSelectRow?: (id: string, item: TimelineItem) => void;
  /** Rappel de sélection multiple optionnel. */
  onSelectionChange?: (selectedIds: string[]) => void;
}

export function TimelinePanel({
  items,
  poiAutoSortPicks,
  rhythm,
  prediction,
  discipline = 'bike',
  view,
  railConfig,
  isFullscreen,
  tableSettings,
  globalFilters,
  gpsNames,
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
  onFavoriteItem,
  onRenameItem,
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

  // État des réglages du tableau — local pour l'instant ; le branchement au
  // backend le déplacera dans l'état du projet quand la persistance arrivera.
  const [localTableSettings, setLocalTableSettings] = useState<TimelineTableSettingsState>(
    DEFAULT_TIMELINE_TABLE_SETTINGS,
  );
  const resolvedTableSettings = tableSettings ?? localTableSettings;
  const handleChangeTableSettings = onChangeTableSettings ?? setLocalTableSettings;

  // Filtres locaux (tableau et timeline) : non-null = override propre à la
  // feuille de route ; null = synchronisé sur les filtres globaux du haut.
  const [localFilters, setLocalFilters] = useState<TimelineFilterState | null>(null);
  const effectiveFilters = useMemo<TimelineFilterState>(() => {
    return localFilters ?? globalFilters ?? DEFAULT_TIMELINE_FILTER;
  }, [localFilters, globalFilters]);

  // Le global reprend la main : toucher aux filtres du haut abandonne
  // l'override (ajustement d'état pendant le rendu, sans effet en cascade).
  const [lastGlobalFilters, setLastGlobalFilters] = useState(globalFilters);
  if (!sameTimelineFilters(lastGlobalFilters, globalFilters)) {
    setLastGlobalFilters(globalFilters);
    setLocalFilters(null);
  }

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

  // L'édition de l'agenda n'existe que dans sa vue.
  if (view !== 'timeline' && timelineEditOpen) setTimelineEditOpen(false);

  // En plein écran, la vue affichée ouvre ses réglages (à l'entrée et à chaque
  // changement de vue).
  const fullscreenView = isFullscreen ? view : null;
  const [settingsOpenedFor, setSettingsOpenedFor] = useState<typeof fullscreenView>(null);
  if (settingsOpenedFor !== fullscreenView) {
    setSettingsOpenedFor(fullscreenView);
    if (fullscreenView === 'timeline') setTimelineEditOpen(true);
    else if (fullscreenView === 'sheet') setSheetSettingsOpen(true);
  }

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

  const deduplicatedItems = useMemo(() => {
    const seenPoiOsmIds = new Set<string | number>();
    return items.filter((item) => {
      if (item.kind !== 'poi') return true;
      const key = item.osmId ?? item.id;
      if (seenPoiOsmIds.has(key)) return false;
      seenPoiOsmIds.add(key);
      return true;
    });
  }, [items]);

  const intervalPauseSheetItems = useMemo(() => {
    if (view !== 'sheet' || !rhythm?.pauseEveryIntervalEnabled) return [];

    const reference = parseStartReference(rhythm);
    const { autoPauses } = buildScheduledTimelineState(deduplicatedItems, prediction, reference, rhythm);

    return autoPauses
      .filter((pause) => pause.source === 'interval' && pause.visible !== false)
      .map((pause) => ({
        id: pause.id,
        kind: 'pause' as const,
        label: pause.label,
        distanceKm: pause.distanceKm,
        durationMin: pause.durationMin,
        favorite: true,
        visible: pause.visible,
        autoGenerated: 'intervalPause' as const,
      }));
  }, [deduplicatedItems, prediction, rhythm, view]);

  const visibleSheetItems = useMemo(() => {
    const picks = poiAutoSortPicks ? indexPoiAutoSortPicks(poiAutoSortPicks) : null;
    return buildSheetItemsWithIntervalPauses(deduplicatedItems, intervalPauseSheetItems)
      .filter((item) => matchesTimelineFilter(item, 'sheet', effectiveFilters))
      .filter((item) => !picks || keepsTimelineItemWithPoiAutoSort(item, picks));
  }, [deduplicatedItems, effectiveFilters, intervalPauseSheetItems, poiAutoSortPicks]);

  // La vue timeline reçoit TOUS les items (le planning compte chaque pause) et
  // n'affiche que ceux-ci : filtrer avant le calcul décalait les heures.
  const visibleTimelineIds = useMemo<ReadonlySet<string>>(
    () => new Set(
      deduplicatedItems
        .filter((item) => matchesTimelineFilter(item, 'timeline', effectiveFilters))
        .map((item) => item.id),
    ),
    [deduplicatedItems, effectiveFilters],
  );

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
            isFiltersOverridden={localFilters !== null}
            markerStepKm={timelineMarkerStepKm}
            zoomLevel={timelineZoomLevel}
            onChangeFilters={setLocalFilters}
            onResetFilters={() => setLocalFilters(null)}
            onChangeMarkerStepKm={setTimelineMarkerStepKm}
            onChangeZoomLevel={setTimelineZoomLevel}
          />
        ) : null}

        {showSheetTopbar ? (
          <TimelineFilterBar
            filters={effectiveFilters}
            isOverridden={localFilters !== null}
            onChangeFilters={setLocalFilters}
            onResetToGlobal={() => setLocalFilters(null)}
            title={t('Filtres du tableau')}
            ariaLabel={t('Filtres de la feuille de route')}
          />
        ) : null}
      </div>

      <div className="rvi-timeline__body">
        {view === 'sheet' ? (
          <>
            <TimelineTableSettings
              discipline={discipline}
              value={resolvedTableSettings}
              onChange={handleChangeTableSettings}
            />
            <hr className="rvi-tl-divider" aria-hidden />
            <TimelineSheetView
              items={visibleSheetItems}
              rhythm={rhythm}
              prediction={prediction}
              discipline={discipline}
              gpsNames={gpsNames}
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
              onRename={onRenameItem}
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
            items={deduplicatedItems}
            visibleIds={visibleTimelineIds}
            rhythm={rhythm}
            prediction={prediction}
            config={railConfig}
            filters={effectiveFilters}
            markerStepKm={timelineMarkerStepKm}
            hourZoom={timelineZoomLevel}
            onHourZoomChange={setTimelineZoomLevel}
            selectedIds={selectedIds}
            onSelectRow={onSelectRow}
            onToggleSelect={handleToggleSelect}
            onToggleVisibility={onToggleItem}
            onMovePause={onMovePause}
            onChangePauseDuration={onChangePauseDuration}
            onChangeIntervalPauseDuration={onChangeIntervalPauseDuration}
            onRegisterPauseInsertionResolver={(resolver) => {
              pauseInsertionResolverRef.current = resolver;
            }}
            onToggleFavorite={onFavoriteItem}
            onRename={onRenameItem}
            onRemove={onRemoveItem}
          />
        )}
      </div>

      <TimelineKindMenu
        anchorEl={addMenuAnchor}
        open={!!addMenuAnchor}
        options={TIMELINE_ADD_MENU_OPTIONS}
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
