import { useEffect, useId, useState } from 'react';
import { createPortal } from 'react-dom';

import {
  CardCvcElement,
  CardExpiryElement,
  CardNumberElement,
  Elements,
  PaymentElement,
  useElements,
  useStripe,
} from '@stripe/react-stripe-js';
import { loadStripe } from '@stripe/stripe-js';

import { useAppI18n } from '@/shared/i18n';
import { ACCOUNT_COUNTRY_OPTIONS, DEFAULT_COUNTRY } from '../../../account/lib/options';
import { logBillingUi, logBillingUiError } from '../../../lib';
import type { SubscriptionPlanId } from '../../../types';

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

type BillingPaymentMethod = 'card' | 'amazon_pay';

const publishableKey = import.meta.env.VITE_STRIPE_PUBLISHABLE_KEY?.trim() ?? '';
const stripePromise = publishableKey ? loadStripe(publishableKey) : null;

const stripeCardElementStyle = {
  base: {
    color: '#ffffff',
    fontFamily: 'Rethink Sans, system-ui, sans-serif',
    fontSize: '16px',
    fontSmoothing: 'antialiased',
    '::placeholder': {
      color: 'rgba(255, 255, 255, 0.48)',
    },
    iconColor: 'rgba(255, 255, 255, 0.88)',
  },
  invalid: {
    color: '#ffb4b4',
    iconColor: '#ffb4b4',
  },
};

const appearance = {
  theme: 'night' as const,
  labels: 'above' as const,
  variables: {
    colorPrimary: '#890000',
    colorBackground: '#141414',
    colorText: '#ffffff',
    colorDanger: '#ff8e8e',
    colorTextPlaceholder: '#8c8c8c',
    colorTextSecondary: '#c7c7c7',
    colorIcon: '#d1d1d1',
    colorSuccess: '#34d399',
    borderRadius: '8px',
    spacingUnit: '4px',
    fontFamily: 'Rethink Sans, system-ui, sans-serif',
  },
  rules: {
    '.AccordionItem': {
      backgroundColor: 'rgba(255,255,255,0.04)',
      border: '1px solid rgba(255,255,255,0.16)',
      boxShadow: 'none',
    },
    '.Tab': {
      backgroundColor: 'rgba(255,255,255,0.04)',
      border: '1px solid rgba(255,255,255,0.16)',
      color: '#ffffff',
      boxShadow: 'none',
      padding: '12px 16px',
    },
    '.Tab:hover': {
      color: '#ffffff',
      backgroundColor: 'rgba(255,255,255,0.04)',
    },
    '.Tab--selected': {
      backgroundColor: 'rgba(255,255,255,0.04)',
      borderColor: 'rgba(255,255,255,0.28)',
      boxShadow: 'inset 0 0 0 1px rgba(255,255,255,0.08)',
    },
    '.TabLabel': {
      color: '#ffffff',
      fontWeight: '500',
      fontSize: '14px',
    },
    '.Input': {
      backgroundColor: 'rgba(255,255,255,0.08)',
      border: '1px solid rgba(213,215,218,0.16)',
      boxShadow: '0 1px 2px rgba(10,13,18,0.05)',
    },
    '.Block': {
      backgroundColor: 'rgba(255,255,255,0.08)',
      border: '1px solid rgba(213,215,218,0.16)',
      boxShadow: '0 1px 2px rgba(10,13,18,0.05)',
    },
    '.CodeInput': {
      backgroundColor: 'rgba(255,255,255,0.08)',
      border: '1px solid rgba(213,215,218,0.16)',
      boxShadow: '0 1px 2px rgba(10,13,18,0.05)',
    },
    '.Input:focus': {
      borderColor: 'rgba(137,0,0,0.9)',
      boxShadow: '0 0 0 1px rgba(137,0,0,0.65)',
    },
    '.CodeInput:focus': {
      borderColor: 'rgba(137,0,0,0.9)',
      boxShadow: '0 0 0 1px rgba(137,0,0,0.65)',
    },
    '.Label': {
      color: '#ffffff',
      fontWeight: '600',
      fontSize: '15px',
    },
    '.Text': {
      color: 'rgba(255,255,255,0.74)',
    },
    '.Error': {
      color: '#ffb4b4',
    },
  },
};

type BillingActionModalProps = {
  flow: BillingModalState;
  onClose: () => void;
  onComplete: (completion: BillingModalCompletion) => Promise<void>;
};

type BillingActionFormProps = BillingActionModalProps;

function flagEmojiFromCode(code: string): string {
  return code
    .toUpperCase()
    .split('')
    .map((char) => String.fromCodePoint(127397 + char.charCodeAt(0)))
    .join('');
}

function CardMethodIcon() {
  return (
    <svg viewBox="0 0 24 24" aria-hidden="true" className="rvpb-billing-page__method-icon-svg">
      <rect x="3" y="5" width="18" height="14" rx="2.5" fill="none" stroke="currentColor" strokeWidth="1.8" />
      <path d="M3 10.5H21" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" />
      <path d="M7 15H12" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" />
    </svg>
  );
}

function ChevronDownIcon() {
  return (
    <svg viewBox="0 0 20 20" aria-hidden="true" className="rvpb-billing-page__chevron-svg">
      <path
        d="M5 7.5L10 12.5L15 7.5"
        fill="none"
        stroke="currentColor"
        strokeLinecap="round"
        strokeLinejoin="round"
        strokeWidth="1.75"
      />
    </svg>
  );
}

function PaymentMethodTile({
  method,
  selected,
  onSelect,
}: {
  method: BillingPaymentMethod;
  selected: boolean;
  onSelect: (method: BillingPaymentMethod) => void;
}) {
  const { t } = useAppI18n();
  const title = method === 'card' ? t('Carte Bancaire') : t('Amazon Pay');

  return (
    <button
      type="button"
      className={`rvpb-billing-page__method-tile rvpb-billing-page__method-tile--${method.replace('_', '-')}${selected ? ' rvpb-billing-page__method-tile--selected' : ''}`}
      onClick={() => onSelect(method)}
      role="radio"
      aria-checked={selected}
    >
      <span className="rvpb-billing-page__method-radio" aria-hidden="true">
        <span className="rvpb-billing-page__method-radio-dot" />
      </span>
      <span className="rvpb-billing-page__method-title">{title}</span>
      <span
        className={`rvpb-billing-page__method-icon${method === 'amazon_pay' ? ' rvpb-billing-page__method-icon--amazon' : ''}`}
        aria-hidden="true"
      >
        {method === 'card' ? (
          <CardMethodIcon />
        ) : (
          <span className="rvpb-billing-page__amazon-pay-wordmark">pay</span>
        )}
      </span>
    </button>
  );
}

function RedViewWordmark() {
  return (
    <div className="rvpb-billing-page__brand" aria-label="RedView">
      <img
        className="rvpb-billing-page__brand-image"
        src="/landing/icons/redview-logo.svg"
        alt="RedView"
        width={125}
        height={24}
      />
    </div>
  );
}

function BillingActionForm({ flow, onClose, onComplete }: BillingActionFormProps) {
  const { t } = useAppI18n();
  const stripe = useStripe();
  const elements = useElements();
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const paymentMethodLegendId = useId();
  const paymentPageTitleId = useId();
  const [selectedMethod, setSelectedMethod] = useState<BillingPaymentMethod>('card');
  const [cardholderName, setCardholderName] = useState('');
  const [countryCode, setCountryCode] = useState<string>(DEFAULT_COUNTRY);
  const paymentMethods: BillingPaymentMethod[] =
    flow.mode === 'subscription' ? ['card', 'amazon_pay'] : ['card'];
  const selectedCountryOption =
    ACCOUNT_COUNTRY_OPTIONS.find((option) => option.value === countryCode) ?? ACCOUNT_COUNTRY_OPTIONS[0];
  const paymentMethodOrder = ['amazon_pay', 'card'];

  useEffect(() => {
    setSelectedMethod('card');
  }, [flow.mode]);

  useEffect(() => {
    setError(null);
  }, [selectedMethod]);

  useEffect(() => {
    logBillingUi('billing-page-form-state', {
      mode: flow.mode,
      hasStripe: Boolean(stripe),
      hasElements: Boolean(elements),
      hasSubscriptionId: Boolean(flow.subscriptionId),
      selectedMethod,
    });
  }, [elements, flow.mode, flow.subscriptionId, selectedMethod, stripe]);

  const handleSubmit = async (event: React.FormEvent<HTMLFormElement>) => {
    event.preventDefault();
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

    logBillingUi('billing-page-submit-start', {
      mode: flow.mode,
      hasSubscriptionId: Boolean(flow.subscriptionId),
      selectedMethod,
    });

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

        logBillingUi('billing-page-confirm-payment-result', {
          hasError: Boolean(result.error),
          paymentIntentId: result.paymentIntent?.id ?? null,
          paymentIntentStatus: result.paymentIntent?.status ?? null,
          selectedMethod,
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

        logBillingUi('billing-page-confirm-setup-result', {
          hasError: Boolean(result.error),
          setupIntentId: result.setupIntent?.id ?? null,
          setupIntentStatus: result.setupIntent?.status ?? null,
          selectedMethod,
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

      logBillingUi('billing-page-confirm-payment-result', {
        hasError: Boolean(result.error),
        paymentIntentId: result.paymentIntent?.id ?? null,
        paymentIntentStatus: result.paymentIntent?.status ?? null,
        selectedMethod,
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
      setSubmitting(false);
      return;
    }

    setSubmitting(false);
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
                      onSelect={setSelectedMethod}
                    />
                  ))}
                </div>
              </fieldset>

              <div className="rvpb-billing-page__section-label" aria-hidden="true">
                <span>{t('Card details')}</span>
                <span className="rvpb-billing-page__section-label-mark">*</span>
              </div>

              {selectedMethod === 'card' ? (
                <div className="rvpb-billing-page__custom-card-fields">
                  <div className="rvpb-billing-page__field-row">
                    <label className="rvpb-billing-page__field rvpb-billing-page__field--wide">
                      <span className="rvpb-billing-page__field-label">
                        {t('Numéro de carte')} <span className="rvpb-billing-page__field-required">*</span>
                      </span>
                      <span className="rvpb-billing-page__stripe-shell">
                        <span className="rvpb-billing-page__stripe-input">
                          <CardNumberElement
                            options={{
                              disableLink: true,
                              showIcon: true,
                              style: stripeCardElementStyle,
                            }}
                          />
                        </span>
                      </span>
                    </label>

                    <label className="rvpb-billing-page__field rvpb-billing-page__field--narrow">
                      <span className="rvpb-billing-page__field-label">
                        {t('CVV')} <span className="rvpb-billing-page__field-required">*</span>
                      </span>
                      <span className="rvpb-billing-page__stripe-shell">
                        <span className="rvpb-billing-page__stripe-input">
                          <CardCvcElement
                            options={{
                              placeholder: t('CVV'),
                              style: stripeCardElementStyle,
                            }}
                          />
                        </span>
                      </span>
                    </label>
                  </div>

                  <div className="rvpb-billing-page__field-row">
                    <label className="rvpb-billing-page__field rvpb-billing-page__field--wide">
                      <span className="rvpb-billing-page__field-label">
                        {t('Name on card')} <span className="rvpb-billing-page__field-required">*</span>
                      </span>
                      <input
                        type="text"
                        className="rvpb-billing-page__text-input"
                        value={cardholderName}
                        onChange={(event) => setCardholderName(event.target.value)}
                        placeholder="Olivia Rhye"
                        autoComplete="cc-name"
                        disabled={submitting}
                      />
                    </label>

                    <label className="rvpb-billing-page__field rvpb-billing-page__field--narrow">
                      <span className="rvpb-billing-page__field-label">
                        {t('Expiry')} <span className="rvpb-billing-page__field-required">*</span>
                      </span>
                      <span className="rvpb-billing-page__stripe-shell">
                        <span className="rvpb-billing-page__stripe-input">
                          <CardExpiryElement
                            options={{
                              placeholder: 'MM / YY',
                              style: stripeCardElementStyle,
                            }}
                          />
                        </span>
                      </span>
                    </label>
                  </div>

                  <label className="rvpb-billing-page__field rvpb-billing-page__field--full">
                    <span className="rvpb-billing-page__field-label">
                      {t('Country')} <span className="rvpb-billing-page__field-required">*</span>
                    </span>
                    <span className="rvpb-billing-page__select-wrap">
                      <select
                        className="rvpb-billing-page__select-input"
                        value={countryCode}
                        onChange={(event) => setCountryCode(event.target.value)}
                        disabled={submitting}
                        autoComplete="country"
                      >
                        {ACCOUNT_COUNTRY_OPTIONS.map((option) => (
                          <option key={option.value} value={option.value}>
                            {option.label}
                          </option>
                        ))}
                      </select>
                      <span className="rvpb-billing-page__select-display" aria-hidden="true">
                        <span className="rvpb-billing-page__select-flag">
                          {flagEmojiFromCode(selectedCountryOption.flagCode)}
                        </span>
                        <span className="rvpb-billing-page__select-label">{selectedCountryOption.label}</span>
                      </span>
                      <span className="rvpb-billing-page__chevron" aria-hidden="true">
                        <ChevronDownIcon />
                      </span>
                    </span>
                  </label>
                </div>
              ) : (
                <div className="rvpb-billing-page__wallet-panel">
                  <PaymentElement
                    options={{
                      layout: {
                        type: 'accordion',
                        defaultCollapsed: false,
                      },
                      business: { name: 'RedView' },
                      paymentMethodOrder,
                      terms: { card: 'never' },
                      fields: {
                        billingDetails: {
                          name: 'auto',
                          email: 'never',
                          phone: 'never',
                          address: {
                            country: 'auto',
                            postalCode: 'never',
                            line1: 'never',
                            line2: 'never',
                            city: 'never',
                            state: 'never',
                          },
                        },
                      },
                    }}
                  />
                </div>
              )}

              <p className="rvpb-billing-page__legal">
                {t('En fournissant vos informations de carte bancaire, vous autorisez RedView à débiter votre carte pour les paiements futurs conformément à ses conditions. Les données de votre carte sont traitées par Stripe, RedView n’enregistre jamais le PAN complet.')}
              </p>

              <div className="rvpb-billing-page__actions">
                <button
                  type="button"
                  className="rvpb-billing-page__button rvpb-billing-page__button--ghost"
                  onClick={onClose}
                  disabled={submitting}
                >
                  {t('Annuler')}
                </button>
                <button
                  type="submit"
                  className="rvpb-billing-page__button rvpb-billing-page__button--primary"
                  disabled={submitting}
                >
                  {submitting ? t('Confirmation…') : t(flow.submitLabel)}
                </button>
              </div>
            </form>
          </section>
        </main>
      </div>
    </section>
  );
}

export function BillingActionModal({ flow, onClose, onComplete }: BillingActionModalProps) {
  const { t } = useAppI18n();

  useEffect(() => {
    logBillingUi('billing-page-render', {
      mode: flow.mode,
      hasClientSecret: Boolean(flow.clientSecret),
      hasSubscriptionId: Boolean(flow.subscriptionId),
      hasStripePromise: Boolean(stripePromise),
      hasPublishableKey: Boolean(publishableKey),
    });
  }, [flow]);

  useEffect(() => {
    if (typeof document === 'undefined') return undefined;

    document.body.classList.add('rvpb-billing-page-open');
    return () => {
      document.body.classList.remove('rvpb-billing-page-open');
    };
  }, []);

  if (!stripePromise) {
    logBillingUi('billing-page-stripe-unavailable', {
      mode: flow.mode,
      hasPublishableKey: Boolean(publishableKey),
    });

    const fallbackPage = (
      <section className="rvpb-billing-page" aria-label={t('Stripe indisponible')}>
        <div className="rvpb-billing-page__chrome">
          <header className="rvpb-billing-page__header">
            <RedViewWordmark />
          </header>
          <main className="rvpb-billing-page__main">
            <section className="rvpb-billing-page__content rvpb-billing-page__content--compact">
              <div className="rvpb-billing-page__intro">
                <h2>{t('Configuration Stripe incomplète')}</h2>
                <p>{t('Ajoutez VITE_STRIPE_PUBLISHABLE_KEY côté app pour activer la page de paiement intégrée.')}</p>
              </div>
              <div className="rvpb-billing-page__actions">
                <button
                  type="button"
                  className="rvpb-billing-page__button rvpb-billing-page__button--ghost"
                  onClick={onClose}
                >
                  {t('Annuler')}
                </button>
              </div>
            </section>
          </main>
        </div>
      </section>
    );

    return typeof document === 'undefined' ? fallbackPage : createPortal(fallbackPage, document.body);
  }

  const billingPage = (
    <Elements
      stripe={stripePromise}
      options={{
        clientSecret: flow.clientSecret,
        appearance,
      }}
    >
      <BillingActionForm flow={flow} onClose={onClose} onComplete={onComplete} />
    </Elements>
  );

  return typeof document === 'undefined' ? billingPage : createPortal(billingPage, document.body);
}
