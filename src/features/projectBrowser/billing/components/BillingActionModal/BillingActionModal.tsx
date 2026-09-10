import { Component, type ReactNode, useEffect, useMemo } from 'react';
import { createPortal } from 'react-dom';
import { Elements } from '@stripe/react-stripe-js';
import { loadStripe } from '@stripe/stripe-js';

import { appearance } from './billingModalStyles';
import {
  BillingActionForm,
  type BillingModalCompletion,
  type BillingModalState,
} from './BillingActionForm';

export type { BillingModalCompletion, BillingModalState } from './BillingActionForm';

const publishableKey = import.meta.env.VITE_STRIPE_PUBLISHABLE_KEY?.trim() ?? '';
const stripePromise = publishableKey ? loadStripe(publishableKey) : null;

class BillingModalErrorBoundary extends Component<
  { children: ReactNode; onClose: () => void },
  { hasError: boolean; error: Error | null }
> {
  constructor(props: { children: ReactNode; onClose: () => void }) {
    super(props);
    this.state = { hasError: false, error: null };
  }

  static getDerivedStateFromError(error: Error) {
    return { hasError: true, error };
  }

  componentDidCatch(error: Error, errorInfo: unknown) {
    console.error('[BillingModalErrorBoundary] Uncaught error:', error, errorInfo);
  }

  render() {
    if (this.state.hasError) {
      return (
        <div className="rvpb-billing-page" style={{ padding: '40px', textAlign: 'center' }}>
          <h2>Une erreur est survenue lors du chargement de la page de paiement</h2>
          <p style={{ color: '#ff8e8e', margin: '16px 0' }}>
            {this.state.error?.message || 'Erreur inattendue'}
          </p>
          <button
            type="button"
            className="rvpb-billing-page__cancel"
            onClick={this.props.onClose}
          >
            Fermer
          </button>
        </div>
      );
    }
    return this.props.children;
  }
}

export type BillingActionModalProps = {
  flow: BillingModalState;
  onClose: () => void;
  onComplete: (completion: BillingModalCompletion) => Promise<void>;
  onUpdateAmount?: (amount: number) => Promise<void>;
};

/**
 * Modale d'action Stripe Billing (abonnement ou mise à jour de moyen de paiement).
 */
export function BillingActionModal({
  flow,
  onClose,
  onComplete,
  onUpdateAmount,
}: BillingActionModalProps) {
  useEffect(() => {
    document.body.classList.add('rvpb-billing-page-open');
    return () => {
      document.body.classList.remove('rvpb-billing-page-open');
    };
  }, []);

  const elementsOptions = useMemo(
    () => ({
      clientSecret: flow.clientSecret,
      appearance,
    }),
    [flow.clientSecret],
  );

  if (!stripePromise || !flow.clientSecret) {
    return null;
  }

  const modalNode = (
    <BillingModalErrorBoundary onClose={onClose}>
      <div className="rvpb-billing-page-overlay" role="dialog" aria-modal="true">
        <Elements
          key={flow.clientSecret}
          stripe={stripePromise}
          options={elementsOptions}
        >
          <BillingActionForm
            flow={flow}
            onClose={onClose}
            onComplete={onComplete}
            onUpdateAmount={onUpdateAmount}
          />
        </Elements>
      </div>
    </BillingModalErrorBoundary>
  );

  if (typeof document === 'undefined') {
    return modalNode;
  }

  return createPortal(modalNode, document.body);
}
