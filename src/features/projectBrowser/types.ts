export interface ProjectBrowserOverlayProps {
  open: boolean;
  displayName: string;
  onOpenProject: (projectId: string) => void;
  onRequestClose: () => void;
  canClose?: boolean;
}

export type OverlayTab = 'projects' | 'account' | 'subscription' | 'settings';
/** Durée de l'abonnement RedView (un seul abonnement, trois durées). */
export type SubscriptionPlanId = 'monthly' | 'semiannual' | 'annual';

export type SubscriptionSnapshot = {
  /** Identifiant Stripe : référence du contrat montrée à la résiliation. */
  subscriptionId: string | null;
  /** Abonnement qui donne accès : en essai ou payé à jour. */
  isSubscribed: boolean;
  /** Statut Stripe (`trialing`, `active`, `past_due`…), ou `none`. */
  status: string;
  planId: SubscriptionPlanId | null;
  priceId: string | null;
  /** Fin de l'échéance en cours — fin de l'essai quand `status` = `trialing`. */
  currentPeriodEnd: string | null;
  cancelAtPeriodEnd: boolean;
};

export type SubscriptionState = {
  isLoading: boolean;
  error: string | null;
  snapshot: SubscriptionSnapshot | null;
  /** L'essai gratuit est encore disponible (jamais deux fois par compte). */
  trialEligible: boolean;
};

export type PaymentMethodSummary = {
  id: string;
  /** Type Stripe (`card`, `paypal`, `sepa_debit`…). */
  type: string;
  brand: string;
  /** Vide pour les moyens sans numéro (PayPal). */
  last4: string;
  expMonth: number | null;
  expYear: number | null;
  isDefault: boolean;
};

export type BillingContactPreference = {
  mode: 'account' | 'alternative';
  alternativeEmail: string;
};

