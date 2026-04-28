import Stripe from 'stripe';

import { requireEnv } from './config';

let stripe: Stripe | null = null;

export function getStripeServer(): Stripe {
  if (!stripe) {
    stripe = new Stripe(requireEnv('STRIPE_SECRET_KEY'));
  }

  return stripe;
}
