import type { VercelRequest, VercelResponse } from '@vercel/node';

import type { BillingContactPreference } from '../_lib/billing.js';
import { saveBillingContactPreference } from '../_lib/billing.js';
import { sendMethodNotAllowed, readJsonBody } from '../_lib/http.js';
import { requireAuthenticatedUser } from '../_lib/supabase.js';

function isValidPreference(value: BillingContactPreference): boolean {
  if (value.mode !== 'account' && value.mode !== 'alternative') {
    return false;
  }

  if (value.mode === 'alternative' && !value.alternativeEmail.trim()) {
    return false;
  }

  return true;
}

export default async function handler(req: VercelRequest, res: VercelResponse) {
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
    console.error('[billing/contact] Error:', error);
    const message = error instanceof Error ? error.message : 'Unable to save billing contact';
    const status = message.includes('migration') ? 409 : 500;
    return res.status(status).json({ error: message });
  }
}
