import Stripe from 'stripe';

import { requireEnv } from './config.js';

let stripe: Stripe | null = null;

export function getStripeServer(): Stripe {
  if (!stripe) {
    stripe = new Stripe(requireEnv('STRIPE_SECRET_KEY'));
  }

  return stripe;
}
