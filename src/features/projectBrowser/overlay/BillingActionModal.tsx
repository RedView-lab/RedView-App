import { useEffect, useState } from 'react';

import { Elements, PaymentElement, useElements, useStripe } from '@stripe/react-stripe-js';
import { loadStripe } from '@stripe/stripe-js';

import { SvgV2Icon } from '@/components/SvgV2Icon';

import { logBillingUi, logBillingUiError } from './debug';
import type { SubscriptionPlanId } from './types';

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

const appearance = {
  theme: 'night' as const,
  labels: 'floating' as const,
  variables: {
    colorPrimary: '#c55454',
    colorBackground: '#101010',
    colorText: '#f7f7f7',
    colorDanger: '#ff8e8e',
    borderRadius: '12px',
    fontFamily: 'Rethink Sans, system-ui, sans-serif',
  },
};

type BillingActionModalProps = {
  flow: BillingModalState;
  onClose: () => void;
  onComplete: (completion: BillingModalCompletion) => Promise<void>;
};

type BillingActionFormProps = BillingActionModalProps;

function BillingActionForm({ flow, onClose, onComplete }: BillingActionFormProps) {
  const stripe = useStripe();
  const elements = useElements();
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    logBillingUi('billing-modal-form-state', {
      mode: flow.mode,
      hasStripe: Boolean(stripe),
      hasElements: Boolean(elements),
      hasSubscriptionId: Boolean(flow.subscriptionId),
    });
  }, [elements, flow.mode, flow.subscriptionId, stripe]);

  const handleSubmit = async (event: React.FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (!stripe || !elements) {
      logBillingUi('billing-modal-submit-blocked', {
        mode: flow.mode,
        hasStripe: Boolean(stripe),
        hasElements: Boolean(elements),
      });
      return;
    }

    setSubmitting(true);
    setError(null);

    logBillingUi('billing-modal-submit-start', {
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

        logBillingUi('billing-modal-confirm-setup-result', {
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

      logBillingUi('billing-modal-confirm-payment-result', {
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
      logBillingUiError('billing-modal-submit-error', nextError, {
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
    <div className="rvpb-billing-modal" role="dialog" aria-modal="true" aria-label={flow.title}>
      <div className="rvpb-billing-modal__backdrop" onClick={submitting ? undefined : onClose} />

      <div className="rvpb-billing-modal__sheet">
        <div className="rvpb-billing-modal__header">
          <div className="rvpb-billing-modal__title-stack">
            <span className="rvpb-billing-modal__eyebrow">Facturation Stripe intégrée</span>
            <h3>{flow.title}</h3>
            <p>{flow.description}</p>
          </div>

          <button
            type="button"
            className="rvpb-billing-modal__close"
            onClick={onClose}
            disabled={submitting}
            aria-label="Fermer"
          >
            <SvgV2Icon name="x-close.svg" size={18} />
          </button>
        </div>

        {error ? (
          <div className="rvpb-error" role="alert">
            {error}
          </div>
        ) : null}

        <form className="rvpb-billing-modal__form" onSubmit={handleSubmit}>
          <div className="rvpb-billing-modal__element-shell">
            <PaymentElement options={{ layout: 'tabs' }} />
          </div>

          <div className="rvpb-billing-modal__footer">
            <p className="rvpb-inline-note">
              Les données de carte restent traitées par Stripe. RedView n’enregistre jamais le PAN complet.
            </p>

            <div className="rvpb-billing-modal__actions">
              <button
                type="button"
                className="rvpb-inline-cta rvpb-billing-modal__secondary"
                onClick={onClose}
                disabled={submitting}
              >
                Annuler
              </button>
              <button type="submit" className="rvpb-inline-cta" disabled={submitting}>
                {submitting ? 'Confirmation…' : flow.submitLabel}
              </button>
            </div>
          </div>
        </form>
      </div>
    </div>
  );
}

export function BillingActionModal({ flow, onClose, onComplete }: BillingActionModalProps) {
  useEffect(() => {
    logBillingUi('billing-modal-render', {
      mode: flow.mode,
      hasClientSecret: Boolean(flow.clientSecret),
      hasSubscriptionId: Boolean(flow.subscriptionId),
      hasStripePromise: Boolean(stripePromise),
      hasPublishableKey: Boolean(publishableKey),
    });
  }, [flow]);

  if (!stripePromise) {
    logBillingUi('billing-modal-stripe-unavailable', {
      mode: flow.mode,
      hasPublishableKey: Boolean(publishableKey),
    });

    return (
      <div className="rvpb-billing-modal" role="dialog" aria-modal="true" aria-label="Stripe indisponible">
        <div className="rvpb-billing-modal__backdrop" onClick={onClose} />
        <div className="rvpb-billing-modal__sheet">
          <div className="rvpb-billing-modal__header">
            <div className="rvpb-billing-modal__title-stack">
              <span className="rvpb-billing-modal__eyebrow">Facturation Stripe intégrée</span>
              <h3>Configuration Stripe incomplète</h3>
              <p>Ajoutez VITE_STRIPE_PUBLISHABLE_KEY côté app pour activer la page de paiement intégrée.</p>
            </div>
            <button
              type="button"
              className="rvpb-billing-modal__close"
              onClick={onClose}
              aria-label="Fermer"
            >
              <SvgV2Icon name="x-close.svg" size={18} />
            </button>
          </div>
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