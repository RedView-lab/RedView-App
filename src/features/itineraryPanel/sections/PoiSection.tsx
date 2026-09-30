import { useCallback, useEffect, useRef, useState } from 'react';

import { ActionButtonStack, CheckboxField } from '../components/controls';
import { PoiAutoSortDialog } from '../components/dialogs/PoiAutoSortDialog';
import { IconInfo, IconSparkles } from '../components/icons';
import { useAppI18n } from '@/shared/i18n';
import { PANEL_POI_ROWS } from '../lib/project/poiRows';

import type { PoiAutoSortSummary, PoiCategory, PoiEntry, PoiState } from '../types';

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
  /** POI chargés avec d'autres catégories / distances : proposer de relancer. */
  searchStale?: boolean;
  /** Tri automatique : pré-sélectionne des favoris parmi les POI chargés. */
  onAutoSort?: () => boolean;
  autoSortDisabled?: boolean;
  /** Dernier tri (null = jamais lancé) ; `stale` si ses entrées ont changé. */
  autoSort?: { summary: PoiAutoSortSummary; stale: boolean } | null;
}

/** Lignes du panneau groupées par paires (grille 2 colonnes). */
const POI_ROWS = pairRows(PANEL_POI_ROWS);

function pairRows<T>(list: readonly T[]): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < list.length; i += 2) out.push(list.slice(i, i + 2));
  return out;
}

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
  searchStale = false,
  onAutoSort,
  autoSortDisabled = false,
  autoSort = null,
}: PoiSectionProps) {
  const { t } = useAppI18n();
  const [dialogOpen, setDialogOpen] = useState(false);
  const [infoButton, setInfoButton] = useState<HTMLButtonElement | null>(null);
  const closeDialog = useCallback(() => setDialogOpen(false), []);
  // Le bouton lance le tri directement ; le bilan reste consultable via ⓘ.
  // Le tri est synchrone : on laisse d'abord s'afficher « Tri en cours… »,
  // puis on confirme brièvement la mise à jour (sinon un tri qui retombe
  // sur le même nombre de favoris semble ne rien faire).
  const [sortPhase, setSortPhase] = useState<'idle' | 'running' | 'done'>('idle');
  const sortTimerRef = useRef<number | null>(null);
  useEffect(() => () => {
    if (sortTimerRef.current != null) window.clearTimeout(sortTimerRef.current);
  }, []);
  const runAutoSort = useCallback(() => {
    if (sortTimerRef.current != null) window.clearTimeout(sortTimerRef.current);
    setSortPhase('running');
    sortTimerRef.current = window.setTimeout(() => {
      const sorted = onAutoSort?.() ?? false;
      setSortPhase(sorted ? 'done' : 'idle');
      sortTimerRef.current = window.setTimeout(() => setSortPhase('idle'), 2000);
    }, 30);
  }, [onAutoSort]);

  const pct =
    progress !== null && Number.isFinite(progress)
      ? Math.max(0, Math.min(100, Math.round(progress * 100)))
      : null;
  const loadingLabel = loading
    ? pct !== null
      ? `${pct}%`
      : t('Recherche…')
    : null;
  // Réglages modifiés depuis la recherche : le bouton repasse en action.
  const resultLabel = poiCount > 0 && !searchStale ? t('({{count}} POI trouvés)', { count: poiCount }) : null;
  const autoSortFresh = autoSort != null && !autoSort.stale && !autoSortDisabled;

  return (
    <div className="rvi-params rvi-params--poi">
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
        primaryLabel={searchStale ? t('Relancer la recherche') : t('Charger')}
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

      {onAutoSort ? (
        <div className="rvi-poi-autosort">
          <div className="rvi-poi-autosort__main">
            <ActionButtonStack
              primaryLabel={autoSort ? t('Re-trier les favoris') : t('Tri auto des favoris')}
              primaryIcon={<IconSparkles size={16} />}
              onPrimaryClick={runAutoSort}
              primaryDisabled={autoSortDisabled}
              loadingLabel={sortPhase === 'running' ? t('Tri en cours…') : null}
              resultLabel={
                autoSortFresh
                  ? sortPhase === 'done'
                    ? t('{{count}} favoris auto mis à jour', { count: autoSort.summary.total })
                    : t('{{count}} favoris auto', { count: autoSort.summary.total })
                  : null
              }
            />
          </div>
          <button
            ref={setInfoButton}
            type="button"
            className="rvi-poi-autosort__info"
            aria-label={t('Critères du tri automatique')}
            aria-haspopup="dialog"
            aria-expanded={dialogOpen}
            onClick={() => setDialogOpen(true)}
          >
            <IconInfo size={16} />
          </button>
        </div>
      ) : null}

      <PoiAutoSortDialog
        open={dialogOpen}
        anchorEl={infoButton}
        onClose={closeDialog}
        summary={autoSort?.summary ?? null}
        stale={Boolean(autoSort?.stale)}
        runDisabled={autoSortDisabled}
        onRun={runAutoSort}
      />
    </div>
  );
}
