import type { VercelRequest, VercelResponse } from '@vercel/node';

import {
  changeManagedSubscriptionPlan,
  createManagedSubscription,
  getSubscriptionSnapshot,
  hasPaidSubscription,
  normalizeRequestedPlanId,
  setManagedSubscriptionCancellation,
  syncManagedSubscription,
} from '../_lib/billing';
import { isBillingPlanId } from '../_lib/config';
import { readJsonBody, sendMethodNotAllowed } from '../_lib/http';
import { requireAuthenticatedUser } from '../_lib/supabase';

type SubscriptionActionRequestBody = {
  action?: 'subscribe' | 'change' | 'cancel' | 'resume' | 'sync';
  planId?: string;
  subscriptionId?: string;
};

export default async function handler(req: VercelRequest, res: VercelResponse) {
  if (req.method !== 'POST') {
    return sendMethodNotAllowed(res, ['POST']);
  }

  try {
    const user = await requireAuthenticatedUser(req, res);
    if (!user) {
      return;
    }

    const body = await readJsonBody<SubscriptionActionRequestBody>(req);
    if (!body.action) {
      return res.status(400).json({ error: 'Missing billing action.' });
    }

    if (body.action === 'sync') {
      if (!body.subscriptionId) {
        return res.status(400).json({ error: 'Missing Stripe subscription id.' });
      }

      const result = await syncManagedSubscription(user.id, body.subscriptionId);
      return res.status(200).json(result);
    }

    if (body.action === 'cancel' || body.action === 'resume') {
      const result = await setManagedSubscriptionCancellation(user.id, body.action === 'cancel');
      return res.status(200).json(result);
    }

    if (!body.planId || !isBillingPlanId(body.planId)) {
      return res.status(400).json({ error: 'Invalid plan selection.' });
    }

    const requestedPlanId = normalizeRequestedPlanId(body.planId);
    const snapshot = await getSubscriptionSnapshot(user.id);

    if (body.action === 'subscribe') {
      if (hasPaidSubscription(snapshot)) {
        return res.status(409).json({
          error: 'This account already has a paid subscription. Use the in-app plan change flow instead.',
        });
      }

      const result = await createManagedSubscription(user.id, user.email, requestedPlanId);
      return res.status(200).json(result);
    }

    if (body.action === 'change') {
      if (!hasPaidSubscription(snapshot)) {
        return res.status(409).json({
          error: 'No paid subscription is active on this account yet.',
        });
      }

      const result = await changeManagedSubscriptionPlan(user.id, requestedPlanId);
      return res.status(200).json(result);
    }

    return res.status(400).json({ error: 'Unsupported billing action.' });
  } catch (error) {
    console.error('[billing/subscription] Error:', error);
    const message = error instanceof Error ? error.message : 'Unable to update the subscription';
    const status = message.includes('Missing Stripe price ID') ? 503 : 500;
    return res.status(status).json({ error: message });
  }
}