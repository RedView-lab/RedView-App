import { IconMinus } from '../../../components/icons';
import type { PauseIntervalRow } from '../../../types';

interface PauseIntervalListProps {
  rows: PauseIntervalRow[];
  onChange: (next: PauseIntervalRow[]) => void;
}

/**
 * Renders the list of "pause par interval" rows displayed under the
 * matching toggle in the Rythme section. Each row exposes:
 *   - a flexible name pill ("Pause 1", "Pause 2", …),
 *   - a fixed-width "Durée" chip (minutes),
 *   - a fixed-width "Interval" chip (minutes),
 *   - a small minus button that removes the row.
 *
 * The component is fully controlled — the parent owns the array of rows
 * and the `pauseEveryIntervalEnabled` toggle that decides whether the
 * routing engine should consider these pauses.
 */
export function PauseIntervalList({ rows, onChange }: PauseIntervalListProps) {
  if (rows.length === 0) return null;

  const update = (id: string, patch: Partial<PauseIntervalRow>) => {
    onChange(rows.map((r) => (r.id === id ? { ...r, ...patch } : r)));
  };
  const remove = (id: string) => {
    onChange(rows.filter((r) => r.id !== id));
  };

  return (
    <div className="rvi-pause-list">
      {rows.map((row) => (
        <div key={row.id} className="rvi-pause-row">
          <div className="rvi-pause-row__name">{row.label}</div>

          <div className="rvi-pause-row__field">
            <span className="rvi-pause-row__field-label">Durée</span>
            <div className="rvi-pause-chip">
              <input
                className="rvi-pause-chip__native"
                type="text"
                inputMode="numeric"
                value={formatDuration(row.durationMin)}
                onChange={(e) =>
                  update(row.id, {
                    durationMin: parseDurationToMinutes(
                      e.target.value,
                      row.durationMin,
                    ),
                  })
                }
                aria-label={`Durée de ${row.label}`}
              />
            </div>
          </div>

          <div className="rvi-pause-row__field">
            <span className="rvi-pause-row__field-label">Interval</span>
            <div className="rvi-pause-chip">
              <input
                className="rvi-pause-chip__native"
                type="text"
                inputMode="numeric"
                value={formatDuration(row.intervalMin)}
                onChange={(e) =>
                  update(row.id, {
                    intervalMin: parseDurationToMinutes(
                      e.target.value,
                      row.intervalMin,
                    ),
                  })
                }
                aria-label={`Interval de ${row.label}`}
              />
            </div>
          </div>

          <button
            type="button"
            className="rvi-pause-row__remove"
            aria-label={`Supprimer ${row.label}`}
            onClick={() => remove(row.id)}
          >
            <IconMinus size={20} />
          </button>
        </div>
      ))}
    </div>
  );
}

/** "210" → "3h30", "5" → "5min". */
function formatDuration(min: number): string {
  if (!Number.isFinite(min) || min <= 0) return '';
  if (min >= 60) {
    const h = Math.floor(min / 60);
    const m = min % 60;
    return m === 0 ? `${h}h` : `${h}h${String(m).padStart(2, '0')}`;
  }
  return `${min}min`;
}

/** Accepts "5", "5min", "1h30", "210" → minutes. Falls back to previous. */
function parseDurationToMinutes(raw: string, prev: number): number {
  const text = raw.trim().toLowerCase();
  if (!text) return 0;
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
