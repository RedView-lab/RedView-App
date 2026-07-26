/**
 * "Feuille de route" — sortable tabular sheet layout.
 *
 * The table is column-driven (see TimelineColumns.ts):
 *   - Headers reflect the user's column-visibility settings;
 *   - Hovering a header reveals a sort icon; clicking cycles
 *     asc → desc → off;
 *   - Custom columns (type picto, type text, name) render bespoke cells
 *     because they embed React content (badges, place search, action menu).
 *
 * The component is fully stateless: selection / visibility / favorite /
 * sort all flow through callbacks.
 */
import { useMemo, type MouseEventHandler } from 'react';
import type { PredictionResult } from '@/features/fitPredictor';
import { useAppI18n } from '@/shared/i18n';
import type { RhythmState, TimelineItem } from '../../types';
import { IconEye, IconStar, IconTrash } from '../../components/icons';
import { KindBadge, kindLabel } from './KindBadge';
import { PlaceSearchInput } from './components';
import { TimelineRow } from './TimelineRow';
import { TimelineAddRow } from './TimelineAddRow';
import {
  TIMELINE_COLUMNS,
  buildTimelineColumnContext,
  type TimelineColumnAlign,
  type TimelineColumnContext,
  type TimelineColumnDef,
  type TimelineColumnId,
} from './TimelineColumns';
import type { TimelineTableSortState } from './TimelineTableSettings';
import {
  parseStartReference,
  resolveTotalDistanceM,
} from './TimelineTimelineView/utils';

interface TimelineSheetViewProps {
  items: TimelineItem[];
  rhythm?: RhythmState;
  prediction?: PredictionResult | null;
  columns: Record<TimelineColumnId, boolean>;
  sort: TimelineTableSortState | null;
  onChangeSort: (next: TimelineTableSortState | null) => void;
  selectedIds?: ReadonlySet<string>;
  onToggleSelect?: (id: string, selected: boolean) => void;
  onToggleVisibility?: (id: string, visible: boolean) => void;
  onToggleFavorite?: (id: string, favorite: boolean) => void;
  onRemove?: (id: string) => void;
  onAdd?: MouseEventHandler<HTMLButtonElement>;
  onOpenKindMenu?: MouseEventHandler<HTMLButtonElement>;
  onSelectPlace?: (
    id: string,
    place: { name: string; fullName: string; lat: number; lon: number },
  ) => void;
}

interface PreparedRow {
  item: TimelineItem;
  ctx: TimelineColumnContext;
  cells: Array<{ display: string; sortKey: number | string | null }>;
}

const DEFAULT_SHEET_COLUMN_IDS = [
  'typePicto',
  'typeText',
  'name',
  'distance',
] as const satisfies ReadonlyArray<TimelineColumnId>;
const DEFAULT_SHEET_COLUMN_ID_SET: ReadonlySet<TimelineColumnId> = new Set(DEFAULT_SHEET_COLUMN_IDS);

const ALIGN_CLASS: Record<TimelineColumnAlign, string> = {
  left: 'rvi-tl-th--left',
  right: 'rvi-tl-th--right',
  center: 'rvi-tl-th--center',
};
const CELL_ALIGN_CLASS: Record<TimelineColumnAlign, string> = {
  left: 'rvi-tl-td--left',
  right: 'rvi-tl-td--right',
  center: 'rvi-tl-td--center',
};

function cycleSort(
  current: TimelineTableSortState | null,
  columnId: TimelineColumnId,
): TimelineTableSortState | null {
  if (!current || current.columnId !== columnId) {
    return { columnId, direction: 'asc' };
  }
  if (current.direction === 'asc') return { columnId, direction: 'desc' };
  return null;
}

function compareSortKeys(
  a: number | string | null,
  b: number | string | null,
  direction: 'asc' | 'desc',
): number {
  // Always push nulls to the end, regardless of direction.
  if (a == null && b == null) return 0;
  if (a == null) return 1;
  if (b == null) return -1;
  let cmp: number;
  if (typeof a === 'number' && typeof b === 'number') cmp = a - b;
  else cmp = String(a).localeCompare(String(b));
  return direction === 'asc' ? cmp : -cmp;
}

export function TimelineSheetView({
  items,
  rhythm,
  prediction,
  columns,
  sort,
  onChangeSort,
  selectedIds,
  onToggleSelect,
  onToggleVisibility,
  onToggleFavorite,
  onRemove,
  onAdd,
  onOpenKindMenu,
  onSelectPlace,
}: TimelineSheetViewProps) {
  const { t } = useAppI18n();

  const useCompactListLayout = useMemo(
    () =>
      DEFAULT_SHEET_COLUMN_IDS.every((columnId) => columns[columnId] !== false)
      && Object.entries(columns).every(([columnId, isVisible]) =>
        !isVisible || DEFAULT_SHEET_COLUMN_ID_SET.has(columnId as TimelineColumnId),
      ),
    [columns],
  );

  const visibleColumns: TimelineColumnDef[] = useMemo(
    () => TIMELINE_COLUMNS.filter((c) => c.pinned || columns[c.id] !== false),
    [columns],
  );

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
      });
      const cells = visibleColumns.map((col) => col.getCell(ctx));
      return { item, ctx, cells };
    });
  }, [items, prediction, rhythm, visibleColumns]);

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

  if (useCompactListLayout) {
    const typeDirection = sort?.columnId === 'typeText' ? sort.direction : null;
    const distanceDirection = sort?.columnId === 'distance' ? sort.direction : null;

    return (
      <div className="rvi-tl-table-wrap" aria-label={t('Liste des étapes')}>
        <div className="rvi-tl-list" role="table">
          <div className="rvi-tl-list__header" role="row">
            <span className="rvi-tl-list__col-check" aria-hidden>
              <span className="rvi-tl-list__col-checkbox" />
            </span>

            <button
              type="button"
              role="columnheader"
              aria-sort={
                typeDirection === 'asc'
                  ? 'ascending'
                  : typeDirection === 'desc'
                    ? 'descending'
                    : 'none'
              }
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
              role="columnheader"
              aria-sort={
                distanceDirection === 'asc'
                  ? 'ascending'
                  : distanceDirection === 'desc'
                    ? 'descending'
                    : 'none'
              }
              className={`rvi-tl-list__sort rvi-tl-list__col-distance${distanceDirection ? ' is-sorted' : ''}`}
              onClick={() => handleHeaderClick('distance')}
              title={t('Distance')}
            >
              <span className="rvi-tl-list__sort-label">{t('Distance')}</span>
              <SortIcon direction={distanceDirection} />
            </button>

            <span className="rvi-tl-list__col-actions" aria-hidden>
              <span className="rvi-tl-header-icon-btn"><IconEye size={12.5} /></span>
              <span className="rvi-tl-header-icon-btn"><IconTrash size={12.5} /></span>
              <IconStar size={20} />
            </span>
          </div>

          <div className="rvi-tl-list__items">
            {sortedRows.map((row, rowIndex) => {
              const { item } = row;
              return (
                <div
                  key={item.id}
                  className="rvi-tl-list__item"
                  role="row"
                  style={{ animationDelay: `${Math.min(rowIndex * 18, 240)}ms` }}
                >
                  <TimelineRow
                    item={item}
                    selected={selectedIds?.has(item.id) === true}
                    onToggleSelect={onToggleSelect}
                    onToggleVisibility={onToggleVisibility}
                    onToggleFavorite={onToggleFavorite}
                    onRemove={onRemove}
                    onSelectPlace={onSelectPlace}
                  />
                </div>
              );
            })}
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
        style={{ gridTemplateColumns: buildGridTemplate(visibleColumns) }}
      >
        {/* ── Header row ─────────────────────────────────────────── */}
        <div className="rvi-tl-thead" role="row">
          <div className="rvi-tl-th rvi-tl-th--sticky-left rvi-tl-th--check" role="columnheader" aria-hidden>
            <span className="rvi-tl-th__checkbox" />
          </div>
          {visibleColumns.map((col) => {
            const isSorted = sort?.columnId === col.id;
            const dir = isSorted ? sort!.direction : null;
            return (
              <button
                key={col.id}
                type="button"
                role="columnheader"
                aria-sort={dir === 'asc' ? 'ascending' : dir === 'desc' ? 'descending' : 'none'}
                className={`rvi-tl-th ${ALIGN_CLASS[col.align]}${isSorted ? ' is-sorted' : ''}`}
                onClick={() => handleHeaderClick(col.id)}
                title={t(col.label)}
              >
                <span className="rvi-tl-th__label">{t(col.shortLabel ?? col.label)}</span>
                <SortIcon direction={dir} />
              </button>
            );
          })}
          <div className="rvi-tl-th rvi-tl-th--sticky-right rvi-tl-th--actions" role="columnheader" aria-hidden>
            <span className="rvi-tl-th__action-icon">
              <IconEye size={15} />
            </span>
            <span className="rvi-tl-th__action-icon">
              <IconTrash size={15} />
            </span>
            <span className="rvi-tl-th__action-icon">
              <IconStar size={20} />
            </span>
          </div>
        </div>

        {/* ── Body rows ──────────────────────────────────────────── */}
        {sortedRows.map((row, rowIndex) => {
          const { item } = row;
          const selected = selectedIds?.has(item.id) === true;
          const visible = item.visible !== false;
          const isAutoIntervalPause = item.autoGenerated === 'intervalPause';
          return (
            <div
              key={item.id}
              role="row"
              className={`rvi-tl-tr${selected ? ' is-selected' : ''}`}
              data-kind={item.kind}
              style={{ animationDelay: `${Math.min(rowIndex * 18, 240)}ms` }}
            >
              <div className="rvi-tl-td rvi-tl-td--sticky-left rvi-tl-td--check" role="cell">
                <label className="rvi-tl-td__check">
                  <input
                    type="checkbox"
                    checked={selected}
                    onChange={(e) => onToggleSelect?.(item.id, e.target.checked)}
                    aria-label={t('Sélectionner')}
                  />
                  <span className="rvi-tl-td__check-box" aria-hidden />
                </label>
              </div>

              {visibleColumns.map((col, colIndex) => (
                <div
                  key={col.id}
                  role="cell"
                  className={`rvi-tl-td ${CELL_ALIGN_CLASS[col.align]}`}
                >
                  {renderCell(col, row, colIndex, { onSelectPlace, t })}
                </div>
              ))}

              <div className="rvi-tl-td rvi-tl-td--sticky-right rvi-tl-td--actions" role="cell">
                <button
                  type="button"
                  className={`rvi-tl-tr__action${visible ? ' is-on' : ''}`}
                  onClick={() => {
                    if (isAutoIntervalPause) return;
                    onToggleVisibility?.(item.id, !visible);
                  }}
                  aria-label={visible ? t('Masquer') : t('Afficher')}
                  aria-pressed={visible}
                  disabled={isAutoIntervalPause}
                >
                  <IconEye size={15} />
                </button>
                <button
                  type="button"
                  className="rvi-tl-tr__action rvi-tl-tr__action--danger"
                  onClick={() => {
                    if (isAutoIntervalPause) return;
                    onRemove?.(item.id);
                  }}
                  aria-label={t('Supprimer')}
                  disabled={isAutoIntervalPause}
                >
                  <IconTrash size={15} />
                </button>
                <button
                  type="button"
                  className={`rvi-tl-tr__action rvi-tl-tr__action--star${item.favorite ? ' is-on is-fav' : ''}`}
                  onClick={() => {
                    if (isAutoIntervalPause) return;
                    onToggleFavorite?.(item.id, !item.favorite);
                  }}
                  aria-label={t('Favori')}
                  aria-pressed={!!item.favorite}
                  disabled={isAutoIntervalPause}
                >
                  <IconStar size={24} />
                </button>
              </div>
            </div>
          );
        })}
      </div>

      <TimelineAddRow onAdd={onAdd} onOpenKindMenu={onOpenKindMenu} />
    </div>
  );
}

function buildGridTemplate(cols: TimelineColumnDef[]): string {
  // Sticky check (left) + N data columns + sticky actions (right).
  const middle = cols
    .map((c) => {
      if (c.id === 'name') return `minmax(${c.minWidth}px, 1fr)`;
      return `minmax(${c.minWidth}px, max-content)`;
    })
    .join(' ');
  return `28px ${middle} 72px`;
}

function resolveSheetKindLabel(item: TimelineItem, t: (key: string) => string): string {
  if (item.kind === 'end') return t('Fin');
  return kindLabel(item.kind, item.poiCategory);
}

interface RenderCellExtras {
  onSelectPlace?: (
    id: string,
    place: { name: string; fullName: string; lat: number; lon: number },
  ) => void;
  t: (key: string) => string;
}

function renderCell(
  col: TimelineColumnDef,
  row: PreparedRow,
  cellIndex: number,
  extras: RenderCellExtras,
) {
  const { item } = row;
  const cell = row.cells[cellIndex]!;

  if (col.id === 'typePicto') {
    return <KindBadge kind={item.kind} poiCategory={item.poiCategory} />;
  }
  if (col.id === 'typeText') {
    const label = resolveSheetKindLabel(item, extras.t);
    return (
      <span className="rvi-tl-td__type-text" title={label}>
        {label}
      </span>
    );
  }
  if (col.id === 'name') {
    return renderNameCell(item, extras);
  }
  return <span className="rvi-tl-td__value">{cell.display}</span>;
}

function renderNameCell(item: TimelineItem, extras: RenderCellExtras) {
  const { t } = extras;
  const searchPlaceholder = t('Rechercher un lieu');
  const isPlaceholder =
    item.label === searchPlaceholder || item.label === 'Rechercher un lieu' || item.label.trim() === '';
  const isLocationRow =
    item.kind === 'start' || item.kind === 'end' || item.kind === 'waypoint';
  const useSearchInput = !!extras.onSelectPlace && isLocationRow;

  const isAutoIntervalPause = item.autoGenerated === 'intervalPause';
  const primaryLabel =
    item.kind === 'pause' && item.durationMin
      ? (isAutoIntervalPause ? `${item.label} · ${item.durationMin}min` : `${item.durationMin}min`)
      : item.label;

  if (useSearchInput) {
    return (
      <PlaceSearchInput
        value={isPlaceholder ? '' : item.label}
        onPick={(s) =>
          extras.onSelectPlace?.(item.id, {
            name: s.name,
            fullName: s.fullName,
            lat: s.lat,
            lon: s.lon,
          })
        }
        placeholder={searchPlaceholder}
      />
    );
  }
  return (
    <span
      className={`rvi-tl-td__name${isPlaceholder ? ' rvi-tl-td__name--placeholder' : ''}`}
      title={primaryLabel}
    >
      {primaryLabel}
    </span>
  );
}

interface SortIconProps {
  direction: 'asc' | 'desc' | null;
}

function SortIcon({ direction }: SortIconProps) {
  const cls = direction ? `rvi-tl-th__sort is-${direction}` : 'rvi-tl-th__sort';
  return (
    <span className={cls} aria-hidden>
      <svg width="10" height="12" viewBox="0 0 10 12" fill="none" xmlns="http://www.w3.org/2000/svg">
        <path
          d="M5 1.5 L5 10.5 M5 1.5 L2 4.5 M5 1.5 L8 4.5 M5 10.5 L2 7.5 M5 10.5 L8 7.5"
          stroke="currentColor"
          strokeWidth="1.25"
          strokeLinecap="round"
          strokeLinejoin="round"
        />
      </svg>
    </span>
  );
}
