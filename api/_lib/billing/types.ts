import type Stripe from 'stripe';

import type { BillingPlanId } from './plans.js';

export type BillingContactPreference = {
  mode: 'account' | 'alternative';
  alternativeEmail: string;
};

export type PaymentMethodSummary = {
  id: string;
  /** Type Stripe (`card`, `paypal`, `sepa_debit`…). */
  type: string;
  /** Réseau de la carte, ou le type pour les autres moyens. */
  brand: string;
  /** Quatre derniers chiffres, vide quand le moyen n'en a pas (PayPal). */
  last4: string;
  expMonth: number | null;
  expYear: number | null;
  isDefault: boolean;
};

export type SubscriptionSnapshot = {
  /** Identifiant Stripe (référence du contrat montrée à la résiliation). */
  subscriptionId: string | null;
  /** Abonnement qui donne accès : en essai ou payé à jour. */
  isSubscribed: boolean;
  /** Statut Stripe, ou `none` sans abonnement. */
  status: string;
  planId: BillingPlanId | null;
  priceId: string | null;
  /** Fin de l'échéance en cours — fin de l'essai quand `status` = `trialing`. */
  currentPeriodEnd: string | null;
  cancelAtPeriodEnd: boolean;
};

/** Réponse de `start` : ce que le Payment Element doit confirmer. */
export type SubscriptionStartResult =
  | {
      /** Essai : enregistrer le moyen de paiement (SetupIntent), rien n'est prélevé. */
      intent: 'setup';
      clientSecret: string;
      setupIntentId: string;
      planId: BillingPlanId;
      trialDays: number;
    }
  | {
      /** Sans essai : payer la première facture de l'abonnement créé. */
      intent: 'payment';
      clientSecret: string;
      subscriptionId: string;
      planId: BillingPlanId;
    };

export type SubscriptionActionResult = {
  subscriptionId: string;
  subscription: SubscriptionSnapshot;
};

export type CustomerRow = {
  stripe_customer_id: string | null;
  billing_email_mode?: string | null;
  billing_email?: string | null;
};

export type StoredSubscriptionRow = {
  id: string;
  status: string | null;
  price_id: string | null;
  cancel_at_period_end: boolean | null;
  current_period_end: string | null;
};

export type ExpandedInvoice = Stripe.Invoice & {
  confirmation_secret?: Stripe.Invoice.ConfirmationSecret | null;
};

export const DEFAULT_CONTACT_PREFERENCE: BillingContactPreference = {
  mode: 'account',
  alternativeEmail: '',
};

/** Statuts qui donnent accès à RedView. */
export const ENTITLED_SUBSCRIPTION_STATUSES: ReadonlySet<string> = new Set(['active', 'trialing']);

/**
 * Statuts d'un abonnement encore vivant chez Stripe : en cours, en essai, ou
 * en impayé que Stripe relance. Un client n'en a jamais deux à la fois.
 */
export const LIVE_SUBSCRIPTION_STATUSES: ReadonlySet<string> = new Set([
  'active',
  'trialing',
  'past_due',
  'unpaid',
  'paused',
]);

/** Ordre d'affichage quand un compte a plusieurs lignes d'abonnement. */
const STATUS_RANK: Record<string, number> = {
  active: 0,
  trialing: 0,
  past_due: 1,
  unpaid: 2,
  paused: 3,
  incomplete: 4,
};

/**
 * L'abonnement à montrer parmi les lignes d'un compte : le plus « vivant »,
 * puis l'échéance la plus lointaine. Les abonnements terminés ou abandonnés
 * (`canceled`, `incomplete_expired`) ne comptent plus.
 */
export function pickCurrentSubscription<T extends Pick<StoredSubscriptionRow, 'status' | 'current_period_end'>>(
  rows: readonly T[],
): T | null {
  const candidates = rows.filter((row) => row.status != null && row.status in STATUS_RANK);
  candidates.sort((left, right) => {
    const rank = STATUS_RANK[left.status!] - STATUS_RANK[right.status!];
    if (rank !== 0) return rank;
    const leftTime = left.current_period_end ? Date.parse(left.current_period_end) : 0;
    const rightTime = right.current_period_end ? Date.parse(right.current_period_end) : 0;
    return rightTime - leftTime;
  });
  return candidates[0] ?? null;
}

/**
 * Essai gratuit une seule fois par client : refusé dès qu'un abonnement a
 * existé au-delà de la tentative de paiement (essai démarré, payé, annulé…).
 */
export function isTrialEligible(subscriptions: readonly Pick<Stripe.Subscription, 'status' | 'trial_start'>[]): boolean {
  return subscriptions.every(
    (subscription) =>
      subscription.trial_start == null &&
      (subscription.status === 'incomplete' || subscription.status === 'incomplete_expired'),
  );
}
