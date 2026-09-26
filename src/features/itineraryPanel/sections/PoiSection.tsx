import { ActionButtonStack, CheckboxField } from '../components/controls';
import { useAppI18n } from '@/shared/i18n';

import type { PoiCategory, PoiEntry, PoiState } from '../types';

interface PoiSectionProps {
  poi?: PoiState | null;
  onChangeEntry?: (category: PoiCategory, next: PoiEntry) => void;
  onLoad?: () => void;
  onCancelLoad?: () => void;
  /** Map-level POI loading state. */
  loading?: boolean;
  /** 0..1 progress of the corridor search (chunks completed / total). */
  progress?: number | null;
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
    { key: 'toilets', label: 'Toilettes' },
  ],
  [
    { key: 'supermarkets', label: 'Supermarchés' },
    { key: 'gasStations', label: 'Station Service' },
  ],
  [
    { key: 'bakeries', label: 'Boulangerie' },
    { key: 'fastFood', label: 'Fast-food' },
  ],
  [
    { key: 'cafes', label: 'Café' },
    { key: 'bars', label: 'Bar' },
  ],
  [
    { key: 'restaurants', label: 'Restaurant' },
    { key: 'bikeShops', label: 'Magasin de vélo' },
  ],
  [
    { key: 'hotels', label: 'Hôtels' },
    { key: 'refuges', label: 'Refuges' },
  ],
  [
    { key: 'health', label: 'Santé' },
    { key: 'transport', label: 'Transport' },
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
  onLoad,
  onCancelLoad,
  loading = false,
  progress = null,
  poiCount = 0,
  error = null,
  disabled = false,
  disabledReason = null,
}: PoiSectionProps) {
  const { t } = useAppI18n();
  const pct =
    progress !== null && Number.isFinite(progress)
      ? Math.max(0, Math.min(100, Math.round(progress * 100)))
      : null;
  const loadingLabel = loading
    ? pct !== null
      ? `${pct}%`
      : t('Recherche…')
    : null;
  const resultLabel = poiCount > 0 ? t('({{count}} POI trouvés)', { count: poiCount }) : null;

  return (
    <div className="rvi-params rvi-params--poi">
      <div className="rvi-divider" />

      {POI_ROWS.map((row) => (
        <div key={row.map((c) => c.key).join('-')} className="rvi-row">
          {row.map((cell) => {
            const entry = poi?.[cell.key] ?? { enabled: false, distanceM: 40 };
            return (
              <CheckboxField
                key={cell.key}
                checked={Boolean(entry.enabled)}
                onToggle={(v) =>
                  onChangeEntry?.(cell.key, {
                    ...entry,
                    enabled: v,
                    distanceM: v ? (entry.distanceM ?? 40) : entry.distanceM,
                  })
                }
                label={cell.label}
                trailing={
                  <DistanceInput
                    value={entry.distanceM ?? null}
                    onChange={(dist) =>
                      onChangeEntry?.(cell.key, { ...entry, distanceM: dist })
                    }
                    ariaLabel={t('Distance {{label}}', { label: t(cell.label) })}
                  />
                }
              />
            );
          })}
        </div>
      ))}

      <ActionButtonStack
        primaryLabel={t('Charger')}
        onPrimaryClick={onLoad}
        primaryDisabled={disabled}
        loadingLabel={loadingLabel}
        onLoadingClick={onCancelLoad}
        resultLabel={resultLabel}
      />

      {error ? (
        <div className="rvi-poi-msg rvi-poi-msg--error" role="alert">
          {error}
        </div>
      ) : disabledReason ? (
        <div className="rvi-poi-msg rvi-poi-msg--hint" role="status">
          {disabledReason}
        </div>
      ) : null}
    </div>
  );
}
