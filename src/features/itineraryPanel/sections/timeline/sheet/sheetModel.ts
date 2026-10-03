import type { TimelineItem } from '../../../types';
import type {
  TimelineColumnAlign,
  TimelineColumnContext,
  TimelineColumnDef,
  TimelineColumnId,
} from '../TimelineColumns';
import type { TimelineTableSortState } from '../TimelineTableSettings';

/** Lignes, tri et gabarit de grille de la feuille de route. */

export interface PreparedRow {
  item: TimelineItem;
  ctx: TimelineColumnContext;
  cells: Array<{ display: string; sortKey: number | string | null }>;
}

export const DEFAULT_SHEET_COLUMN_IDS = [
  'typePicto',
  'typeText',
  'name',
  'distance',
] as const satisfies ReadonlyArray<TimelineColumnId>;
export const DEFAULT_SHEET_COLUMN_ID_SET: ReadonlySet<TimelineColumnId> = new Set(DEFAULT_SHEET_COLUMN_IDS);

export const ALIGN_CLASS: Record<TimelineColumnAlign, string> = {
  left: 'rvi-tl-th--left',
  right: 'rvi-tl-th--right',
  center: 'rvi-tl-th--center',
};
export const CELL_ALIGN_CLASS: Record<TimelineColumnAlign, string> = {
  left: 'rvi-tl-td--left',
  right: 'rvi-tl-td--right',
  center: 'rvi-tl-td--center',
};

export function cycleSort(
  current: TimelineTableSortState | null,
  columnId: TimelineColumnId,
): TimelineTableSortState | null {
  if (!current || current.columnId !== columnId) {
    return { columnId, direction: 'asc' };
  }
  if (current.direction === 'asc') return { columnId, direction: 'desc' };
  return null;
}

export function compareSortKeys(
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

export function buildGridTemplate(
  cols: TimelineColumnDef[],
  widths: Partial<Record<TimelineColumnId, number>> = {},
): string {
  // Sticky check (left) + N data columns + sticky actions (right).
  const middle = cols
    .map((c) => {
      const customW = widths[c.id];
      if (typeof customW === 'number' && customW > 0) {
        return `${Math.max(c.minWidth, customW)}px`;
      }
      const initialW = c.defaultWidth ?? c.minWidth;
      return `${initialW}px`;
    })
    .join(' ');
  return `28px ${middle} 72px`;
}

export interface RenderCellExtras {
  onSelectPlace?: (
    id: string,
    place: { name: string; fullName: string; lat: number; lon: number },
  ) => void;
  onMovePause?: (id: string, distanceKm: number) => void;
  onChangePauseDuration?: (id: string, durationMin: number) => void;
  onChangeIntervalPauseDuration?: (pauseIntervalId: string, durationMin: number) => void;
  maxDistanceKm?: number;
  t: (key: string) => string;
}

/** Id de l'intervalle d'une pause automatique (`<intervalId>::<n>`), sinon null. */
export function resolveIntervalPauseId(pauseId: string): string | null {
  const separatorIndex = pauseId.indexOf('::');
  if (separatorIndex <= 0) return null;
  return pauseId.slice(0, separatorIndex);
}
