import type { ApiRequest, ApiResponse } from '../_lib/types.js';
import { parseEmailAddress } from '../_lib/email.js';
import { bodyFields } from '../_lib/http.js';
import { Query } from 'node-appwrite';
import { getAppwriteUsers } from '../_lib/appwrite.js';
import { PublicError, sendSafeError } from '../_lib/errors.js';
import { sendAccountExistsEmail } from '../_lib/mailer.js';
import {
  consumeVerificationRequestQuota,
  releaseVerificationRequest,
  requestVerificationCode,
} from '../_lib/verificationStore.js';

/** E-mail non parti (Resend en panne, clé absente) : même réponse dans les deux chemins. */
const NOT_SENT_MESSAGE = 'L’e-mail n’a pas pu être envoyé. Réessayez dans quelques minutes.';

// Réponse identique que l'adresse soit libre ou déjà prise (anti-énumération).
const NEUTRAL_SUCCESS_MESSAGE =
  'Si l’adresse est valide, un code de vérification à 6 chiffres a été envoyé.';

export default async function handler(req: ApiRequest, res: ApiResponse) {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method Not Allowed' });
  }

  // Le nom saisi n'est plus repris dans l'e-mail (api/_lib/mailer.ts) : il
  // ne sert qu'à la création du compte (verify-code).
  const { email } = bodyFields(req);
  const normalizedEmail = parseEmailAddress(email);
  if (!normalizedEmail) {
    return res.status(400).json({ error: 'Une adresse e-mail valide est requise.' });
  }

  try {
    // 0. Quotas par e-mail (verrou, cooldown, 5 demandes / heure) — appliqués
    //    aux deux chemins pour qu'ils restent indiscernables.
    consumeVerificationRequestQuota(normalizedEmail);

    let sent = false;
    try {
      // 1. Vérifie si l'utilisateur existe déjà dans Appwrite
      const users = getAppwriteUsers();
      const existing = await users.list([Query.equal('email', normalizedEmail)]);
      // Pas de 409 pour un compte existant : on prévient le propriétaire de la
      // boîte par e-mail ; sinon, 2. code de vérification envoyé.
      ({ sent } = existing.total > 0
        ? await sendAccountExistsEmail({ to: normalizedEmail })
        : await requestVerificationCode(normalizedEmail));
    } finally {
      // Rien n'est parti : la demande ne compte pas (nouvel essai immédiat).
      if (!sent) releaseVerificationRequest(normalizedEmail);
    }
    // Répondre « envoyé » ici laissait attendre un code qui n'arrivait jamais.
    // 503 dans les deux chemins : ne révèle pas l'existence du compte.
    if (!sent) throw new PublicError(NOT_SENT_MESSAGE, 503);

    return res.status(200).json({
      success: true,
      message: NEUTRAL_SUCCESS_MESSAGE,
    });
  } catch (error) {
    return sendSafeError(
      res,
      error,
      'Impossible d’envoyer le code de vérification.',
      'send-verification-code',
    );
  }
}
