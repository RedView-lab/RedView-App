import { PanelCheckbox } from './PanelCheckbox';
import type { PoiCategory } from '../types';

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

/** Display order + French labels, matching Figma 1695:22638. */
const ROWS: ReadonlyArray<[PoiCategory, string, number]> = [
  ['fountains', 'Fontaines', 5],
  ['bakeries', 'Boulangeries', 15],
  ['supermarkets', 'Supermarchés', 15],
  ['restaurants', 'Restaurants', 40],
  ['hotels', 'Hôtels', 240],
  ['refuges', 'Refuges', 40],
  ['bars', 'Bar', 30],
  ['passes', 'Cols', 10],
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
  const displayed = checked && value !== null ? formatDuration(value) : '-';
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
          value={displayed}
          onChange={(e) => {
            const n = parseDurationToMinutes(e.target.value, value ?? 0);
            onValueChange(n);
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

/** "240" → "4h", "15" → "15min", "210" → "3h30". */
function formatDuration(min: number): string {
  if (!Number.isFinite(min) || min <= 0) return '-';
  if (min >= 60) {
    const h = Math.floor(min / 60);
    const m = min % 60;
    return m === 0 ? `${h}h` : `${h}h${String(m).padStart(2, '0')}`;
  }
  return `${min}min`;
}

/** Accepts "5", "5min", "4h", "1h30", "210" → minutes. Falls back to prev. */
function parseDurationToMinutes(raw: string, prev: number): number {
  const text = raw.trim().toLowerCase();
  if (!text || text === '-') return prev;
  const hMatch = text.match(/^(\d+)\s*h\s*(\d{0,2})$/);
  if (hMatch) {
    const h = parseInt(hMatch[1], 10);
    const m = hMatch[2] ? parseInt(hMatch[2], 10) : 0;
    return h * 60 + m;
  }
  const minMatch = text.match(/^(\d+)\s*(min|m)?$/);
  if (minMatch) return parseInt(minMatch[1], 10);
  return prev;
}
