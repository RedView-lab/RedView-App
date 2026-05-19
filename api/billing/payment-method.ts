import type { VercelRequest, VercelResponse } from '@vercel/node';

import {
  applySetupIntentPaymentMethod,
  createPaymentMethodSetupIntent,
  setDefaultPaymentMethod,
} from '../_lib/billing.js';
import { readJsonBody, sendMethodNotAllowed } from '../_lib/http.js';
import { requireAuthenticatedUser } from '../_lib/supabase.js';

type PaymentMethodRequestBody = {
  setupIntentId?: string;
  paymentMethodId?: string;
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

    const body = await readJsonBody<PaymentMethodRequestBody>(req);

    if (body.paymentMethodId) {
      const overview = await setDefaultPaymentMethod(user.id, body.paymentMethodId);
      return res.status(200).json(overview);
    }

    if (!body.setupIntentId) {
      const result = await createPaymentMethodSetupIntent(user.id, user.email);
      return res.status(200).json(result);
    }

    const overview = await applySetupIntentPaymentMethod(user.id, body.setupIntentId);
    return res.status(200).json(overview);
  } catch (error) {
    console.error('[billing/payment-method] Error:', error);
    const message = error instanceof Error ? error.message : 'Unable to update the payment method';
    return res.status(500).json({ error: message });
  }
}