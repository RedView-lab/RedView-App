import type { ApiRequest, ApiResponse } from '../_lib/types.js';
import { parseEmailAddress } from '../_lib/email.js';
import { bodyFields } from '../_lib/http.js';
import { Query } from 'node-appwrite';
import { getAppwriteUsers } from '../_lib/appwrite.js';
import { sendSafeError } from '../_lib/errors.js';
import { sendAccountExistsEmail } from '../_lib/mailer.js';
import {
  consumeVerificationRequestQuota,
  requestVerificationCode,
} from '../_lib/verificationStore.js';

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

    // 1. Vérifie si l'utilisateur existe déjà dans Appwrite
    const users = getAppwriteUsers();
    const existing = await users.list([Query.equal('email', normalizedEmail)]);

    if (existing.total > 0) {
      // Pas de 409 : on prévient le propriétaire de la boîte par e-mail.
      await sendAccountExistsEmail({ to: normalizedEmail });
    } else {
      // 2. Génère et envoie le code de vérification
      await requestVerificationCode(normalizedEmail);
    }

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
