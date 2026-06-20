/**
 * "Tableau" section of the Feuille de route — Figma node 855:22688.
 *
 * Renders a single horizontal control bar:
 *   Points de passages automatiques  [10 km ▾]   ⊕ Ajouter des colonnes ▾
 *
 * Like the filters above, the component is fully controlled. Inputs live
 * in the parent (or in the ItineraryPanelContainer once wired) so we can
 * persist user preferences alongside the rest of the project state.
 */
import { useState, type MouseEvent } from 'react';
import { IconChevronDown, IconPlusCircle } from '../../components/icons';
import { useAppI18n } from '@/shared/i18n';
import {
  TIMELINE_COLUMNS,
  type TimelineColumnId,
} from './TimelineColumns';
import { TimelineColumnsMenu } from './TimelineColumnsMenu.tsx';

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
  sort: null,
};

interface TimelineTableSettingsProps {
  value?: TimelineTableSettingsState;
  onChange?: (next: TimelineTableSettingsState) => void;
}

export function TimelineTableSettings({
  value = DEFAULT_TIMELINE_TABLE_SETTINGS,
  onChange,
}: TimelineTableSettingsProps) {
  const { t } = useAppI18n();
  const [triggerEl, setTriggerEl] = useState<HTMLButtonElement | null>(null);
  const [menuOpen, setMenuOpen] = useState(false);

  const setField = <K extends keyof TimelineTableSettingsState>(
    key: K,
    next: TimelineTableSettingsState[K],
  ) => {
    onChange?.({ ...value, [key]: next });
  };

  const handleToggleColumn = (id: TimelineColumnId, on: boolean) => {
    const nextColumns: Record<TimelineColumnId, boolean> = {
      ...value.columns,
      [id]: on,
    };
    // If the user hid the column currently being sorted, drop the sort.
    let nextSort = value.sort;
    if (!on && value.sort?.columnId === id) nextSort = null;
    onChange?.({ ...value, columns: nextColumns, sort: nextSort });
  };

  const handleOpenMenu = (event: MouseEvent<HTMLButtonElement>) => {
    event.preventDefault();
    setMenuOpen((cur) => !cur);
  };

  return (
    <div className="rvi-tl-table" aria-label="Tableau">
      <div className="rvi-tl-table__bar">
        <div className={`rvi-tl-table__auto${value.distanceBetweenWaypoints ? ' is-on' : ''}`}>
          <span className="rvi-tl-table__auto-label">
            {t('Points de passages automatiques')}
          </span>
          <span className="rvi-tl-table__auto-value">
            <button
              type="button"
              className="rvi-tl-table__auto-value-btn"
              onClick={() => setField('distanceBetweenWaypoints', !value.distanceBetweenWaypoints)}
              aria-pressed={value.distanceBetweenWaypoints}
              aria-label={t('Distance entre waypoints (km)')}
            >
              <span>{value.distanceKm} km</span>
              <IconChevronDown size={20} />
            </button>
          </span>
        </div>

        <button
          ref={setTriggerEl}
          type="button"
          className="rvi-tl-table__columns"
          onClick={handleOpenMenu}
          aria-haspopup="menu"
          aria-expanded={menuOpen}
        >
          <IconPlusCircle size={16} />
          <span>{t('Ajouter des colonnes')}</span>
          <IconChevronDown size={14} />
        </button>
      </div>

      <TimelineColumnsMenu
        anchorEl={triggerEl}
        open={menuOpen}
        columns={TIMELINE_COLUMNS}
        visibility={value.columns}
        onToggle={handleToggleColumn}
        onClose={() => setMenuOpen(false)}
      />
    </div>
  );
}
