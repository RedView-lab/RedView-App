import type Stripe from 'stripe';

import type { BillingPlanId } from '../config.js';

export type BillingContactPreference = {
  mode: 'account' | 'alternative';
  alternativeEmail: string;
};

export type PaymentMethodSummary = {
  brand: string;
  last4: string;
  expMonth: number;
  expYear: number;
};

export type SubscriptionSnapshot = {
  isSubscribed: boolean;
  status: string | null;
  priceId: string | null;
  currentPeriodEnd: string | null;
  cancelAtPeriodEnd: boolean;
};

export type SubscriptionActionResult = {
  subscriptionId: string;
  subscription: SubscriptionSnapshot;
  clientSecret: string | null;
  requiresPaymentConfirmation: boolean;
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

export type SetupIntentWithPaymentMethod = Stripe.SetupIntent & {
  payment_method: string | Stripe.PaymentMethod | null;
};

export type ExpandedInvoice = Stripe.Invoice & {
  payment_intent?: string | Stripe.PaymentIntent | null;
  confirmation_secret?: Stripe.Invoice.ConfirmationSecret | null;
};

export const DEFAULT_CONTACT_PREFERENCE: BillingContactPreference = {
  mode: 'account',
  alternativeEmail: '',
};

export const MANAGED_SUBSCRIPTION_STATUSES = new Set([
  'active',
  'trialing',
  'past_due',
  'unpaid',
  'incomplete',
]);

export function hasPaidSubscription(snapshot: SubscriptionSnapshot): boolean {
  return snapshot.isSubscribed && snapshot.status !== 'demo';
}

export function normalizeRequestedPlanId(planId: BillingPlanId): BillingPlanId {
  return planId;
}