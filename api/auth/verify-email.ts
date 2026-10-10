import type { ApiRequest, ApiResponse } from '../_lib/types.js';

import { captureServerError } from '../../server/lib/observability.mjs';
import { getAppwriteUsers, requireAuthenticatedUser } from '../_lib/appwrite.js';
import { PublicError, sendSafeError } from '../_lib/errors.js';
import { readJsonBody, sendMethodNotAllowed } from '../_lib/http.js';
import {
  accountEmailVerificationKey,
  checkVerificationCode,
  consumeVerificationCode,
  consumeVerificationRequestQuota,
  releaseVerificationRequest,
  requestAccountEmailVerificationCode,
} from '../_lib/verificationStore.js';

/**
 * Vérification de l'adresse d'un compte déjà créé — POST JSON `{ action }` :
 *  - `request-code` : envoie un code à 6 chiffres à l'adresse du compte ;
 *  - `confirm` `{ code }` : marque l'adresse vérifiée.
 *
 * Le parcours d'inscription normal (code, puis compte créé par la clé admin)
 * rend l'adresse vérifiée. Mais Appwrite laisse aussi créer un compte
 * directement (`POST /v1/account`, même interrupteur que la connexion par mot
 * de passe), sans posséder la boîte : un tel compte n'entre pas dans l'app
 * tant que son adresse n'est pas prouvée (A15-2). Sous `auth/` : le quota
 * strict de server.mjs ; demandes et échecs comptés par compte.
 */
const CODE_PATTERN = /^\d{6}$/;

export default async function handler(req: ApiRequest, res: ApiResponse) {
  if (req.method !== 'POST') return sendMethodNotAllowed(res, ['POST']);
  try {
    const user = await requireAuthenticatedUser(req, res);
    if (!user) return;
    if (!user.email) throw new PublicError('Ce compte n’a pas d’adresse e-mail.', 400);
    if (user.emailVerified) return res.status(200).json({ verified: true });

    const body = await readJsonBody<{ action?: unknown; code?: unknown }>(req);
    const key = accountEmailVerificationKey(user.id);

    switch (body.action) {
      case 'request-code': {
        consumeVerificationRequestQuota(key);
        const { sent } = await requestAccountEmailVerificationCode(user.id, user.email);
        if (!sent) {
          releaseVerificationRequest(key);
          throw new PublicError('L’e-mail de confirmation n’a pas pu partir. Réessayez plus tard.', 503);
        }
        return res.status(200).json({ sent: true });
      }
      case 'confirm': {
        const code = typeof body.code === 'string' ? body.code.trim() : '';
        if (!CODE_PATTERN.test(code)) throw new PublicError('Le code comporte 6 chiffres.', 400);
        const check = checkVerificationCode(key, code, user.email);
        if (!check.valid) throw new PublicError(check.error || 'Code invalide.', check.status ?? 400);
        try {
          await getAppwriteUsers().updateEmailVerification(user.id, true);
        } catch (error) {
          // Code gardé : un nouvel essai reste possible.
          captureServerError(error, { route: 'auth/verify-email', requestId: req.requestId });
          throw new PublicError('La vérification n’a pas pu être enregistrée. Réessayez.', 503);
        }
        consumeVerificationCode(key);
        return res.status(200).json({ verified: true });
      }
      default:
        throw new PublicError('Unknown action', 400);
    }
  } catch (error) {
    return sendSafeError(res, error, 'Impossible de vérifier l’adresse e-mail.', 'auth/verify-email');
  }
}
