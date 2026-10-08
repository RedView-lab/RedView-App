import { useId, useState } from 'react';
import { PaymentElement, useElements, useStripe } from '@stripe/react-stripe-js';

import { useAppI18n } from '@/shared/i18n';
import { trackAnalyticsEvent } from '@/shared/lib/analytics';

import {
  TRIAL_DAYS,
  formatEuros,
  formatLongDate,
  getDisplayPlan,
  logBillingUi,
  logBillingUiError,
  trialEndDate,
} from '../../../lib';
import type { SubscriptionPlanId } from '../../../types';
import { RedViewWordmark } from './billingModalStyles';

/** Parcours ouvert dans la page de paiement. */
export type BillingModalState =
  | {
      /** Essai : enregistrer le moyen de paiement, rien n'est prélevé aujourd'hui. */
      mode: 'trial';
      clientSecret: string;
      setupIntentId: string;
      planId: SubscriptionPlanId;
    }
  | {
      /** Essai déjà consommé : payer la première échéance. */
      mode: 'subscription';
      clientSecret: string;
      subscriptionId: string;
      planId: SubscriptionPlanId;
    }
  | {
      /** Ajouter un moyen de paiement (devient celui par défaut). */
      mode: 'payment-method';
      clientSecret: string;
    };

export type BillingModalCompletion =
  | { mode: 'trial'; setupIntentId: string }
  | { mode: 'subscription'; subscriptionId: string }
  | { mode: 'payment-method'; setupIntentId: string };

interface BillingActionFormProps {
  flow: BillingModalState;
  onClose: () => void;
  onComplete: (completion: BillingModalCompletion) => Promise<void>;
}

/**
 * Où Stripe ramène l'utilisateur après un moyen de paiement à redirection
 * (PayPal…) : l'onglet Abonnement, avec de quoi finir le parcours
 * (`useBillingRedirectReturn`).
 */
function returnUrlFor(flow: BillingModalState): string {
  const url = new URL('/', window.location.origin);
  url.searchParams.set('tab', 'subscription');
  url.searchParams.set('billing_return', flow.mode);
  if (flow.mode === 'subscription') url.searchParams.set('subscription', flow.subscriptionId);
  return url.toString();
}

const CADENCE_LABELS: Record<SubscriptionPlanId, string> = {
  monthly: 'chaque mois',
  semiannual: 'tous les 6 mois',
  annual: 'chaque année',
};

export function BillingActionForm({ flow, onClose, onComplete }: BillingActionFormProps) {
  const { t } = useAppI18n();
  const stripe = useStripe();
  const elements = useElements();
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [consentAccepted, setConsentAccepted] = useState(false);
  const paymentPageTitleId = useId();

  const isSubscription = flow.mode !== 'payment-method';
  const plan = isSubscription ? getDisplayPlan(flow.planId) : null;
  const price = plan ? formatEuros(plan.amountCents) : '';
  const cadence = plan ? t(CADENCE_LABELS[plan.id]) : '';
  const firstChargeDate = formatLongDate(trialEndDate());

  const title =
    flow.mode === 'trial'
      ? t('Démarrer votre essai gratuit')
      : flow.mode === 'subscription'
        ? t('Finaliser votre abonnement')
        : t('Ajouter un moyen de paiement');

  const summary =
    flow.mode === 'trial'
      ? t('Aucun prélèvement aujourd’hui. {{price}} seront prélevés le {{date}}, puis {{cadence}}, sauf résiliation avant cette date.', {
          price,
          date: firstChargeDate,
          cadence,
        })
      : flow.mode === 'subscription'
        ? t('{{price}} prélevés aujourd’hui, puis {{cadence}}.', { price, cadence })
        : t('Ce moyen de paiement devient celui par défaut : les prochains prélèvements l’utiliseront.');

  const submitText =
    flow.mode === 'trial'
      ? t('Démarrer l’essai gratuit · puis {{price}} {{cadence}}', { price, cadence })
      : flow.mode === 'subscription'
        ? t('S’abonner et payer {{price}}', { price })
        : t('Enregistrer ce moyen de paiement');

  const handleSubmit = async (event: React.FormEvent<HTMLFormElement>) => {
    event.preventDefault();

    if (isSubscription && !consentAccepted) {
      setError(t('Cochez la case pour confirmer votre abonnement.'));
      return;
    }
    if (!stripe || !elements) {
      logBillingUi('billing-page-submit-blocked', { mode: flow.mode, hasStripe: Boolean(stripe), hasElements: Boolean(elements) });
      return;
    }

    setSubmitting(true);
    setError(null);

    try {
      const submitResult = await elements.submit();
      if (submitResult.error) throw new Error(submitResult.error.message);

      if (flow.mode === 'subscription') {
        const result = await stripe.confirmPayment({
          elements,
          confirmParams: { return_url: returnUrlFor(flow) },
          redirect: 'if_required',
        });
        if (result.error) throw new Error(result.error.message);
        await onComplete({ mode: 'subscription', subscriptionId: flow.subscriptionId });
        trackAnalyticsEvent({ name: 'checkout_completed', data: { plan: flow.planId } });
        return;
      }

      const result = await stripe.confirmSetup({
        elements,
        confirmParams: { return_url: returnUrlFor(flow) },
        redirect: 'if_required',
      });
      if (result.error) throw new Error(result.error.message);
      const setupIntentId = result.setupIntent?.id;
      if (!setupIntentId) throw new Error(t('Stripe n’a pas confirmé le moyen de paiement.'));

      if (flow.mode === 'trial') {
        await onComplete({ mode: 'trial', setupIntentId });
        trackAnalyticsEvent({ name: 'checkout_completed', data: { plan: flow.planId } });
      } else {
        await onComplete({ mode: 'payment-method', setupIntentId });
      }
    } catch (nextError) {
      logBillingUiError('billing-page-submit-error', nextError, { mode: flow.mode });
      setError(nextError instanceof Error ? t(nextError.message) : t('La confirmation Stripe a échoué.'));
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <section className="rvpb-billing-page rv-fixed-viewport" aria-labelledby={paymentPageTitleId}>
      <div className="rvpb-billing-page__chrome">
        <header className="rvpb-billing-page__header">
          <RedViewWordmark />
        </header>

        <main className="rvpb-billing-page__main">
          <section className="rvpb-billing-page__content">
            <div className="rvpb-billing-page__intro">
              {plan ? (
                <div className="rvpb-billing-page__summary-card">
                  <span className="rvpb-billing-page__summary-plan">
                    {t('Abonnement RedView · {{plan}}', { plan: t(plan.durationLabel) })}
                  </span>
                  <span className="rvpb-billing-page__summary-price">{price}</span>
                  <span className="rvpb-billing-page__summary-badge">
                    {flow.mode === 'trial'
                      ? t('{{days}} jours d’essai gratuit', { days: TRIAL_DAYS })
                      : t('Renouvelé {{cadence}}', { cadence })}
                  </span>
                </div>
              ) : null}
              <h2 id={paymentPageTitleId}>{title}</h2>
              <p>{summary}</p>
            </div>

            {error ? (
              <div className="rvpb-error rvpb-billing-page__error" role="alert">
                {error}
              </div>
            ) : null}

            <form className="rvpb-billing-page__form" onSubmit={handleSubmit}>
              <div className="rvpb-billing-page__stripe-container">
                {/* Pays et code postal restent demandés par Stripe quand le moyen en a besoin :
                    un champ masqué (`fields: … 'never'`) devrait être fourni à la confirmation,
                    sinon Stripe la refuse. Le pays est seulement prérempli. */}
                <PaymentElement
                  options={{
                    layout: 'tabs',
                    paymentMethodOrder: ['card', 'paypal', 'sepa_debit'],
                    defaultValues: { billingDetails: { address: { country: 'FR' } } },
                    wallets: { applePay: 'never', googlePay: 'never' },
                  }}
                />
              </div>

              {isSubscription ? (
                <>
                  <p className="rvpb-billing-page__terms">
                    {t('Prix TTC. Renouvellement automatique {{cadence}}, résiliable à tout moment depuis Compte → Abonnement, avec effet à la fin de la période en cours.', { cadence })}
                  </p>
                  <label className="rvpb-billing-page__consent">
                    <input
                      type="checkbox"
                      checked={consentAccepted}
                      onChange={(event) => setConsentAccepted(event.target.checked)}
                      disabled={submitting}
                    />
                    <span className="rvpb-billing-page__consent-copy">
                      {flow.mode === 'trial'
                        ? t('J’autorise RedView à prélever {{price}} {{cadence}} à partir du {{date}}, jusqu’à résiliation. Je demande l’accès immédiat au service : si j’exerce mon droit de rétractation de 14 jours, seule la période payante déjà utilisée me sera facturée.', { price, cadence, date: firstChargeDate })
                        : t('J’autorise RedView à prélever {{price}} aujourd’hui puis {{cadence}}, jusqu’à résiliation. Je demande l’accès immédiat au service : si j’exerce mon droit de rétractation de 14 jours, seule la période déjà utilisée me sera facturée.', { price, cadence })}
                    </span>
                  </label>
                </>
              ) : null}

              <div className="rvpb-billing-page__actions">
                <button
                  className="rvpb-billing-page__button rvpb-billing-page__button--ghost"
                  type="button"
                  onClick={onClose}
                  disabled={submitting}
                >
                  {t('Annuler')}
                </button>

                <button
                  className="rvpb-billing-page__button rvpb-billing-page__button--primary"
                  type="submit"
                  disabled={submitting || !stripe}
                >
                  {submitting ? t('Validation...') : submitText}
                </button>
              </div>
            </form>
          </section>
        </main>
      </div>
    </section>
  );
}
