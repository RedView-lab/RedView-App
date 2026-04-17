import { CheckboxField } from '../components/PanelCheckbox';
import { ToggleRow } from '../components/PanelToggle';
import {
  IconChevronDown,
  IconDownloadCircle,
  IconPlusCircle,
} from '../components/icons';
import type { PoiCategory, PoiEntry, PoiState } from '../types';

interface PoiSectionProps {
  poi: PoiState;
  onChangeEntry?: (category: PoiCategory, next: PoiEntry) => void;
  onChangeRefine?: (value: boolean) => void;
  onOpenCategories?: () => void;
  onLoad?: () => void;
  /** Map-level POI loading state. */
  loading?: boolean;
  /** Number of POIs currently rendered on the map (0 when none). */
  poiCount?: number;
  /** Last error from the POI engine (Overpass / network). */
  error?: string | null;
  /**
   * When true, the "Charger" button is greyed out — typically because no
   * GPX route is attached to the active itinerary or no category is on.
   */
  disabled?: boolean;
  /** Optional helper text shown when the button is disabled. */
  disabledReason?: string | null;
}

const POI_ROWS: { key: PoiCategory; label: string }[][] = [
  [
    { key: 'fountains', label: 'Fontaines' },
    { key: 'bakeries', label: 'Boulangeries' },
  ],
  [
    { key: 'supermarkets', label: 'Supermarchés' },
    { key: 'restaurants', label: 'Restaurants' },
  ],
  [
    { key: 'hotels', label: 'Hôtels' },
    { key: 'refuges', label: 'Refuges' },
  ],
  [
    { key: 'bars', label: 'Bar' },
    { key: 'passes', label: 'Cols' },
  ],
];

/** Parses a `"40m"`-style string into a positive integer or null. */
function parseDistance(raw: string): number | null {
  const n = parseInt(raw, 10);
  if (!Number.isFinite(n) || n < 0) return null;
  return n;
}

function DistanceInput({
  value,
  onChange,
  ariaLabel,
}: {
  value: number | null;
  onChange?: (next: number | null) => void;
  ariaLabel?: string;
}) {
  return (
    <div className="rvi-chip-input">
      <input
        className="rvi-chip-input__native"
        value={value !== null ? `${value}m` : ''}
        onChange={(e) => onChange?.(parseDistance(e.target.value))}
        placeholder="40m"
        aria-label={ariaLabel}
      />
    </div>
  );
}

export function PoiSection({
  poi,
  onChangeEntry,
  onChangeRefine,
  onOpenCategories,
  onLoad,
  loading = false,
  poiCount = 0,
  error = null,
  disabled = false,
  disabledReason = null,
}: PoiSectionProps) {
  const buttonDisabled = disabled || loading;
  const buttonLabel = loading
    ? 'Recherche…'
    : poiCount > 0
      ? `Recharger (${poiCount})`
      : 'Charger';

  return (
    <div className="rvi-params">
      <div className="rvi-divider" />

      {POI_ROWS.map((row) => (
        <div key={row.map((c) => c.key).join('-')} className="rvi-row">
          {row.map((cell) => {
            const entry = poi[cell.key];
            return (
              <CheckboxField
                key={cell.key}
                checked={entry.enabled}
                onToggle={(v) =>
                  onChangeEntry?.(cell.key, {
                    ...entry,
                    enabled: v,
                    distanceM: v ? entry.distanceM ?? 40 : entry.distanceM,
                  })
                }
                label={cell.label}
                trailing={
                  <DistanceInput
                    value={entry.distanceM}
                    onChange={(dist) =>
                      onChangeEntry?.(cell.key, { ...entry, distanceM: dist })
                    }
                    ariaLabel={`Distance ${cell.label}`}
                  />
                }
              />
            );
          })}
        </div>
      ))}

      <div className="rvi-row rvi-poi-refine">
        <div className="rvi-poi-refine__toggle">
          <ToggleRow
            checked={poi.refineResults}
            onChange={(v) => onChangeRefine?.(v)}
            label="Affiner les résultats (beta)"
          />
        </div>
        <button
          type="button"
          className="rvi-categories-btn"
          onClick={onOpenCategories}
        >
          <IconPlusCircle size={16} />
          <span className="rvi-categories-btn__label">Catégories</span>
          <IconChevronDown size={14} className="rvi-categories-btn__chevron" />
        </button>
      </div>

      <button
        type="button"
        className={`rvi-redbtn rvi-redbtn--full${buttonDisabled ? ' is-disabled' : ''}`}
        onClick={onLoad}
        disabled={buttonDisabled}
        aria-busy={loading}
      >
        <IconDownloadCircle size={16} />
        <span>{buttonLabel}</span>
      </button>

      {error ? (
        <div className="rvi-poi-msg rvi-poi-msg--error" role="alert">
          {error}
        </div>
      ) : disabled && disabledReason ? (
        <div className="rvi-poi-msg rvi-poi-msg--hint">{disabledReason}</div>
      ) : null}
    </div>
  );
}
import { CheckboxField } from '../components/PanelCheckbox';
import { ToggleRow } from '../components/PanelToggle';
import {
  IconChevronDown,
  IconDownloadCircle,
  IconPlusCircle,
} from '../components/icons';
import type { PoiCategory, PoiEntry, PoiState } from '../types';

interface PoiSectionProps {
  poi: PoiState;
  onChangeEntry?: (category: PoiCategory, next: PoiEntry) => void;
  onChangeRefine?: (value: boolean) => void;
  onOpenCategories?: () => void;
  onLoad?: () => void;
}

const POI_ROWS: { key: PoiCategory; label: string }[][] = [
  [
    { key: 'fountains', label: 'Fontaines' },
    { key: 'bakeries', label: 'Boulangeries' },
  ],
  [
    { key: 'supermarkets', label: 'Supermarchés' },
    { key: 'restaurants', label: 'Restaurants' },
  ],
  [
    { key: 'hotels', label: 'Hôtels' },
    { key: 'refuges', label: 'Refuges' },
  ],
  [
    { key: 'bars', label: 'Bar' },
    { key: 'passes', label: 'Cols' },
  ],
];

/** Parses a `"40m"`-style string into a positive integer or null. */
function parseDistance(raw: string): number | null {
  const n = parseInt(raw, 10);
  if (!Number.isFinite(n) || n < 0) return null;
  return n;
}

function DistanceInput({
  value,
  onChange,
  ariaLabel,
}: {
  value: number | null;
  onChange?: (next: number | null) => void;
  ariaLabel?: string;
}) {
  return (
    <div className="rvi-chip-input">
      <input
        className="rvi-chip-input__native"
        value={value !== null ? `${value}m` : ''}
        onChange={(e) => onChange?.(parseDistance(e.target.value))}
        placeholder="40m"
        aria-label={ariaLabel}
      />
    </div>
  );
}

export function PoiSection({
  poi,
  onChangeEntry,
  onChangeRefine,
  onOpenCategories,
  onLoad,
}: PoiSectionProps) {
  return (
    <div className="rvi-params">
      <div className="rvi-divider" />

      {POI_ROWS.map((row) => (
        <div key={row.map((c) => c.key).join('-')} className="rvi-row">
          {row.map((cell) => {
            const entry = poi[cell.key];
            return (
              <CheckboxField
                key={cell.key}
                checked={entry.enabled}
                onToggle={(v) =>
                  onChangeEntry?.(cell.key, {
                    ...entry,
                    enabled: v,
                    distanceM: v ? entry.distanceM ?? 40 : entry.distanceM,
                  })
                }
                label={cell.label}
                trailing={
                  <DistanceInput
                    value={entry.distanceM}
                    onChange={(dist) =>
                      onChangeEntry?.(cell.key, { ...entry, distanceM: dist })
                    }
                    ariaLabel={`Distance ${cell.label}`}
                  />
                }
              />
            );
          })}
        </div>
      ))}

      <div className="rvi-row rvi-poi-refine">
        <div className="rvi-poi-refine__toggle">
          <ToggleRow
            checked={poi.refineResults}
            onChange={(v) => onChangeRefine?.(v)}
            label="Affiner les résultats (beta)"
          />
        </div>
        <button
          type="button"
          className="rvi-categories-btn"
          onClick={onOpenCategories}
        >
          <IconPlusCircle size={16} />
          <span className="rvi-categories-btn__label">Catégories</span>
          <IconChevronDown size={14} className="rvi-categories-btn__chevron" />
        </button>
      </div>

      <button
        type="button"
        className="rvi-redbtn rvi-redbtn--full"
        onClick={onLoad}
      >
        <IconDownloadCircle size={16} />
        <span>Charger</span>
      </button>
    </div>
  );
}
