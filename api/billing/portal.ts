import type { ApiRequest, ApiResponse } from '../_lib/types.js';

import { billingReturnUrl, createBillingPortalSession, isBillingPlanId, toBillingError } from '../_lib/billing.js';
import { readJsonBody, sendMethodNotAllowed } from '../_lib/http.js';
import { requireAuthenticatedUser } from '../_lib/appwrite.js';
import { sendSafeError } from '../_lib/errors.js';

/**
 * Ouvre le portail client Stripe (factures, moyens de paiement, coordonnées).
 * Avec `planId`, directement sur la confirmation du passage à cette durée.
 */
export default async function handler(req: ApiRequest, res: ApiResponse) {
  if (req.method !== 'POST') {
    return sendMethodNotAllowed(res, ['POST']);
  }

  try {
    const user = await requireAuthenticatedUser(req, res);
    if (!user) return;

    const body = await readJsonBody<Record<string, unknown>>(req);
    if (body.planId !== undefined && !isBillingPlanId(body.planId)) {
      return res.status(400).json({ error: 'Invalid plan selection.' });
    }
    const url = await createBillingPortalSession(
      user.id,
      billingReturnUrl(req),
      isBillingPlanId(body.planId) ? body.planId : null,
    );
    return res.status(200).json({ url });
  } catch (error) {
    return sendSafeError(res, toBillingError(error), 'Unable to open the billing portal', 'billing/portal');
  }
}
