import type { VercelRequest, VercelResponse } from '@vercel/node';

import {
  getOrCreateStripeCustomer,
  getSubscriptionSnapshot,
  hasPaidSubscription,
  normalizeRequestedPlanId,
} from '../_lib/billing';
import {
  getAppBaseUrl,
  isBillingPlanId,
  requireConfiguredPriceId,
} from '../_lib/config';
import { readJsonBody, sendMethodNotAllowed } from '../_lib/http';
import { requireAuthenticatedUser } from '../_lib/supabase';
import { getStripeServer } from '../_lib/stripe';

type CheckoutRequestBody = {
  planId?: string;
};

export default async function handler(req: VercelRequest, res: VercelResponse) {
  if (req.method !== 'POST') {
    return sendMethodNotAllowed(res, ['POST']);
  }

  const user = await requireAuthenticatedUser(req, res);
  if (!user) {
    return;
  }

  try {
    const body = await readJsonBody<CheckoutRequestBody>(req);
    if (!body.planId || !isBillingPlanId(body.planId)) {
      return res.status(400).json({ error: 'Invalid plan selection' });
    }

    const requestedPlanId = normalizeRequestedPlanId(body.planId);
    const snapshot = await getSubscriptionSnapshot(user.id);
    if (hasPaidSubscription(snapshot)) {
      return res.status(409).json({
        error: 'This account already has a paid subscription. Use the billing portal to change plan.',
      });
    }

    const stripeCustomerId = await getOrCreateStripeCustomer(user.id, user.email);
    const priceId = requireConfiguredPriceId(requestedPlanId);
    const appBaseUrl = getAppBaseUrl(req);

    const session = await getStripeServer().checkout.sessions.create({
      customer: stripeCustomerId,
      mode: 'subscription',
      line_items: [
        {
          price: priceId,
          quantity: 1,
        },
      ],
      allow_promotion_codes: true,
      billing_address_collection: 'auto',
      success_url: `${appBaseUrl}/?billing=success&session_id={CHECKOUT_SESSION_ID}`,
      cancel_url: `${appBaseUrl}/?billing=cancel`,
      subscription_data: {
        metadata: {
          user_id: user.id,
          plan_id: requestedPlanId,
        },
      },
      metadata: {
        user_id: user.id,
        plan_id: requestedPlanId,
      },
    });

    if (!session.url) {
      return res.status(500).json({ error: 'Failed to create checkout session' });
    }

    return res.status(200).json({ url: session.url });
  } catch (error) {
    console.error('[billing/checkout] Error:', error);
    const message = error instanceof Error ? error.message : 'Unable to create checkout session';
    const status = message.includes('Missing Stripe price ID') ? 503 : 500;
    return res.status(status).json({ error: message });
  }
}
