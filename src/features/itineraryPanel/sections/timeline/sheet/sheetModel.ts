import type { TimelineItem } from '../../../types';
import type {
  TimelineColumnAlign,
  TimelineColumnContext,
  TimelineColumnDef,
  TimelineColumnId,
} from '../TimelineColumns';
import type { TimelineTableSortState } from '../timelineTableSettingsState';

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
  // Toujours repousser les null à la fin, quel que soit le sens.
  if (a == null && b == null) return 0;
  if (a == null) return 1;
  if (b == null) return -1;
  let cmp: number;
  if (typeof a === 'number' && typeof b === 'number') cmp = a - b;
  else cmp = String(a).localeCompare(String(b));
  return direction === 'asc' ? cmp : -cmp;
}

const ACTIONS_COLUMN_WIDTH_PX = 3 * 24 + 2 * 2 + 2 * 4;

export function buildGridTemplate(
  cols: TimelineColumnDef[],
  widths: Partial<Record<TimelineColumnId, number>> = {},
): string {
  // Case collante (gauche) + N colonnes de données + bourrage + actions collantes (droite).
  // Le bourrage prend la largeur que laissent les colonnes (panneau large, plein
  // écran) : chaque ligne couvre le tableau, actions sur son bord droit comme dans
  // la vue liste. Il retombe à 0 dès que les colonnes débordent (défilement horizontal).
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
  // Actions : 3 boutons de 24 px (cible minimale WCAG 2.2) + écarts et marges ;
  // à 72 px, ils étaient écrasés à 16 px.
  return `28px ${middle} minmax(0, 1fr) ${ACTIONS_COLUMN_WIDTH_PX}px`;
}

export interface RenderCellExtras {
  onSelectPlace?: (
    id: string,
    place: { name: string; fullName: string; lat: number; lon: number },
  ) => void;
  onMovePause?: (id: string, distanceKm: number) => void;
  onChangePauseDuration?: (id: string, durationMin: number) => void;
  onChangeIntervalPauseDuration?: (pauseIntervalId: string, durationMin: number) => void;
  /** Nom saisi dans la colonne « Nom » d'un POI. */
  onRename?: (id: string, label: string) => void;
  maxDistanceKm?: number;
  t: (key: string, vars?: Record<string, string | number>) => string;
}

/** Id de l'intervalle d'une pause automatique (`<intervalId>::<n>`), sinon null. */
export function resolveIntervalPauseId(pauseId: string): string | null {
  const separatorIndex = pauseId.indexOf('::');
  if (separatorIndex <= 0) return null;
  return pauseId.slice(0, separatorIndex);
}
