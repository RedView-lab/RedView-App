import { IconMinus } from '../../../components/icons';
import { useAppI18n } from '@/shared/i18n';
import { formatPauseDurationInput, parsePauseDurationInput } from '../../../lib/schedule';
import type { PauseIntervalRow } from '../../../types';

interface PauseIntervalListProps {
  rows: PauseIntervalRow[];
  onChange: (next: PauseIntervalRow[]) => void;
}

/**
 * Affiche la liste des lignes « pause par intervalle » sous la bascule
 * correspondante de la section Rythme. Chaque ligne présente :
 *   - une pastille de nom extensible (« Pause 1 », « Pause 2 », …),
 *   - une puce « Durée » de largeur fixe (minutes),
 *   - une puce « Intervalle » de largeur fixe (minutes),
 *   - un petit bouton moins qui supprime la ligne.
 *
 * Le composant est entièrement contrôlé — le parent possède le tableau des
 * lignes et la bascule `pauseEveryIntervalEnabled` qui décide si le moteur de
 * routage doit tenir compte de ces pauses.
 */
export function PauseIntervalList({ rows, onChange }: PauseIntervalListProps) {
  const { t } = useAppI18n();
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

          <div className="rvi-pause-row__field rvi-pause-row__field--duration">
            <span className="rvi-pause-row__field-label">{t('Durée')}</span>
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
                aria-label={t('Durée de {{label}}', { label: row.label })}
              />
            </div>
          </div>

          <div className="rvi-pause-row__field rvi-pause-row__field--interval">
            <span className="rvi-pause-row__field-label">{t('Interval')}</span>
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
                aria-label={t('Interval de {{label}}', { label: row.label })}
              />
            </div>
          </div>

          <button
            type="button"
            className="rvi-pause-row__remove"
            aria-label={t('Supprimer {{label}}', { label: row.label })}
            onClick={() => remove(row.id)}
          >
            <IconMinus size={16} />
          </button>
        </div>
      ))}
    </div>
  );
}

