import { useEffect, useState } from 'react';
import { PanelCheckbox } from '../../../components/controls';
import { formatPauseDurationInput, parsePauseDurationInput } from '../../../lib/schedule';
import type { PoiCategory } from '../../../types';

/**
 * 2-column grid of POI-category pause durations, shown under the
 * "Ajouter des pauses à chaque POI favori" toggle when it is enabled.
 *
 * Pixel-perfect implementation of Figma node 1695:22638 (PacingBreaksExt —
 * Variant2). Each cell is an auto-layout [checkbox · label · chip]:
 *   • checkbox 16×16 (see .rvi-checkbox)
 *   • label 13px Medium, opacity .64, flex:1, min-w 32, ellipsis
 *   • chip max-w 104 / min-w 64, radius 6, padding 6/8; inner text 14 SemiBold
 * A `null` duration means the user unchecked the row — the whole cell
 * dims to opacity .5 and the chip shows "-".
 *
 * This component is fully controlled: the parent owns the durations map
 * and decides how to persist it (e.g. RhythmState.poiPauseDurations).
 */
export interface PoiPauseGridProps {
  durations: Record<PoiCategory, number | null>;
  onChange: (next: Record<PoiCategory, number | null>) => void;
}

/** Display order + French labels, mirroring the POI section grid. */
const ROWS: ReadonlyArray<[PoiCategory, string, number]> = [
  ['fountains', 'Fontaines', 15],
  ['toilets', 'Toilettes', 15],
  ['supermarkets', 'Supermarchés', 15],
  ['gasStations', 'Station Service', 15],
  ['bakeries', 'Boulangerie', 15],
  ['fastFood', 'Fast-food', 15],
  ['cafes', 'Café', 15],
  ['bars', 'Bar', 15],
  ['restaurants', 'Restaurant', 15],
  ['bikeShops', 'Magasin de vélo', 15],
  ['hotels', 'Hôtels', 15],
  ['refuges', 'Refuges', 15],
];

export function PoiPauseGrid({ durations, onChange }: PoiPauseGridProps) {
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
                label={label}
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
  label: string;
  checked: boolean;
  value: number | null;
  onToggle: (v: boolean) => void;
  onValueChange: (min: number) => void;
}

function PoiPauseCell({
  label,
  checked,
  value,
  onToggle,
  onValueChange,
}: CellProps) {
  const displayed = checked && value !== null ? formatPauseDurationInput(value) : '-';
  const [draft, setDraft] = useState(displayed);

  useEffect(() => {
    setDraft(displayed);
  }, [displayed]);

  const commitDraft = () => {
    if (!checked) {
      setDraft('-');
      return;
    }
    const nextMinutes = parsePauseDurationInput(draft, value ?? 15);
    onValueChange(nextMinutes);
    setDraft(formatPauseDurationInput(nextMinutes));
  };

  return (
    <div className={`rvi-poipause-cell${checked ? '' : ' is-off'}`}>
      <PanelCheckbox checked={checked} onChange={onToggle} ariaLabel={label} />
      <span className="rvi-poipause-cell__label" title={label}>
        {label}
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
          aria-label={`Durée de pause — ${label}`}
        />
      </div>
    </div>
  );
}

/** Group the rows into [2, 2, 2, 2] pairs matching the Figma 2-col grid. */
function pairs<T>(list: readonly T[]): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < list.length; i += 2) out.push(list.slice(i, i + 2));
  return out;
}

