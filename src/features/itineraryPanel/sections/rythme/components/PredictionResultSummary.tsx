import { useAppI18n } from '@/shared/i18n';
import {
  formatCompactDuration,
  formatPacePerKm,
  formatSpeedKmh,
  type RhythmResultSummary,
} from '../../../lib/rhythm/resultSummary';

/**
 * Résultats de la prédiction, sous le bouton de calcul : temps total, temps
 * en déplacement avec sa vitesse moyenne (km/h), pauses. Estompé pendant un
 * recalcul (les valeurs sont alors celles du calcul précédent).
 */
export function PredictionResultSummary({
  summary,
  stale,
}: {
  summary: RhythmResultSummary;
  stale: boolean;
}) {
  const { t, locale } = useAppI18n();
  const moving = [
    formatCompactDuration(summary.movingSeconds),
    summary.movingKmh !== null ? formatSpeedKmh(summary.movingKmh, locale) : null,
    summary.paceSecondsPerKm !== null ? formatPacePerKm(summary.paceSecondsPerKm) : null,
  ].filter(Boolean).join(' · ');

  return (
    <dl
      className={`rvi-rythme-figma__results${stale ? ' is-stale' : ''}`}
      aria-label={t('Résultats de l’estimation')}
      aria-busy={stale || undefined}
    >
      <div className="rvi-rythme-figma__result-row">
        <dt>{t('Temps total')}</dt>
        <dd>{formatCompactDuration(summary.totalSeconds)}</dd>
      </div>
      <div className="rvi-rythme-figma__result-row">
        <dt>{t('En déplacement')}</dt>
        <dd>{moving}</dd>
      </div>
      {summary.pauseSeconds > 0 ? (
        <div className="rvi-rythme-figma__result-row">
          <dt>{t('Pauses')}</dt>
          <dd>{formatCompactDuration(summary.pauseSeconds)}</dd>
        </div>
      ) : null}
    </dl>
  );
}
