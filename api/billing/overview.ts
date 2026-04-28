import type { VercelRequest, VercelResponse } from '@vercel/node';

import { buildBillingOverview } from '../_lib/billing.js';
import { sendMethodNotAllowed } from '../_lib/http.js';
import { requireAuthenticatedUser } from '../_lib/supabase.js';

export default async function handler(req: VercelRequest, res: VercelResponse) {
  if (req.method !== 'GET') {
    return sendMethodNotAllowed(res, ['GET']);
  }

  try {
    const user = await requireAuthenticatedUser(req, res);
    if (!user) {
      return;
    }

    const overview = await buildBillingOverview(user.id);
    return res.status(200).json(overview);
  } catch (error) {
    console.error('[billing/overview] Error:', error);
    const message = error instanceof Error ? error.message : 'Unable to load billing overview';
    const status = message.includes('Missing required environment variable') ? 503 : 500;
    return res.status(status).json({ error: message });
  }
}
