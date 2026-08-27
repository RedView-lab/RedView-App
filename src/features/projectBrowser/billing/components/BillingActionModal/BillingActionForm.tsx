import { useEffect, useId, useMemo, useState } from 'react';
import {
  CardNumberElement,
  PaymentElement,
  useElements,
  useStripe,
} from '@stripe/react-stripe-js';
import { useAppI18n } from '@/shared/i18n';
import { buildAccountCountryOptions, DEFAULT_COUNTRY } from '../../../account/lib/options';
import { logBillingUi, logBillingUiError } from '../../../lib';
import type { SubscriptionPlanId } from '../../../types';
import {
  findCountryOption,
  PaymentMethodTile,
  RedViewWordmark,
  type BillingPaymentMethod,
} from './billingModalStyles';
import { BillingCardFields } from './BillingCardFields';

type ManagedPlanId = Exclude<SubscriptionPlanId, 'demo'>;

export type BillingModalState = {
  mode: 'subscription' | 'payment-method';
  clientSecret: string;
  title: string;
  description: string;
  submitLabel: string;
  planId?: ManagedPlanId;
  subscriptionId?: string;
};

export type BillingModalCompletion =
  | { mode: 'subscription'; subscriptionId: string }
  | { mode: 'payment-method'; setupIntentId: string };

interface BillingActionFormProps {
  flow: BillingModalState;
  onClose: () => void;
  onComplete: (completion: BillingModalCompletion) => Promise<void>;
  selectedMethod: BillingPaymentMethod;
  onSelectedMethodChange: (method: BillingPaymentMethod) => void;
}

export function BillingActionForm({
  flow,
  onClose,
  onComplete,
  selectedMethod,
  onSelectedMethodChange,
}: BillingActionFormProps) {
  const { locale, t } = useAppI18n();
  const stripe = useStripe();
  const elements = useElements();
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const paymentMethodLegendId = useId();
  const paymentPageTitleId = useId();
  const [cardholderName, setCardholderName] = useState('');
  const [countryCode, setCountryCode] = useState<string>(DEFAULT_COUNTRY);
  const [consentAccepted, setConsentAccepted] = useState(false);
  const countryOptions = useMemo(() => buildAccountCountryOptions(locale), [locale]);
  const paymentMethods: BillingPaymentMethod[] =
    flow.mode === 'subscription' ? ['card', 'amazon_pay'] : ['card'];
  const selectedCountryOption =
    findCountryOption(countryCode, countryOptions) ?? countryOptions[0];

  useEffect(() => {
    setConsentAccepted(false);
  }, [flow.clientSecret, flow.mode]);

  useEffect(() => {
    setError(null);
  }, [selectedMethod]);

  const handleSubmit = async (event: React.FormEvent<HTMLFormElement>) => {
    event.preventDefault();

    if (!consentAccepted) {
      setError(
        t(
          'Confirmez que RedView peut enregistrer ce moyen de paiement pour les renouvellements et ajustements futurs de votre abonnement.',
        ),
      );
      return;
    }

    if (!stripe || !elements) {
      logBillingUi('billing-page-submit-blocked', {
        mode: flow.mode,
        hasStripe: Boolean(stripe),
        hasElements: Boolean(elements),
      });
      return;
    }

    setSubmitting(true);
    setError(null);

    try {
      if (selectedMethod !== 'card') {
        const submitResult = await elements.submit();
        if (submitResult.error) {
          throw new Error(submitResult.error.message);
        }

        const result = await stripe.confirmPayment({
          elements,
          redirect: 'if_required',
        });

        if (result.error) {
          throw new Error(result.error.message);
        }

        if (!flow.subscriptionId) {
          throw new Error(t('Aucun abonnement Stripe à synchroniser après confirmation.'));
        }

        await onComplete({
          mode: 'subscription',
          subscriptionId: flow.subscriptionId,
        });
        return;
      }

      if (!cardholderName.trim()) {
        throw new Error(t('Saisissez le nom du titulaire de la carte.'));
      }

      const cardNumberElement = elements.getElement(CardNumberElement);
      if (!cardNumberElement) {
        throw new Error(t('Le champ de carte Stripe est introuvable.'));
      }

      if (flow.mode === 'payment-method') {
        const result = await stripe.confirmCardSetup(flow.clientSecret, {
          payment_method: {
            card: cardNumberElement,
            billing_details: {
              name: cardholderName.trim(),
              address: {
                country: countryCode,
              },
            },
          },
        });

        if (result.error) {
          throw new Error(result.error.message);
        }

        const setupIntentId = result.setupIntent?.id;
        if (!setupIntentId) {
          throw new Error(t('Stripe n’a pas renvoyé de SetupIntent exploitable.'));
        }

        await onComplete({ mode: 'payment-method', setupIntentId });
        return;
      }

      const result = await stripe.confirmCardPayment(flow.clientSecret, {
        payment_method: {
          card: cardNumberElement,
          billing_details: {
            name: cardholderName.trim(),
            address: {
              country: countryCode,
            },
          },
        },
      });

      if (result.error) {
        throw new Error(result.error.message);
      }

      if (!flow.subscriptionId) {
        throw new Error(t('Aucun abonnement Stripe à synchroniser après confirmation.'));
      }

      await onComplete({
        mode: 'subscription',
        subscriptionId: flow.subscriptionId,
      });
    } catch (nextError) {
      logBillingUiError('billing-page-submit-error', nextError, {
        mode: flow.mode,
        hasSubscriptionId: Boolean(flow.subscriptionId),
        selectedMethod,
      });
      setError(
        nextError instanceof Error
          ? t(nextError.message)
          : t('La confirmation Stripe a échoué.'),
      );
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <section className="rvpb-billing-page" aria-labelledby={paymentPageTitleId}>
      <div className="rvpb-billing-page__chrome">
        <header className="rvpb-billing-page__header">
          <RedViewWordmark />
        </header>

        <main className="rvpb-billing-page__main">
          <section className="rvpb-billing-page__content">
            <div className="rvpb-billing-page__intro">
              <h2 id={paymentPageTitleId}>{t(flow.title)}</h2>
              <p>{t(flow.description)}</p>
            </div>

            {error ? (
              <div className="rvpb-error rvpb-billing-page__error" role="alert">
                {error}
              </div>
            ) : null}

            <form className="rvpb-billing-page__form" onSubmit={handleSubmit}>
              <fieldset className="rvpb-billing-page__method-group" aria-labelledby={paymentMethodLegendId}>
                <legend id={paymentMethodLegendId}>{t('Votre mode de paiement :')}</legend>
                <div
                  className="rvpb-billing-page__method-grid"
                  style={{ gridTemplateColumns: `repeat(${paymentMethods.length}, minmax(0, 1fr))` }}
                >
                  {paymentMethods.map((method) => (
                    <PaymentMethodTile
                      key={method}
                      method={method}
                      selected={selectedMethod === method}
                      onSelect={onSelectedMethodChange}
                    />
                  ))}
                </div>
              </fieldset>

              <div className="rvpb-billing-page__section-label" aria-hidden="true">
                <span>{t('Card details')}</span>
                <span className="rvpb-billing-page__section-label-mark">*</span>
              </div>

              {selectedMethod === 'card' ? (
                <BillingCardFields
                  cardholderName={cardholderName}
                  onCardholderNameChange={setCardholderName}
                  countryCode={countryCode}
                  onCountryCodeChange={setCountryCode}
                  countryOptions={countryOptions}
                  selectedCountryOption={selectedCountryOption}
                />
              ) : (
                <div className="rvpb-billing-page__stripe-container">
                  <PaymentElement
                    options={{
                      wallets: {
                        applePay: 'never',
                        googlePay: 'never',
                      },
                    }}
                  />
                </div>
              )}

              <div className="rvpb-billing-page__consent">
                <label className="rvpb-billing-page__consent-label">
                  <input
                    className="rvpb-billing-page__consent-checkbox"
                    type="checkbox"
                    checked={consentAccepted}
                    onChange={(e) => setConsentAccepted(e.target.checked)}
                  />
                  <span className="rvpb-billing-page__consent-text">
                    {t(
                      'J’autorise RedView à enregistrer mon moyen de paiement et à débiter automatiquement le montant de mon abonnement à chaque échéance selon les conditions tarifaires applicables.',
                    )}
                  </span>
                </label>
              </div>

              <div className="rvpb-billing-page__actions">
                <button
                  className="rvpb-billing-page__submit"
                  type="submit"
                  disabled={submitting || !stripe}
                >
                  {submitting ? t('Validation...') : t(flow.submitLabel)}
                </button>

                <button
                  className="rvpb-billing-page__cancel"
                  type="button"
                  onClick={onClose}
                  disabled={submitting}
                >
                  {t('Annuler')}
                </button>
              </div>
            </form>
          </section>
        </main>
      </div>
    </section>
  );
}
