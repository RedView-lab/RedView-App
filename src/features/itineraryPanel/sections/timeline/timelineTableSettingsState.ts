/** Réglages du tableau de la feuille de route (TimelineTableSettings). */
import { TIMELINE_COLUMNS, type TimelineColumnId } from './TimelineColumns';

const DEFAULT_SHEET_COLUMN_IDS = [
  'typePicto',
  'typeText',
  'name',
  'distance',
] as const satisfies ReadonlyArray<TimelineColumnId>;
const DEFAULT_SHEET_COLUMN_ID_SET: ReadonlySet<TimelineColumnId> = new Set(DEFAULT_SHEET_COLUMN_IDS);

function buildDefaultColumnVisibility(): Record<TimelineColumnId, boolean> {
  return Object.fromEntries(
    TIMELINE_COLUMNS.map((column) => [
      column.id,
      DEFAULT_SHEET_COLUMN_ID_SET.has(column.id),
    ]),
  ) as Record<TimelineColumnId, boolean>;
}

export interface TimelineTableSortState {
  columnId: TimelineColumnId;
  direction: 'asc' | 'desc';
}

export interface TimelineTableSettingsState {
  /** When true, route is sliced into segments every `distanceKm`. */
  distanceBetweenWaypoints: boolean;
  /** Distance between auto-waypoints, in km. Default 10. */
  distanceKm: number;
  /** Per-column visibility map. */
  columns: Record<TimelineColumnId, boolean>;
  /** Current sort, or null for source order. */
  sort: TimelineTableSortState | null;
}

export const DEFAULT_TIMELINE_TABLE_SETTINGS: TimelineTableSettingsState = {
  distanceBetweenWaypoints: false,
  distanceKm: 10,
  columns: buildDefaultColumnVisibility(),
  sort: { columnId: 'distance', direction: 'asc' },
};
