import type { ApiRequest, ApiResponse } from '../_lib/types.js';

import { saveBillingContactPreference, toBillingError, type BillingContactPreference } from '../_lib/billing.js';
import { sendMethodNotAllowed, readJsonBody } from '../_lib/http.js';
import { requireAuthenticatedUser } from '../_lib/appwrite.js';
import { sendSafeError } from '../_lib/errors.js';

const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

function parsePreference(value: Record<string, unknown>): BillingContactPreference | null {
  const alternativeEmail = typeof value.alternativeEmail === 'string' ? value.alternativeEmail.trim() : '';
  if (value.mode === 'account') return { mode: 'account', alternativeEmail };
  if (value.mode === 'alternative' && alternativeEmail.length <= 254 && EMAIL_PATTERN.test(alternativeEmail)) {
    return { mode: 'alternative', alternativeEmail };
  }
  return null;
}

/** E-mail où partent reçus et factures (copié sur le client Stripe). */
export default async function handler(req: ApiRequest, res: ApiResponse) {
  if (req.method !== 'POST') {
    return sendMethodNotAllowed(res, ['POST']);
  }

  try {
    const user = await requireAuthenticatedUser(req, res);
    if (!user) return;

    const preference = parsePreference(await readJsonBody<Record<string, unknown>>(req));
    if (!preference) return res.status(400).json({ error: 'Invalid billing contact payload' });

    const saved = await saveBillingContactPreference(user.id, user.email, preference);
    return res.status(200).json({ contactPreference: saved });
  } catch (error) {
    return sendSafeError(res, toBillingError(error), 'Unable to save billing contact', 'billing/contact');
  }
}
