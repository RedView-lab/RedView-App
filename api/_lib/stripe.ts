import Stripe from 'stripe';

import { requireEnv } from './config.js';

let stripe: Stripe | null = null;
let currentStripeKey: string | null = null;

export function getStripeServer(): Stripe {
  const secretKey = requireEnv('STRIPE_SECRET_KEY');
  if (!stripe || currentStripeKey !== secretKey) {
    stripe = new Stripe(secretKey);
    currentStripeKey = secretKey;
  }

  return stripe;
}

