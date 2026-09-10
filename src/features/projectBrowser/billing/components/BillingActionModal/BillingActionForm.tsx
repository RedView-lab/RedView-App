import { useEffect, useId, useState } from 'react';
import { PaymentElement, useElements, useStripe } from '@stripe/react-stripe-js';
import { useAppI18n } from '@/shared/i18n';
import { trackAnalyticsEvent } from '@/shared/lib/analytics';
import { logBillingUi, logBillingUiError } from '../../../lib';
import type { SubscriptionPlanId } from '../../../types';
import { RedViewWordmark } from './billingModalStyles';

type ManagedPlanId = Exclude<SubscriptionPlanId, 'demo'>;

export type BillingModalState = {
  mode: 'subscription' | 'payment-method';
  clientSecret: string;
  title: string;
  description: string;
  submitLabel: string;
  planId?: ManagedPlanId;
  subscriptionId?: string;
  amount?: number;
};

export type BillingModalCompletion =
  | { mode: 'subscription'; subscriptionId: string }
  | { mode: 'payment-method'; setupIntentId: string };

interface BillingActionFormProps {
  flow: BillingModalState;
  onClose: () => void;
  onComplete: (completion: BillingModalCompletion) => Promise<void>;
  onUpdateAmount?: (amount: number) => Promise<void>;
}

export function BillingActionForm({
  flow,
  onClose,
  onComplete,
  onUpdateAmount,
}: BillingActionFormProps) {
  const { t } = useAppI18n();
  const stripe = useStripe();
  const elements = useElements();
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const paymentPageTitleId = useId();
  const [consentAccepted, setConsentAccepted] = useState(false);

  const isPatron = flow.planId === 'patron';
  const [selectedAmount, setSelectedAmount] = useState<number>(flow.amount ?? (isPatron ? 15 : 5));
  const [isCustomAmount, setIsCustomAmount] = useState(
    flow.amount ? ![15, 25, 50, 100].includes(flow.amount) : false,
  );
  const [customAmountInput, setCustomAmountInput] = useState(
    flow.amount && ![15, 25, 50, 100].includes(flow.amount) ? String(flow.amount) : '',
  );
  const [isUpdatingAmount, setIsUpdatingAmount] = useState(false);
  const [amountError, setAmountError] = useState<string | null>(null);

  useEffect(() => {
    setConsentAccepted(false);
  }, [flow.clientSecret, flow.mode]);

  useEffect(() => {
    if (flow.amount) {
      setSelectedAmount(flow.amount);
      if (![15, 25, 50, 100].includes(flow.amount)) {
        setIsCustomAmount(true);
        setCustomAmountInput(String(flow.amount));
      }
    }
  }, [flow.amount]);

  const handleSelectPreset = async (preset: number) => {
    if (isUpdatingAmount || submitting) return;
    setIsCustomAmount(false);
    setCustomAmountInput('');
    setAmountError(null);
    if (preset === selectedAmount) return;

    setSelectedAmount(preset);
    if (onUpdateAmount) {
      setIsUpdatingAmount(true);
      try {
        await onUpdateAmount(preset);
      } catch (err: any) {
        setAmountError(err?.message || t('Impossible de mettre à jour le montant.'));
      } finally {
        setIsUpdatingAmount(false);
      }
    }
  };

  const handleCustomInputCommit = async (valStr: string) => {
    if (isUpdatingAmount || submitting) return;
    const trimmed = valStr.trim();
    if (!trimmed) {
      setIsCustomAmount(false);
      setCustomAmountInput('');
      setAmountError(null);
      if (selectedAmount !== 15) {
        void handleSelectPreset(15);
      }
      return;
    }

    const parsed = parseInt(trimmed, 10);
    if (isNaN(parsed) || parsed < 15) {
      setAmountError(t('Le montant doit être de 15 € ou plus.'));
      return;
    }
    setAmountError(null);
    if (parsed === selectedAmount) return;

    setSelectedAmount(parsed);
    if (onUpdateAmount) {
      setIsUpdatingAmount(true);
      try {
        await onUpdateAmount(parsed);
      } catch (err: any) {
        setAmountError(err?.message || t('Impossible de mettre à jour le montant.'));
      } finally {
        setIsUpdatingAmount(false);
      }
    }
  };

  const priceLabel = `${selectedAmount} €`;
  const planLabel = isPatron ? t('Mécène & Soutien') : t('Pass Fondateur');
  const submitText = isPatron
    ? t('Payer {{price}}', { price: priceLabel })
    : t('Payer 5 €');

  const handleSubmit = async (event: React.FormEvent<HTMLFormElement>) => {
    event.preventDefault();

    if (!consentAccepted) {
      setError(
        isPatron
          ? t('Confirmez votre accord pour valider le paiement unique de {{price}}.', { price: priceLabel })
          : t('Confirmez votre accord pour valider le paiement unique de 5 €.'),
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
      const submitResult = await elements.submit();
      if (submitResult.error) {
        throw new Error(submitResult.error.message);
      }

      if (flow.mode === 'payment-method') {
        const result = await stripe.confirmSetup({
          elements,
          confirmParams: {
            return_url: `${window.location.origin}/`,
            payment_method_data: {
              billing_details: {
                address: {
                  country: 'FR',
                },
              },
            },
          },
          redirect: 'if_required',
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

      const result = await stripe.confirmPayment({
        elements,
        confirmParams: {
          return_url: `${window.location.origin}/`,
          payment_method_data: {
            billing_details: {
              address: {
                country: 'FR',
              },
            },
          },
        },
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

      trackAnalyticsEvent({
        name: 'click_upgrade_pro',
        data: {
          plan: 'pro',
          status: 'success',
        },
      });
    } catch (nextError) {
      logBillingUiError('billing-page-submit-error', nextError, {
        mode: flow.mode,
        hasSubscriptionId: Boolean(flow.subscriptionId),
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
              <div className="rvpb-billing-page__summary-card">
                <span className="rvpb-billing-page__summary-plan">{planLabel}</span>
                <span className="rvpb-billing-page__summary-price">{priceLabel}</span>
                <span className="rvpb-billing-page__summary-badge">
                  {t('Paiement unique · À vie')}
                </span>
              </div>
              <h2 id={paymentPageTitleId}>{t('Finaliser votre paiement')}</h2>
              <p>{t('Paiement unique de {{price}} · {{plan}} avec avantages à vie.', { price: priceLabel, plan: planLabel })}</p>
            </div>

            {isPatron ? (
              <div className="rvpb-billing-page__amount-selector">
                <div className="rvpb-billing-page__amount-title">
                  <span>{t('Montant de votre don / soutien')}</span>
                  <span className="rvpb-billing-page__amount-subtext">{t('(15 € ou plus)')}</span>
                </div>

                <div className="rvpb-billing-page__amount-presets">
                  {[15, 25, 50, 100].map((preset) => {
                    const isSelected = selectedAmount === preset && !isCustomAmount;
                    return (
                      <button
                        key={preset}
                        type="button"
                        className={`rvpb-billing-page__amount-btn ${isSelected ? 'is-active' : ''}`}
                        onClick={() => handleSelectPreset(preset)}
                        disabled={isUpdatingAmount || submitting}
                      >
                        {preset} €
                      </button>
                    );
                  })}

                  <div className={`rvpb-billing-page__amount-custom-field ${isCustomAmount ? 'is-active' : ''}`}>
                    <input
                      type="number"
                      min={15}
                      step={1}
                      placeholder="+15"
                      value={customAmountInput}
                      onChange={(e) => {
                        setIsCustomAmount(true);
                        setCustomAmountInput(e.target.value);
                      }}
                      onFocus={() => {
                        setIsCustomAmount(true);
                      }}
                      onBlur={() => {
                        if (customAmountInput.trim()) {
                          handleCustomInputCommit(customAmountInput);
                        }
                      }}
                      onKeyDown={(e) => {
                        if (e.key === 'Enter') {
                          e.preventDefault();
                          if (customAmountInput.trim()) {
                            handleCustomInputCommit(customAmountInput);
                          }
                        }
                      }}
                      disabled={isUpdatingAmount || submitting}
                    />
                    <span className="rvpb-billing-page__amount-custom-unit">€</span>
                  </div>
                </div>

                {amountError ? (
                  <p className="rvpb-billing-page__amount-error">{amountError}</p>
                ) : null}

                {isUpdatingAmount ? (
                  <div className="rvpb-billing-page__amount-loading">
                    <span className="rvpb-spinner" aria-hidden="true" />
                    <span>{t('Mise à jour du paiement Stripe...')}</span>
                  </div>
                ) : null}
              </div>
            ) : null}

            {error ? (
              <div className="rvpb-error rvpb-billing-page__error" role="alert">
                {error}
              </div>
            ) : null}

            <form className="rvpb-billing-page__form" onSubmit={handleSubmit}>
              <div className={`rvpb-billing-page__stripe-container ${isUpdatingAmount ? 'is-updating' : ''}`}>
                <PaymentElement
                  options={{
                    fields: {
                      billingDetails: {
                        address: {
                          country: 'never',
                          postalCode: 'never',
                        },
                      },
                    },
                    defaultValues: {
                      billingDetails: {
                        address: {
                          country: 'FR',
                        },
                      },
                    },
                    wallets: {
                      applePay: 'never',
                      googlePay: 'never',
                    },
                  }}
                />
              </div>

              <label className="rvpb-billing-page__consent">
                <input
                  type="checkbox"
                  checked={consentAccepted}
                  onChange={(e) => setConsentAccepted(e.target.checked)}
                  disabled={isUpdatingAmount || submitting}
                />
                <span className="rvpb-billing-page__consent-copy">
                  {isPatron
                    ? t(
                        'J’autorise RedView à prélever le paiement unique de {{price}} pour mon soutien Mécène et l’accès à mes avantages à vie.',
                        { price: priceLabel },
                      )
                    : t(
                        'J’autorise RedView à prélever le paiement unique de 5 € pour débloquer mon Pass Fondateur et mes avantages à vie.',
                      )}
                </span>
              </label>

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
                  disabled={submitting || isUpdatingAmount || !stripe}
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
