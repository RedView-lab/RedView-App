import type { ApiRequest, ApiResponse } from '../_lib/types.js';
import { bodyFields } from '../_lib/http.js';
import { ID } from 'node-appwrite';
import { getClientIp, rateLimitKeyForIp } from '../../server/lib/http-security.mjs';
import { getAppwriteUsers } from '../_lib/appwrite.js';
import { parseEmailAddress } from '../_lib/email.js';
import { sendSafeError } from '../_lib/errors.js';
import {
  checkVerificationCode,
  consumeVerificationCode,
} from '../_lib/verificationStore.js';

const MAX_NAME_LENGTH = 100;
const MIN_PASSWORD_LENGTH = 8;
const MAX_PASSWORD_LENGTH = 256;
const CODE_REGEX = /^\d{6}$/;

export default async function handler(req: ApiRequest, res: ApiResponse) {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method Not Allowed' });
  }

  const { email, code, name, password } = bodyFields(req);
  const trimmedCode = typeof code === 'string' ? code.trim() : '';
  if (typeof email !== 'string' || !email.trim() || !trimmedCode) {
    return res.status(400).json({ error: 'E-mail et code de vérification requis.' });
  }

  const normalizedEmail = parseEmailAddress(email);
  if (!normalizedEmail) {
    return res.status(400).json({ error: 'Une adresse e-mail valide est requise.' });
  }

  if (!CODE_REGEX.test(trimmedCode)) {
    return res.status(400).json({ error: 'Le code de vérification doit comporter 6 chiffres.' });
  }

  if (
    typeof password !== 'string' ||
    password.length < MIN_PASSWORD_LENGTH ||
    password.length > MAX_PASSWORD_LENGTH
  ) {
    return res.status(400).json({
      error: 'Le mot de passe doit comporter entre 8 et 256 caractères.',
    });
  }

  if (name !== undefined && name !== null && (typeof name !== 'string' || name.length > MAX_NAME_LENGTH)) {
    return res.status(400).json({ error: 'Le nom ne doit pas dépasser 100 caractères.' });
  }

  // 1. Valide le code (consommé seulement une fois le compte créé : un échec
  //    d'Appwrite plus bas le laisse utilisable pour un nouvel essai)
  // Échecs comptés aussi par IP : un tiers ne verrouille que son propre couple
  // adresse + IP, pas l'inscription du vrai titulaire (A1-4).
  const validation = checkVerificationCode(normalizedEmail, trimmedCode, undefined, rateLimitKeyForIp(getClientIp(req)));
  if (!validation.valid) {
    return res
      .status(validation.status ?? 400)
      .json({ error: validation.error || 'Code invalide.' });
  }

  try {
    const users = getAppwriteUsers();

    // 2. Crée l'utilisateur Appwrite
    const finalName =
      (typeof name === 'string' && name.trim()) || normalizedEmail.split('@')[0] || 'User';
    let user;
    try {
      user = await users.create(
        ID.unique(),
        normalizedEmail,
        undefined,
        password,
        finalName,
      );
    } catch (createErr) {
      // Atteignable uniquement avec un code valide → pas d'énumération possible.
      const errInfo = (createErr ?? {}) as { message?: unknown; code?: unknown; type?: unknown };
      const message = typeof errInfo.message === 'string' ? errInfo.message : '';
      const alreadyExists = message.includes('already exists') || errInfo.code === 409;
      if (alreadyExists) {
        consumeVerificationCode(normalizedEmail);
        return res.status(409).json({
          error: 'Un compte existe déjà avec cette adresse e-mail. Veuillez vous connecter.',
        });
      }
      // Politique de mot de passe d'Appwrite (dictionnaire des mots de passe
      // courants, données personnelles) : refus à expliquer, pas une panne.
      const passwordRefused =
        errInfo.code === 400 &&
        ((typeof errInfo.type === 'string' && errInfo.type.startsWith('password_')) || /password/i.test(message));
      if (passwordRefused) {
        return res.status(400).json({
          error: 'Ce mot de passe est refusé (trop courant ou proche de vos informations personnelles). Choisissez-en un autre.',
        });
      }
      throw createErr;
    }

    consumeVerificationCode(normalizedEmail);

    // 3. Marque l'e-mail comme vérifié : le code l'a prouvé. Le compte
    //    fonctionne sans le drapeau, donc un échec ici ne doit pas signaler
    //    l'inscription comme ratée (un nouvel essai n'obtiendrait que « le
    //    compte existe déjà »).
    try {
      await users.updateEmailVerification(user.$id, true);
    } catch (verifyErr) {
      console.error('[verify-code] Account created but email verification flag not set:', verifyErr);
    }

    return res.status(200).json({
      success: true,
      userId: user.$id,
      email: user.email,
      name: user.name,
      message: 'Compte créé et e-mail vérifié avec succès.',
    });
  } catch (error) {
    return sendSafeError(res, error, 'Erreur lors de la création du compte. Veuillez réessayer.', 'verify-code');
  }
}
