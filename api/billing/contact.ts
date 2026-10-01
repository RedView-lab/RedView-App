import type { ApiRequest, ApiResponse } from '../_lib/types.js';

import type { BillingContactPreference } from '../_lib/billing.js';
import { saveBillingContactPreference } from '../_lib/billing.js';
import { sendMethodNotAllowed, readJsonBody } from '../_lib/http.js';
import { requireAuthenticatedUser } from '../_lib/appwrite.js';
import { PublicError, sendSafeError } from '../_lib/errors.js';

function isValidPreference(value: BillingContactPreference): boolean {
  if (value.mode !== 'account' && value.mode !== 'alternative') {
    return false;
  }

  if (value.mode === 'alternative' && !value.alternativeEmail.trim()) {
    return false;
  }

  return true;
}

export default async function handler(req: ApiRequest, res: ApiResponse) {
  if (req.method !== 'POST') {
    return sendMethodNotAllowed(res, ['POST']);
  }

  try {
    const user = await requireAuthenticatedUser(req, res);
    if (!user) {
      return;
    }

    const body = await readJsonBody<BillingContactPreference>(req);
    if (!isValidPreference(body)) {
      return res.status(400).json({ error: 'Invalid billing contact payload' });
    }

    const preference = await saveBillingContactPreference(user.id, body);
    return res.status(200).json({ contactPreference: preference });
  } catch (error) {
    // Schéma Appwrite pas encore migré (attribut manquant) → 409 explicite,
    // sans relayer le message brut de l'erreur.
    const rawMessage = error instanceof Error ? error.message : '';
    const safeError = rawMessage.includes('migration')
      ? new PublicError('Billing contact storage is not available yet.', 409)
      : error;
    if (safeError !== error) {
      console.error('[billing/contact] Error:', error);
    }
    return sendSafeError(res, safeError, 'Unable to save billing contact', 'billing/contact');
  }
}
