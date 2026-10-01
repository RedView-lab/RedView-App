import type { ApiRequest, ApiResponse } from '../_lib/types.js';

import { buildBillingOverview } from '../_lib/billing.js';
import { sendMethodNotAllowed } from '../_lib/http.js';
import { requireAuthenticatedUser } from '../_lib/appwrite.js';
import { sendSafeError } from '../_lib/errors.js';

export default async function handler(req: ApiRequest, res: ApiResponse) {
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
    // Config manquante → PublicError 503 levée par requireEnv (cf. _lib/config.ts).
    return sendSafeError(res, error, 'Unable to load billing overview', 'billing/overview');
  }
}
