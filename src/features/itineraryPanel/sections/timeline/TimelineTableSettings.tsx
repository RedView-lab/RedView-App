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
import { IconChevronDown, IconPlusCircle } from '../../components/icons';

export interface TimelineTableSettingsState {
  /** When true, route is sliced into segments every `distanceKm`. */
  distanceBetweenWaypoints: boolean;
  /** Distance between auto-waypoints, in km. Default 10. */
  distanceKm: number;
}

export const DEFAULT_TIMELINE_TABLE_SETTINGS: TimelineTableSettingsState = {
  distanceBetweenWaypoints: false,
  distanceKm: 10,
};

interface TimelineTableSettingsProps {
  value?: TimelineTableSettingsState;
  onChange?: (next: TimelineTableSettingsState) => void;
  onOpenColumns?: () => void;
}

export function TimelineTableSettings({
  value = DEFAULT_TIMELINE_TABLE_SETTINGS,
  onChange,
  onOpenColumns,
}: TimelineTableSettingsProps) {
  const setField = <K extends keyof TimelineTableSettingsState>(
    key: K,
    next: TimelineTableSettingsState[K],
  ) => {
    onChange?.({ ...value, [key]: next });
  };

  return (
    <div className="rvi-tl-table" aria-label="Tableau">
      <span className="rvi-tl-table__label">Tableau</span>

      <div className="rvi-tl-table__row">
        <label className="rvi-tl-table__check">
          <input
            type="checkbox"
            checked={value.distanceBetweenWaypoints}
            onChange={(e) => setField('distanceBetweenWaypoints', e.target.checked)}
          />
          <span className="rvi-tl-table__check-box" aria-hidden />
          <span className="rvi-tl-table__check-label">
            Distance entre waypoints
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
            aria-label="Distance entre waypoints (km)"
          />
          <span className="rvi-tl-table__field-suffix">km</span>
        </span>

        <button
          type="button"
          className="rvi-tl-table__columns"
          onClick={onOpenColumns}
        >
          <IconPlusCircle size={14} />
          <span>Colonnes</span>
          <IconChevronDown size={12} />
        </button>
      </div>
    </div>
  );
}
