import type Stripe from 'stripe';

/** Évènements que traite api/stripe/webhook.ts : ceux du point de terminaison Stripe. */
export const WEBHOOK_EVENTS = [
  'setup_intent.succeeded',
  'customer.subscription.created',
  'customer.subscription.updated',
  'customer.subscription.deleted',
  'customer.subscription.paused',
  'customer.subscription.resumed',
  'customer.subscription.trial_will_end',
  'invoice.paid',
  'invoice.payment_failed',
  'invoice.payment_action_required',
  'invoice.upcoming',
] as const satisfies readonly Stripe.Event.Type[];
