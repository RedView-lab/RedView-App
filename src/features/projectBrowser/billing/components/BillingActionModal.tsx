import { useEffect, useId, useState } from 'react';

import { Elements, PaymentElement, useElements, useStripe } from '@stripe/react-stripe-js';
import { loadStripe } from '@stripe/stripe-js';

import { logBillingUi, logBillingUiError } from '../../lib';
import type { SubscriptionPlanId } from '../../types';

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

const publishableKey = import.meta.env.VITE_STRIPE_PUBLISHABLE_KEY?.trim() ?? '';
const stripePromise = publishableKey ? loadStripe(publishableKey) : null;
const subscriptionPaymentMethodOrder = ['card', 'amazon_pay'];
const cardOnlyPaymentMethodOrder = ['card'];

const appearance = {
  theme: 'night' as const,
  labels: 'above' as const,
  variables: {
    colorPrimary: '#890000',
    colorBackground: 'rgba(255,255,255,0.04)',
    colorText: '#ffffff',
    colorDanger: '#ff8e8e',
    colorTextPlaceholder: 'rgba(255, 255, 255, 0.48)',
    colorTextSecondary: 'rgba(255, 255, 255, 0.72)',
    colorIcon: 'rgba(255, 255, 255, 0.82)',
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
      minHeight: '90px',
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
    '.Input, .Block, .CodeInput': {
      backgroundColor: 'rgba(255,255,255,0.08)',
      border: '1px solid rgba(213,215,218,0.16)',
      boxShadow: '0 1px 2px rgba(10,13,18,0.05)',
    },
    '.Input:focus, .Block:focus, .CodeInput:focus': {
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
  const stripe = useStripe();
  const elements = useElements();
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const paymentMethodLegendId = useId();
  const paymentMethodOrder =
    flow.mode === 'subscription' ? subscriptionPaymentMethodOrder : cardOnlyPaymentMethodOrder;

  useEffect(() => {
    logBillingUi('billing-page-form-state', {
      mode: flow.mode,
      hasStripe: Boolean(stripe),
      hasElements: Boolean(elements),
      hasSubscriptionId: Boolean(flow.subscriptionId),
    });
  }, [elements, flow.mode, flow.subscriptionId, stripe]);

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
    });

    try {
      const submitResult = await elements.submit();
      if (submitResult.error) {
        throw new Error(submitResult.error.message);
      }

      if (flow.mode === 'payment-method') {
        const result = await stripe.confirmSetup({
          elements,
          redirect: 'if_required',
        });

        logBillingUi('billing-page-confirm-setup-result', {
          hasError: Boolean(result.error),
          setupIntentId: result.setupIntent?.id ?? null,
          setupIntentStatus: result.setupIntent?.status ?? null,
        });

        if (result.error) {
          throw new Error(result.error.message);
        }

        const setupIntentId = result.setupIntent?.id;
        if (!setupIntentId) {
          throw new Error('Stripe n’a pas renvoyé de SetupIntent exploitable.');
        }

        await onComplete({ mode: 'payment-method', setupIntentId });
        return;
      }

      const result = await stripe.confirmPayment({
        elements,
        redirect: 'if_required',
      });

      logBillingUi('billing-page-confirm-payment-result', {
        hasError: Boolean(result.error),
        paymentIntentId: result.paymentIntent?.id ?? null,
        paymentIntentStatus: result.paymentIntent?.status ?? null,
      });

      if (result.error) {
        throw new Error(result.error.message);
      }

      if (!flow.subscriptionId) {
        throw new Error('Aucun abonnement Stripe à synchroniser après confirmation.');
      }

      await onComplete({
        mode: 'subscription',
        subscriptionId: flow.subscriptionId,
      });
    } catch (nextError) {
      logBillingUiError('billing-page-submit-error', nextError, {
        mode: flow.mode,
        hasSubscriptionId: Boolean(flow.subscriptionId),
      });
      setError(
        nextError instanceof Error
          ? nextError.message
          : 'La confirmation Stripe a échoué.',
      );
      setSubmitting(false);
      return;
    }

    setSubmitting(false);
  };

  return (
    <div className="rvpb-billing-page" role="dialog" aria-modal="true" aria-label={flow.title}>
      <div className="rvpb-billing-page__chrome">
        <header className="rvpb-billing-page__header">
          <RedViewWordmark />
        </header>

        <main className="rvpb-billing-page__main">
          <section className="rvpb-billing-page__content">
            <div className="rvpb-billing-page__intro">
              <h2>{flow.title}</h2>
              <p>{flow.description}</p>
            </div>

            {error ? (
              <div className="rvpb-error rvpb-billing-page__error" role="alert">
                {error}
              </div>
            ) : null}

            <form className="rvpb-billing-page__form" onSubmit={handleSubmit}>
              <div className="rvpb-billing-page__section-label" aria-hidden="true">
                <span>Card details</span>
                <span className="rvpb-billing-page__section-label-mark">*</span>
              </div>

              <fieldset className="rvpb-billing-page__method-group" aria-labelledby={paymentMethodLegendId}>
                <legend id={paymentMethodLegendId}>Votre mode de paiement :</legend>
                <PaymentElement
                  options={{
                    layout: {
                      type: 'tabs',
                      defaultCollapsed: false,
                    },
                    business: { name: 'RedView' },
                    paymentMethodOrder: [...paymentMethodOrder],
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
              </fieldset>

              <p className="rvpb-billing-page__legal">
                En fournissant vos informations de carte bancaire, vous autorisez RedView à débiter votre carte pour les paiements futurs conformément à ses conditions. Les données de votre carte sont traitées par Stripe, RedView n’enregistre jamais le PAN complet.
              </p>

              <div className="rvpb-billing-page__actions">
                <button
                  type="button"
                  className="rvpb-billing-page__button rvpb-billing-page__button--ghost"
                  onClick={onClose}
                  disabled={submitting}
                >
                  Annuler
                </button>
                <button
                  type="submit"
                  className="rvpb-billing-page__button rvpb-billing-page__button--primary"
                  disabled={submitting}
                >
                  {submitting ? 'Confirmation…' : flow.submitLabel}
                </button>
              </div>
            </form>
          </section>
        </main>
      </div>
    </div>
  );
}

export function BillingActionModal({ flow, onClose, onComplete }: BillingActionModalProps) {
  useEffect(() => {
    logBillingUi('billing-page-render', {
      mode: flow.mode,
      hasClientSecret: Boolean(flow.clientSecret),
      hasSubscriptionId: Boolean(flow.subscriptionId),
      hasStripePromise: Boolean(stripePromise),
      hasPublishableKey: Boolean(publishableKey),
    });
  }, [flow]);

  if (!stripePromise) {
    logBillingUi('billing-page-stripe-unavailable', {
      mode: flow.mode,
      hasPublishableKey: Boolean(publishableKey),
    });

    return (
      <div className="rvpb-billing-page" role="dialog" aria-modal="true" aria-label="Stripe indisponible">
        <div className="rvpb-billing-page__chrome">
          <header className="rvpb-billing-page__header">
            <RedViewWordmark />
          </header>
          <main className="rvpb-billing-page__main">
            <section className="rvpb-billing-page__content rvpb-billing-page__content--compact">
              <div className="rvpb-billing-page__intro">
                <h2>Configuration Stripe incomplète</h2>
                <p>Ajoutez VITE_STRIPE_PUBLISHABLE_KEY côté app pour activer la page de paiement intégrée.</p>
              </div>
              <div className="rvpb-billing-page__actions">
                <button
                  type="button"
                  className="rvpb-billing-page__button rvpb-billing-page__button--ghost"
                  onClick={onClose}
                >
                  Annuler
                </button>
              </div>
            </section>
          </main>
        </div>
      </div>
    );
  }

  return (
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
}
