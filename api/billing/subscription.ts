import type { ApiRequest, ApiResponse } from '../_lib/types.js';

import {
  activateTrialForUser,
  isBillingPlanId,
  setSubscriptionCancellation,
  startSubscription,
  syncSubscription,
  toBillingError,
} from '../_lib/billing.js';
import { readJsonBody, sendMethodNotAllowed } from '../_lib/http.js';
import { rejectUnverifiedEmail, requireAuthenticatedUser } from '../_lib/appwrite.js';
import { sendSafeError } from '../_lib/errors.js';

/**
 * Actions sur l'abonnement du compte connecté :
 *  - `start` { planId } : lance la souscription (essai ou premier paiement) ;
 *  - `activate` { setupIntentId } : crée l'abonnement en essai une fois le
 *    moyen de paiement confirmé ;
 *  - `sync` { subscriptionId } : relit l'abonnement après un paiement ;
 *  - `cancel` / `resume` : résiliation à la fin de l'échéance, et son annulation.
 * Le changement de durée passe par le portail Stripe (`/api/billing/portal`).
 */
export default async function handler(req: ApiRequest, res: ApiResponse) {
  if (req.method !== 'POST') {
    return sendMethodNotAllowed(res, ['POST']);
  }

  try {
    const user = await requireAuthenticatedUser(req, res);
    if (!user) return;

    const body = await readJsonBody<Record<string, unknown>>(req);
    const action = body.action;

    if (action === 'start') {
      if (rejectUnverifiedEmail(user, res)) return;
      if (!isBillingPlanId(body.planId)) return res.status(400).json({ error: 'Invalid plan selection.' });
      return res.status(200).json(await startSubscription(user.id, user.email, body.planId));
    }

    if (action === 'activate') {
      if (typeof body.setupIntentId !== 'string' || !body.setupIntentId.startsWith('seti_')) {
        return res.status(400).json({ error: 'Missing payment setup id.' });
      }
      return res.status(200).json(await activateTrialForUser(user.id, body.setupIntentId));
    }

    if (action === 'sync') {
      if (typeof body.subscriptionId !== 'string' || !body.subscriptionId.startsWith('sub_')) {
        return res.status(400).json({ error: 'Missing subscription id.' });
      }
      return res.status(200).json(await syncSubscription(user.id, body.subscriptionId));
    }

    if (action === 'cancel' || action === 'resume') {
      return res.status(200).json(await setSubscriptionCancellation(user.id, action === 'cancel'));
    }

    return res.status(400).json({ error: 'Unsupported billing action.' });
  } catch (error) {
    return sendSafeError(res, toBillingError(error), 'Unable to update the subscription', 'billing/subscription');
  }
}
