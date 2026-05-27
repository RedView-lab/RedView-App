/**
 * "Tableau" section of the Feuille de route — Figma node 1694:18364.
 *
 * Renders the small "Tableau" eyebrow label followed by a row of inline
 * controls:
 *   ☑ Distance entre waypoints  [10 km]   ⊕ Colonnes ▾
 *
 * Like the filters above, the component is fully controlled. Inputs live
 * in the parent (or in the ItineraryPanelContainer once wired) so we can
 * persist user preferences alongside the rest of the project state.
 */
import { useState, type MouseEvent } from 'react';
import { IconChevronDown, IconPlusCircle } from '../../components/icons';
import { useAppI18n } from '@/shared/i18n';
import {
  DEFAULT_TIMELINE_COLUMN_VISIBILITY,
  TIMELINE_COLUMNS,
  type TimelineColumnId,
} from './TimelineColumns';
import { TimelineColumnsMenu } from './TimelineColumnsMenu.tsx';

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
  columns: { ...DEFAULT_TIMELINE_COLUMN_VISIBILITY },
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
      <span className="rvi-tl-table__label">{t('Tableau')}</span>

      <div className="rvi-tl-table__row">
        <label className="rvi-tl-table__check">
          <input
            type="checkbox"
            checked={value.distanceBetweenWaypoints}
            onChange={(e) => setField('distanceBetweenWaypoints', e.target.checked)}
          />
          <span className="rvi-tl-table__check-box" aria-hidden />
          <span className="rvi-tl-table__check-label">
            {t('Distance entre waypoints')}
          </span>
        </label>

        <span className="rvi-tl-table__field">
          <input
            type="number"
            min={1}
            step={1}
            value={value.distanceKm}
            onChange={(e) => setField('distanceKm', Math.max(1, Number(e.target.value) || 1))}
            disabled={!value.distanceBetweenWaypoints}
            aria-label={t('Distance entre waypoints (km)')}
          />
          <span className="rvi-tl-table__field-suffix">km</span>
        </span>

        <button
          ref={setTriggerEl}
          type="button"
          className="rvi-tl-table__columns"
          onClick={handleOpenMenu}
          aria-haspopup="menu"
          aria-expanded={menuOpen}
        >
          <IconPlusCircle size={14} />
          <span>{t('Colonnes')}</span>
          <IconChevronDown size={12} />
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
