import type { VercelRequest, VercelResponse } from '@vercel/node';

import { createPortalSession, getStripeCustomerId } from '../_lib/billing.js';
import { getAppBaseUrl } from '../_lib/config.js';
import { sendMethodNotAllowed } from '../_lib/http.js';
import { requireAuthenticatedUser } from '../_lib/supabase.js';

export default async function handler(req: VercelRequest, res: VercelResponse) {
  if (req.method !== 'POST') {
    return sendMethodNotAllowed(res, ['POST']);
  }

  try {
    const user = await requireAuthenticatedUser(req, res);
    if (!user) {
      return;
    }

    const stripeCustomerId = await getStripeCustomerId(user.id);
    if (!stripeCustomerId) {
      return res.status(404).json({ error: 'No Stripe customer found for this account' });
    }

    const url = await createPortalSession(
      stripeCustomerId,
      `${getAppBaseUrl(req)}/?billing=portal`,
    );

    return res.status(200).json({ url });
  } catch (error) {
    console.error('[billing/portal] Error:', error);
    return res.status(500).json({ error: 'Unable to open billing portal' });
  }
}
