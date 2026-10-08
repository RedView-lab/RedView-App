import { useState } from 'react';
import { useHasChanged } from '@/shared/hooks/useHasChanged';
import { useAppI18n } from '@/shared/i18n';
import { PanelCheckbox } from '../../../components/controls';
import { formatPauseDurationInput, parsePauseDurationInput } from '../../../lib/schedule';
import { DEFAULT_POI_PAUSE_DURATIONS, PANEL_POI_ROWS } from '../../../lib/project';
import type { PoiCategory } from '../../../types';

/**
 * Grille de 2 colonnes des durées de pause par catégorie de POI, affichée sous
 * la bascule « Ajouter des pauses à chaque POI favori » quand elle est activée.
 *
 * Implémentation au pixel près du nœud Figma 1695:22638 (PacingBreaksExt —
 * Variant2). Chaque cellule est une mise en page automatique [case · libellé · puce] :
 *   • case 16×16 (voir .rvi-checkbox)
 *   • libellé 13px Medium, opacité .64, flex:1, min-w 32, points de suspension
 *   • puce max-w 104 / min-w 64, rayon 6, padding 6/8 ; texte intérieur 14 SemiBold
 * Une durée `null` signifie que l'utilisateur a décoché la ligne — toute la
 * cellule passe à l'opacité .5 et la puce affiche « - ».
 *
 * Ce composant est entièrement contrôlé : le parent possède la table des
 * durées et décide comment la persister (par ex. RhythmState.poiPauseDurations).
 */
export interface PoiPauseGridProps {
  durations: Record<PoiCategory, number | null>;
  onChange: (next: Record<PoiCategory, number | null>) => void;
}

/** Catégories qui n'ont jamais de pause (masquées de cette grille). */
const NO_PAUSE_CATEGORIES: ReadonlySet<PoiCategory> = new Set<PoiCategory>(['health']);
const FALLBACK_PAUSE_MIN = 15;

/** Ordre d'affichage + libellés français, comme la grille de la section POI. */
const ROWS: ReadonlyArray<[PoiCategory, string, number]> = PANEL_POI_ROWS
  .filter((row) => !NO_PAUSE_CATEGORIES.has(row.key))
  .map((row) => [row.key, row.label, DEFAULT_POI_PAUSE_DURATIONS[row.key] ?? FALLBACK_PAUSE_MIN]);

export function PoiPauseGrid({ durations, onChange }: PoiPauseGridProps) {
  const { t } = useAppI18n();
  const setDuration = (key: PoiCategory, min: number | null) => {
    onChange({ ...durations, [key]: min });
  };

  return (
    <div className="rvi-poipause-grid">
      {pairs(ROWS).map((pair, rowIdx) => (
        <div className="rvi-poipause-row" key={rowIdx}>
          {pair.map(([key, label, fallback]) => {
            const value = durations[key];
            const checked = value !== null && Number.isFinite(value);
            return (
              <PoiPauseCell
                key={key}
                translatedLabel={t(label)}
                checked={checked}
                value={value}
                onToggle={(v) => setDuration(key, v ? value ?? fallback : null)}
                onValueChange={(v) => setDuration(key, v)}
              />
            );
          })}
        </div>
      ))}
    </div>
  );
}

interface CellProps {
  translatedLabel: string;
  checked: boolean;
  value: number | null;
  onToggle: (v: boolean) => void;
  onValueChange: (min: number) => void;
}

function PoiPauseCell({
  translatedLabel,
  checked,
  value,
  onToggle,
  onValueChange,
}: CellProps) {
  const { t } = useAppI18n();
  const displayed = checked && value !== null ? formatPauseDurationInput(value) : '-';
  const [draft, setDraft] = useState(displayed);

  // Valeur changée par le parent : le brouillon la reprend (pendant le rendu).
  const displayedChanged = useHasChanged(displayed);
  if (displayedChanged) setDraft(displayed);

  const commitDraft = () => {
    if (!checked) {
      setDraft('-');
      return;
    }
    const nextMinutes = parsePauseDurationInput(draft, value ?? FALLBACK_PAUSE_MIN);
    onValueChange(nextMinutes);
    setDraft(formatPauseDurationInput(nextMinutes));
  };

  return (
    <div className={`rvi-poipause-cell${checked ? '' : ' is-off'}`}>
      <PanelCheckbox checked={checked} onChange={onToggle} ariaLabel={translatedLabel} />
      <span className="rvi-poipause-cell__label" title={translatedLabel}>
        {translatedLabel}
      </span>
      <div className="rvi-poipause-cell__chip">
        <input
          className="rvi-poipause-cell__native"
          type="text"
          inputMode="numeric"
          disabled={!checked}
          value={draft}
          onChange={(e) => {
            setDraft(e.target.value);
          }}
          onBlur={commitDraft}
          onFocus={(e) => e.currentTarget.select()}
          onKeyDown={(e) => {
            if (e.key === 'Enter') {
              e.preventDefault();
              commitDraft();
              e.currentTarget.blur();
            }
            if (e.key === 'Escape') {
              e.preventDefault();
              setDraft(displayed);
              e.currentTarget.blur();
            }
          }}
          aria-label={t('Durée de pause — {{label}}', { label: translatedLabel })}
        />
      </div>
    </div>
  );
}

/** Groupe les lignes en paires [2, 2, 2, 2] conformes à la grille de 2 colonnes de Figma. */
function pairs<T>(list: readonly T[]): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < list.length; i += 2) out.push(list.slice(i, i + 2));
  return out;
}

