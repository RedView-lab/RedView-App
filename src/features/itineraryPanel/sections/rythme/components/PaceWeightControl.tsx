import { useId } from 'react';
import { useAppI18n } from '@/shared/i18n';
import { IconFigmaMinus, IconFigmaPlus } from '../../../components/iconsFigma';
import {
  PACE_WEIGHT_MAX_PCT,
  PACE_WEIGHT_MIN_PCT,
  PACE_WEIGHT_STEP_PCT,
  normalizePaceWeightPct,
  stepPaceWeightPct,
} from '../../../lib/rhythm/pace';

/** « +10 % » / « −5 % » (espace fine insécable en français). */
function formatPaceWeight(weightPct: number, locale: 'fr' | 'en'): string {
  return new Intl.NumberFormat(locale === 'fr' ? 'fr-FR' : 'en-US', {
    style: 'percent',
    signDisplay: 'exceptZero',
  }).format(weightPct / 100);
}

/**
 * « Pondérer » (Figma 2147236910) : pilule − | + qui ralentit ou accélère
 * l'estimation par pas de 5 % de vitesse. La valeur s'affiche à côté du titre
 * dès qu'elle n'est plus neutre ; un clic dessus la remet à 0 %.
 */
export function PaceWeightControl({
  value,
  onChange,
}: {
  value: number | undefined;
  onChange: (next: number | undefined) => void;
}) {
  const { t, locale } = useAppI18n();
  const labelId = useId();
  const weight = normalizePaceWeightPct(value) ?? 0;
  const shown = formatPaceWeight(weight, locale);

  return (
    <div className="rvi-rythme-figma__weight-field">
      <div className="rvi-rythme-figma__weight-head">
        <span id={labelId} className="rvi-rythme-figma__label-title">{t('Pondérer')}</span>
        {weight !== 0 ? (
          <button
            type="button"
            className="rvi-rythme-figma__weight-value"
            onClick={() => onChange(undefined)}
            aria-label={t('Pondération {{value}}, remettre à 0 %', { value: shown })}
            title={t('Remettre à 0 %')}
          >
            {shown}
          </button>
        ) : null}
      </div>
      <div className="rvi-rythme-figma__weight-pill" role="group" aria-labelledby={labelId}>
        <button
          type="button"
          className="rvi-rythme-figma__weight-btn"
          onClick={() => onChange(stepPaceWeightPct(weight, -1))}
          disabled={weight <= PACE_WEIGHT_MIN_PCT}
          aria-label={t('Ralentir l’estimation de {{step}} %', { step: PACE_WEIGHT_STEP_PCT })}
          title={t('Ralentir l’estimation de {{step}} %', { step: PACE_WEIGHT_STEP_PCT })}
        >
          <IconFigmaMinus size={24} aria-hidden="true" />
        </button>
        <span className="rvi-rythme-figma__weight-divider" aria-hidden="true" />
        <button
          type="button"
          className="rvi-rythme-figma__weight-btn"
          onClick={() => onChange(stepPaceWeightPct(weight, 1))}
          disabled={weight >= PACE_WEIGHT_MAX_PCT}
          aria-label={t('Accélérer l’estimation de {{step}} %', { step: PACE_WEIGHT_STEP_PCT })}
          title={t('Accélérer l’estimation de {{step}} %', { step: PACE_WEIGHT_STEP_PCT })}
        >
          <IconFigmaPlus size={24} aria-hidden="true" />
        </button>
      </div>
      {/* Valeur annoncée aux lecteurs d'écran à chaque clic. */}
      <span className="rv-sr-only" aria-live="polite">
        {t('Pondération : {{value}}', { value: shown })}
      </span>
    </div>
  );
}
