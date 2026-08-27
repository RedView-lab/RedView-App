import { useMemo, useState } from 'react';
import { createPortal } from 'react-dom';
import { Elements } from '@stripe/react-stripe-js';
import { loadStripe } from '@stripe/stripe-js';

import { appearance, type BillingPaymentMethod } from './billingModalStyles';
import {
  BillingActionForm,
  type BillingModalCompletion,
  type BillingModalState,
} from './BillingActionForm';

export type { BillingModalCompletion, BillingModalState } from './BillingActionForm';

const publishableKey = import.meta.env.VITE_STRIPE_PUBLISHABLE_KEY?.trim() ?? '';
const stripePromise = publishableKey ? loadStripe(publishableKey) : null;

export type BillingActionModalProps = {
  flow: BillingModalState;
  onClose: () => void;
  onComplete: (completion: BillingModalCompletion) => Promise<void>;
};

/**
 * Modale d'action Stripe Billing (abonnement ou mise à jour de moyen de paiement).
 */
export function BillingActionModal({ flow, onClose, onComplete }: BillingActionModalProps) {
  const [selectedMethod, setSelectedMethod] = useState<BillingPaymentMethod>('card');

  const elementsOptions = useMemo(
    () => ({
      clientSecret: flow.clientSecret,
      appearance,
      paymentMethodCreation: 'manual' as const,
      paymentMethodOrder: ['amazon_pay', 'card'],
      payment_method_types: flow.mode === 'subscription' ? ['card', 'amazon_pay'] : ['card'],
    }),
    [flow.clientSecret, flow.mode],
  );

  if (!stripePromise || !flow.clientSecret) {
    return null;
  }

  const modalNode = (
    <div className="rvpb-billing-page-overlay" role="dialog" aria-modal="true">
      <Elements
        key={`${flow.clientSecret}-${flow.mode}-${selectedMethod}`}
        stripe={stripePromise}
        options={elementsOptions}
      >
        <BillingActionForm
          flow={flow}
          onClose={onClose}
          onComplete={onComplete}
          selectedMethod={selectedMethod}
          onSelectedMethodChange={setSelectedMethod}
        />
      </Elements>
    </div>
  );

  if (typeof document === 'undefined') {
    return modalNode;
  }

  return createPortal(modalNode, document.body);
}
