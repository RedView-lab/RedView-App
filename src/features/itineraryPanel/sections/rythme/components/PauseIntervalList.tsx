import { IconMinus } from '../../../components/icons';
import { formatPauseDurationInput, parsePauseDurationInput } from '../../../lib/schedule';
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
                value={formatPauseDurationInput(row.durationMin)}
                onChange={(e) =>
                  update(row.id, {
                    durationMin: parsePauseDurationInput(
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
                value={formatPauseDurationInput(row.intervalMin)}
                onChange={(e) =>
                  update(row.id, {
                    intervalMin: parsePauseDurationInput(
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

