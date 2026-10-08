import { SvgV2Icon } from '@/shared/components/SvgV2Icon';
import { useAppI18n } from '@/shared/i18n';

import {
  TRIAL_DAYS,
  discountPercent,
  formatEuroAmount,
  formatEuros,
  monthlyEquivalentCents,
  type DisplayPlan,
} from '../../lib';

type SubscriptionPlanCardProps = {
  plan: DisplayPlan;
  /** Formule de l'abonnement en cours. */
  current: boolean;
  /** Mention d'essai gratuit (essai encore disponible pour le compte). */
  showTrial: boolean;
  /** Pastille sous le séparateur quand ce n'est pas l'essai (état de la formule en cours). */
  statusLabel?: string;
  ctaLabel: string;
  ctaDisabled: boolean;
  ctaTitle?: string;
  onCta: () => void;
};

/** Carte d'une durée d'abonnement : durée, prix, réduction, essai, bouton. */
export function SubscriptionPlanCard({
  plan,
  current,
  showTrial,
  statusLabel,
  ctaLabel,
  ctaDisabled,
  ctaTitle,
  onCta,
}: SubscriptionPlanCardProps) {
  const { t } = useAppI18n();
  const discount = discountPercent(plan);
  const durationLabel = t(plan.durationLabel);

  return (
    <article
      className={`rvpb-plan-card${current ? ' is-current' : ''}`}
      aria-label={t('Formule {{plan}} : {{price}}', { plan: durationLabel, price: formatEuros(plan.amountCents) })}
    >
      <div className="rvpb-plan-card__head">
        <span className="rvpb-plan-card__duration">{durationLabel}</span>
        <span className="rvpb-plan-card__price" aria-hidden="true">
          <span className="rvpb-plan-card__amount">{formatEuroAmount(plan.amountCents)}</span>
          <span className="rvpb-plan-card__currency">€</span>
        </span>
        <span className="rvpb-plan-card__offer">
          {discount > 0 ? (
            <>
              <span className="rvpb-plan-card__badge">-{discount}%</span>
              <span className="rvpb-plan-card__per-month">
                {t('Soit {{price}} par mois', { price: formatEuros(monthlyEquivalentCents(plan)) })}
              </span>
            </>
          ) : (
            <span className="rvpb-plan-card__badge rvpb-plan-card__badge--note">{t('Sans engagement')}</span>
          )}
        </span>
      </div>

      <div className="rvpb-plan-card__divider" />

      {showTrial || statusLabel ? (
        <span className={`rvpb-plan-card__pill${statusLabel ? ' is-status' : ''}`}>
          {statusLabel ?? t('{{days}} jours d’essai gratuit inclus', { days: TRIAL_DAYS })}
        </span>
      ) : null}

      <button
        type="button"
        className="rvpb-plan-card__cta"
        disabled={ctaDisabled}
        title={ctaTitle}
        onClick={onCta}
      >
        <span>{ctaLabel}</span>
        {ctaDisabled ? null : <SvgV2Icon name="arrow-right.svg" size={16} />}
      </button>
    </article>
  );
}
