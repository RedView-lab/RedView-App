import type { ApiRequest, ApiResponse } from '../_lib/types.js';

import { buildBillingOverview, toBillingError } from '../_lib/billing.js';
import { sendMethodNotAllowed } from '../_lib/http.js';
import { requireAuthenticatedUser } from '../_lib/appwrite.js';
import { sendSafeError } from '../_lib/errors.js';

export default async function handler(req: ApiRequest, res: ApiResponse) {
  if (req.method !== 'GET') {
    return sendMethodNotAllowed(res, ['GET']);
  }

  try {
    const user = await requireAuthenticatedUser(req, res);
    if (!user) return;

    return res.status(200).json(await buildBillingOverview(user.id));
  } catch (error) {
    // Config manquante → PublicError 503 levée par requireEnv (cf. _lib/config.ts).
    return sendSafeError(res, toBillingError(error), 'Unable to load billing overview', 'billing/overview');
  }
}
