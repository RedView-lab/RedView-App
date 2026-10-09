import type { ApiRequest, ApiResponse } from '../_lib/types.js';

import { captureServerError } from '../../server/lib/observability.mjs';
import { deleteAccount } from '../_lib/accountDeletion.js';
import { getAppwriteUsers, requireAuthenticatedUser } from '../_lib/appwrite.js';
import { PublicError, sendSafeError } from '../_lib/errors.js';
import { readJsonBody, sendMethodNotAllowed } from '../_lib/http.js';
import { sendAccountDeletedEmail } from '../_lib/mailer.js';
import {
  accountDeletionCodeKey,
  consumeVerificationRequestQuota,
  releaseVerificationRequest,
  requestAccountDeletionCode,
  validateVerificationCode,
} from '../_lib/verificationStore.js';

/**
 * Suppression du compte connecté (RGPD, art. 17) — POST JSON `{ action, … }` :
 *  - `request-code` : envoie un code à 6 chiffres à l'adresse du compte ;
 *  - `confirm` `{ code, confirm: 'delete-my-account' }` : vérifie le code puis
 *    supprime le compte et toutes ses données (api/_lib/accountDeletion.ts),
 *    et envoie un accusé de suppression.
 *
 * Le code prouve l'accès à la boîte du compte : une session volée (onglet
 * resté ouvert, jeton dérobé) ne suffit pas à tout effacer. Il marche aussi
 * pour les comptes Google, qui n'ont pas de mot de passe. Codes et quotas sont
 * ceux de l'inscription (10 min, 5 essais, verrou 24 h après 10 échecs), sous
 * une clé à part. Sous `auth/`, la route a le quota strict de server.mjs.
 */
interface DeleteAccountBody {
  action?: unknown;
  code?: unknown;
  confirm?: unknown;
}

const CONFIRMATION = 'delete-my-account';
const CODE_PATTERN = /^\d{6}$/;
/** Reprises d'une purge interrompue, dans ce processus ; ensuite scripts/appwrite/account-deletions.ts --resume. */
const RETRY_DELAYS_MS = [30_000, 2 * 60_000, 10 * 60_000];

function finishDeletionLater(userId: string, email: string, name: string, attempt = 0): void {
  const delay = RETRY_DELAYS_MS[attempt];
  if (delay === undefined) {
    console.error('[auth/delete-account] suppression toujours incomplète : scripts/appwrite/account-deletions.ts --resume', userId);
    return;
  }
  const timer = setTimeout(() => {
    deleteAccount(userId)
      .then(() => sendAccountDeletedEmail({ to: email, name }))
      .catch((error: unknown) => {
        captureServerError(error, { route: 'auth/delete-account' });
        finishDeletionLater(userId, email, name, attempt + 1);
      });
  }, delay);
  timer.unref?.();
}

export default async function handler(req: ApiRequest, res: ApiResponse) {
  if (req.method !== 'POST') return sendMethodNotAllowed(res, ['POST']);
  try {
    const user = await requireAuthenticatedUser(req, res);
    if (!user) return;
    if (!user.email) throw new PublicError('This account has no email address: contact support to delete it', 400);
    const body = await readJsonBody<DeleteAccountBody>(req);
    const key = accountDeletionCodeKey(user.email);

    switch (body.action) {
      case 'request-code': {
        consumeVerificationRequestQuota(key);
        let sent = false;
        try {
          const profile = await getAppwriteUsers().get(user.id);
          ({ sent } = await requestAccountDeletionCode(user.email, profile.name));
        } finally {
          // Rien n'est parti (Appwrite ou e-mail en échec) : la demande n'est
          // pas décomptée, le nouvel essai n'attend pas 30 s.
          if (!sent) releaseVerificationRequest(key);
        }
        if (!sent) throw new PublicError('The confirmation email could not be sent, try again later', 503);
        return res.status(200).json({ sent: true });
      }
      case 'confirm': {
        if (body.confirm !== CONFIRMATION) throw new PublicError('Missing confirmation', 400);
        const code = typeof body.code === 'string' ? body.code.trim() : '';
        if (!CODE_PATTERN.test(code)) throw new PublicError('The code has 6 digits', 400);
        const validation = validateVerificationCode(key, code);
        if (!validation.valid) throw new PublicError(validation.error || 'Invalid code', validation.status ?? 400);
        const profile = await getAppwriteUsers().get(user.id);
        let summary;
        try {
          summary = await deleteAccount(user.id);
        } catch (error) {
          // Le compte est déjà bloqué : la personne ne peut plus relancer.
          // La purge, idempotente, reprend ici puis par le script d'admin.
          console.error('[auth/delete-account] purge interrompue, reprise programmée', user.id, error);
          captureServerError(error, { route: 'auth/delete-account', requestId: req.requestId });
          finishDeletionLater(user.id, user.email, profile.name);
          return res.status(202).json({ deleted: false, pending: true });
        }
        // Après coup et sans bloquer : le compte est supprimé même si l'accusé ne part pas.
        void sendAccountDeletedEmail({ to: user.email, name: profile.name });
        return res.status(200).json({ deleted: true, summary });
      }
      default:
        throw new PublicError('Unknown action', 400);
    }
  } catch (error) {
    return sendSafeError(res, error, 'Unable to delete the account', 'auth/delete-account');
  }
}
