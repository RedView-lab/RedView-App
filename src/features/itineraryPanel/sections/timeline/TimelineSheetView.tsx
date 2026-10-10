/**
 * « Feuille de route » — disposition en tableau triable.
 *
 * Le tableau est piloté par les colonnes (voir TimelineColumns.ts) :
 *   - les en-têtes reflètent les réglages de visibilité des colonnes de l'utilisateur ;
 *   - survoler un en-tête révèle une icône de tri ; cliquer fait tourner
 *     croissant → décroissant → désactivé ;
 *   - les colonnes personnalisées (picto de type, texte du type, nom) rendent des
 *     cellules sur mesure car elles embarquent du contenu React (badges,
 *     recherche de lieu, menu d'actions).
 *
 * Le composant est entièrement sans état : sélection / visibilité / favori / tri
 * passent tous par des rappels.
 */
import { useCallback, useMemo, type MouseEventHandler } from 'react';
import type { PredictionResult } from '@/features/fitPredictor';
import { useAppI18n } from '@/shared/i18n';
import type { SportDiscipline } from '@/shared/lib/discipline';
import type { RhythmState, TimelineItem } from '../../types';
import { IconNiceManYellow, IconStar, IconTrash } from '../../components/icons';
import { TimelineRow } from './TimelineRow';
import { TimelineAddRow } from './TimelineAddRow';
import { useVirtualRows } from './useVirtualRows';
import {
  buildTimelineColumnContext,
  resolveTimelineColumns,
  type TimelineColumnDef,
  type TimelineColumnId,
} from './TimelineColumns';
import type { TimelineTableSortState } from './timelineTableSettingsState';
import type { RouteWeatherDataset } from '@/features/weather';
import {
  parseStartReference,
  resolveTotalDistanceM,
} from './TimelineTimelineView/utils';
import {
  ALIGN_CLASS,
  buildGridTemplate,
  compareSortKeys,
  cycleSort,
  DEFAULT_SHEET_COLUMN_ID_SET,
  DEFAULT_SHEET_COLUMN_IDS,
  type PreparedRow,
  type RenderCellExtras,
} from './sheet/sheetModel';
import { SortIcon } from './sheet/SortIcon';
import { TimelineSheetGridRow } from './sheet/TimelineSheetGridRow';
import { useColumnWidths } from './sheet/useColumnWidths';
import { useGridOverflowEdges } from './sheet/useGridOverflowEdges';

interface TimelineSheetViewProps {
  items: TimelineItem[];
  rhythm?: RhythmState;
  prediction?: PredictionResult | null;
  discipline?: SportDiscipline;
  weatherDataset?: RouteWeatherDataset | null;
  /** Nom GPS de chaque ligne de POI (colonne « Nom GPS »), calculé seulement quand elle est affichée. */
  gpsNames?: ReadonlyMap<string, string> | null;
  columns: Record<TimelineColumnId, boolean>;
  sort: TimelineTableSortState | null;
  onChangeSort: (next: TimelineTableSortState | null) => void;
  selectedIds?: ReadonlySet<string>;
  onSelectRow?: (id: string, item: TimelineItem) => void;
  onToggleSelect?: (id: string, selected: boolean) => void;
  onToggleVisibility?: (id: string, visible: boolean) => void;
  onToggleFavorite?: (id: string, favorite: boolean) => void;
  /** Nom saisi dans la colonne « Nom » d'un POI. */
  onRename?: (id: string, label: string) => void;
  onRemove?: (id: string) => void;
  onAdd?: MouseEventHandler<HTMLButtonElement>;
  onOpenKindMenu?: MouseEventHandler<HTMLButtonElement>;
  onSelectPlace?: (
    id: string,
    place: { name: string; fullName: string; lat: number; lon: number },
  ) => void;
  onMovePause?: (id: string, distanceKm: number) => void;
  onChangePauseDuration?: (id: string, durationMin: number) => void;
  onChangeIntervalPauseDuration?: (pauseIntervalId: string, durationMin: number) => void;
}

export function TimelineSheetView({
  items,
  rhythm,
  prediction,
  discipline = 'bike',
  weatherDataset,
  gpsNames,
  columns,
  sort,
  onChangeSort,
  selectedIds,
  onSelectRow,
  onToggleSelect,
  onToggleVisibility,
  onToggleFavorite,
  onRename,
  onRemove,
  onAdd,
  onOpenKindMenu,
  onSelectPlace,
  onMovePause,
  onChangePauseDuration,
  onChangeIntervalPauseDuration,
}: TimelineSheetViewProps) {
  const { t } = useAppI18n();
  const { columnWidths, resizingColId, handleResizeStart, handleResetColWidth } = useColumnWidths();

  const useCompactListLayout = useMemo(
    () =>
      DEFAULT_SHEET_COLUMN_IDS.every((columnId) => columns[columnId] !== false)
      && Object.entries(columns).every(([columnId, isVisible]) =>
        !isVisible || DEFAULT_SHEET_COLUMN_ID_SET.has(columnId as TimelineColumnId),
      ),
    [columns],
  );

  const visibleColumns: TimelineColumnDef[] = useMemo(
    () => resolveTimelineColumns(discipline).filter((c) => c.pinned || columns[c.id] !== false),
    [columns, discipline],
  );

  const maxDistanceKm = useMemo(() => {
    const totalDistanceM = resolveTotalDistanceM(items, prediction ?? null);
    return totalDistanceM > 0 ? totalDistanceM / 1000 : undefined;
  }, [items, prediction]);

  const preparedRows: PreparedRow[] = useMemo(() => {
    const totalDistanceM = resolveTotalDistanceM(items, prediction ?? null);
    const reference = parseStartReference(rhythm);
    return items.map((item, index) => {
      const prevItem = index > 0 ? items[index - 1]! : null;
      const nextItem = index < items.length - 1 ? items[index + 1]! : null;
      const ctx = buildTimelineColumnContext({
        item,
        prevItem,
        nextItem,
        totalDistanceM,
        prediction: prediction ?? null,
        rhythm,
        reference,
        weatherDataset,
        discipline,
        gpsName: gpsNames?.get(item.id) ?? null,
      });
      const cells = visibleColumns.map((col) => col.getCell(ctx));
      return { item, ctx, cells };
    });
  }, [discipline, gpsNames, items, prediction, rhythm, visibleColumns, weatherDataset]);

  const sortedRows: PreparedRow[] = useMemo(() => {
    if (!sort) return preparedRows;
    const sortColIndex = visibleColumns.findIndex((c) => c.id === sort.columnId);
    if (sortColIndex < 0) return preparedRows;
    const next = preparedRows.slice();
    next.sort((a, b) =>
      compareSortKeys(a.cells[sortColIndex]!.sortKey, b.cells[sortColIndex]!.sortKey, sort.direction),
    );
    return next;
  }, [preparedRows, sort, visibleColumns]);

  const handleHeaderClick = (columnId: TimelineColumnId) => {
    onChangeSort(cycleSort(sort, columnId));
  };

  // Seules les lignes visibles sont montées (800+ lignes après une recherche POI).
  const rowKeys = useMemo(() => sortedRows.map((row) => row.item.id), [sortedRows]);
  const {
    attachRowsRoot,
    attachHeader,
    start: windowStart,
    end: windowEnd,
    topSpacerPx,
    bottomSpacerPx,
  } = useVirtualRows({ keys: rowKeys, estimateRowPx: 36, gapPx: 4 });
  const windowRows = sortedRows.slice(windowStart, windowEnd);
  const gridTemplate = buildGridTemplate(visibleColumns, columnWidths);
  const attachOverflowEdges = useGridOverflowEdges(gridTemplate);
  const attachGrid = useCallback((grid: HTMLDivElement | null) => {
    attachRowsRoot(grid);
    attachOverflowEdges(grid);
  }, [attachOverflowEdges, attachRowsRoot]);
  const cellExtras = useMemo<RenderCellExtras>(() => ({
    onSelectPlace,
    onMovePause,
    onChangePauseDuration,
    onChangeIntervalPauseDuration,
    onRename,
    maxDistanceKm,
    t,
  }), [maxDistanceKm, onChangeIntervalPauseDuration, onChangePauseDuration, onMovePause, onRename, onSelectPlace, t]);

  if (useCompactListLayout) {
    const typeDirection = sort?.columnId === 'typeText' ? sort.direction : null;
    const distanceDirection = sort?.columnId === 'distance' ? sort.direction : null;
    // Le sens du tri est lu dans le nom du bouton (libellé visible en tête).
    const sortButtonLabel = (label: string, direction: 'asc' | 'desc' | null) => (
      direction === 'asc'
        ? t('{{label}}, tri croissant', { label })
        : direction === 'desc'
          ? t('{{label}}, tri décroissant', { label })
          : label
    );

    return (
      <div className="rvi-tl-table-wrap" aria-label={t('Liste des étapes')}>
        {/* Liste (pas un tableau : chaque étape est une rangée flex, sans cellules). */}
        <div className="rvi-tl-list">
          <div className="rvi-tl-list__header" ref={attachHeader}>
            <span className="rvi-tl-list__col-check" aria-hidden>
              <span className="rvi-tl-list__col-checkbox" />
            </span>

            <button
              type="button"
              aria-label={sortButtonLabel(t('Type'), typeDirection)}
              className={`rvi-tl-list__sort rvi-tl-list__col-type${typeDirection ? ' is-sorted' : ''}`}
              onClick={() => handleHeaderClick('typeText')}
              title={t('Type')}
            >
              <span className="rvi-tl-list__sort-label">{t('Type')}</span>
              <SortIcon direction={typeDirection} />
            </button>

            <span className="rvi-tl-list__col-flex" aria-hidden />

            <button
              type="button"
              aria-label={sortButtonLabel(t('Distance'), distanceDirection)}
              className={`rvi-tl-list__sort rvi-tl-list__col-distance${distanceDirection ? ' is-sorted' : ''}`}
              onClick={() => handleHeaderClick('distance')}
              title={t('Distance')}
            >
              <span className="rvi-tl-list__sort-label">{t('Distance')}</span>
              <SortIcon direction={distanceDirection} />
            </button>

            <span className="rvi-tl-list__col-actions" aria-hidden>
              <span className="rvi-tl-header-icon-btn"><IconNiceManYellow size={15} /></span>
              <span className="rvi-tl-header-icon-btn"><IconTrash size={15} /></span>
              <span className="rvi-tl-header-icon-btn"><IconStar size={12} /></span>
            </span>
          </div>

          <div className="rvi-tl-list__items" role="list" ref={attachRowsRoot}>
            {topSpacerPx > 0 ? (
              <div aria-hidden style={{ height: topSpacerPx, flexShrink: 0 }} />
            ) : null}
            {windowRows.map((row, windowIndex) => {
              const { item } = row;
              const rowIndex = windowStart + windowIndex;
              return (
                <div
                  key={item.id}
                  className="rvi-tl-list__item"
                  data-timeline-id={item.id}
                  data-vrow={item.id}
                  role="listitem"
                  style={{ animationDelay: `${Math.min(rowIndex * 18, 240)}ms` }}
                >
                  <TimelineRow
                    item={item}
                    selected={selectedIds?.has(item.id) === true}
                    onToggleSelect={onToggleSelect}
                    onSelectRow={onSelectRow}
                    onToggleVisibility={onToggleVisibility}
                    onToggleFavorite={onToggleFavorite}
                    onRename={onRename}
                    onRemove={onRemove}
                    onSelectPlace={onSelectPlace}
                    onMovePause={onMovePause}
                    onChangePauseDuration={onChangePauseDuration}
                    onChangeIntervalPauseDuration={onChangeIntervalPauseDuration}
                    maxDistanceKm={maxDistanceKm}
                  />
                </div>
              );
            })}
            {bottomSpacerPx > 0 ? (
              <div aria-hidden style={{ height: bottomSpacerPx, flexShrink: 0 }} />
            ) : null}
          </div>
        </div>

        <TimelineAddRow onAdd={onAdd} onOpenKindMenu={onOpenKindMenu} />
      </div>
    );
  }

  return (
    <div className="rvi-tl-table-wrap" aria-label={t('Liste des étapes')}>
      <div
        className="rvi-tl-table-grid"
        role="table"
        ref={attachGrid}
        style={{ gridTemplateColumns: gridTemplate }}
      >
        {/* ── Ligne d'en-tête ────────────────────────────────────── */}
        <div className="rvi-tl-thead" role="row">
          <div
            className="rvi-tl-th rvi-tl-th--sticky-left rvi-tl-th--check"
            role="columnheader"
            aria-hidden
            ref={attachHeader}
          >
            <span className="rvi-tl-th__checkbox" />
          </div>
          {visibleColumns.map((col) => {
            const isSorted = sort?.columnId === col.id;
            const dir = isSorted ? sort!.direction : null;
            const isResizingThis = resizingColId === col.id;
            return (
              <div
                key={col.id}
                role="columnheader"
                tabIndex={0}
                aria-sort={dir === 'asc' ? 'ascending' : dir === 'desc' ? 'descending' : 'none'}
                className={`rvi-tl-th ${ALIGN_CLASS[col.align]}${isSorted ? ' is-sorted' : ''}${isResizingThis ? ' is-resizing' : ''}`}
                onClick={() => handleHeaderClick(col.id)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter' || e.key === ' ') {
                    e.preventDefault();
                    handleHeaderClick(col.id);
                  }
                }}
                title={t(col.label)}
              >
                <span className="rvi-tl-th__label">{t(col.shortLabel ?? col.label)}</span>
                <SortIcon direction={dir} />
                <span
                  className="rvi-tl-th__resizer"
                  role="separator"
                  aria-orientation="vertical"
                  title={t('Redimensionner la colonne (double-cliquez pour réinitialiser)')}
                  onMouseDown={(e) => handleResizeStart(col, e)}
                  onDoubleClick={(e) => handleResetColWidth(col, e)}
                  onClick={(e) => e.stopPropagation()}
                />
              </div>
            );
          })}
          <div className="rvi-tl-th rvi-tl-th--filler" aria-hidden />
          <div className="rvi-tl-th rvi-tl-th--sticky-right rvi-tl-th--actions" role="columnheader" aria-hidden>
            <span className="rvi-tl-th__action-icon">
              <IconNiceManYellow size={15} />
            </span>
            <span className="rvi-tl-th__action-icon">
              <IconTrash size={15} />
            </span>
            <span className="rvi-tl-th__action-icon">
              <IconStar size={10} />
            </span>
          </div>
        </div>

        {/* ── Lignes du corps ────────────────────────────────────── */}
        {topSpacerPx > 0 ? (
          <div aria-hidden style={{ gridColumn: '1 / -1', height: topSpacerPx }} />
        ) : null}
        {windowRows.map((row, windowIndex) => (
          <TimelineSheetGridRow
            key={row.item.id}
            row={row}
            rowIndex={windowStart + windowIndex}
            selected={selectedIds?.has(row.item.id) === true}
            visibleColumns={visibleColumns}
            cellExtras={cellExtras}
            onSelectRow={onSelectRow}
            onToggleSelect={onToggleSelect}
            onToggleVisibility={onToggleVisibility}
            onToggleFavorite={onToggleFavorite}
            onRemove={onRemove}
          />
        ))}
        {bottomSpacerPx > 0 ? (
          <div aria-hidden style={{ gridColumn: '1 / -1', height: bottomSpacerPx }} />
        ) : null}
      </div>

      <TimelineAddRow onAdd={onAdd} onOpenKindMenu={onOpenKindMenu} />
    </div>
  );
}
