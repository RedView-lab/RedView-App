import type { ApiRequest, ApiResponse } from '../_lib/types.js';

import {
  applySetupIntentPaymentMethod,
  createPaymentMethodSetupIntent,
  setDefaultPaymentMethod,
  toBillingError,
} from '../_lib/billing.js';
import { readJsonBody, sendMethodNotAllowed } from '../_lib/http.js';
import { requireAuthenticatedUser } from '../_lib/appwrite.js';
import { sendSafeError } from '../_lib/errors.js';

/**
 * Sans corps : SetupIntent pour ajouter un moyen de paiement ;
 * `setupIntentId` : le moyen confirmé devient celui par défaut ;
 * `paymentMethodId` : un moyen déjà enregistré devient celui par défaut.
 */
export default async function handler(req: ApiRequest, res: ApiResponse) {
  if (req.method !== 'POST') {
    return sendMethodNotAllowed(res, ['POST']);
  }

  try {
    const user = await requireAuthenticatedUser(req, res);
    if (!user) return;

    const body = await readJsonBody<Record<string, unknown>>(req);

    if (typeof body.paymentMethodId === 'string' && body.paymentMethodId) {
      return res.status(200).json(await setDefaultPaymentMethod(user.id, body.paymentMethodId));
    }
    if (typeof body.setupIntentId === 'string' && body.setupIntentId) {
      return res.status(200).json(await applySetupIntentPaymentMethod(user.id, body.setupIntentId));
    }
    return res.status(200).json(await createPaymentMethodSetupIntent(user.id, user.email));
  } catch (error) {
    return sendSafeError(res, toBillingError(error), 'Unable to update the payment method', 'billing/payment-method');
  }
}
