import type { ApiRequest, ApiResponse } from '../_lib/types.js';
import { ID } from 'node-appwrite';
import { getAppwriteUsers } from '../_lib/appwrite.js';
import {
  normalizeVerificationEmail,
  validateVerificationCode,
} from '../_lib/verificationStore.js';

const MAX_EMAIL_LENGTH = 254;
const MAX_NAME_LENGTH = 100;
const MIN_PASSWORD_LENGTH = 8;
const MAX_PASSWORD_LENGTH = 256;
const CODE_REGEX = /^\d{6}$/;

export default async function handler(req: ApiRequest, res: ApiResponse) {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method Not Allowed' });
  }

  const { email, code, name, password } = req.body || {};
  const normalizedEmail = typeof email === 'string' ? normalizeVerificationEmail(email) : '';
  const trimmedCode = typeof code === 'string' ? code.trim() : '';

  if (!normalizedEmail || !trimmedCode) {
    return res.status(400).json({ error: 'E-mail et code de vérification requis.' });
  }

  if (normalizedEmail.length > MAX_EMAIL_LENGTH || !normalizedEmail.includes('@')) {
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

  // 1. Validate code
  const validation = validateVerificationCode(normalizedEmail, trimmedCode);
  if (!validation.valid) {
    return res
      .status(validation.status ?? 400)
      .json({ error: validation.error || 'Code invalide.' });
  }

  try {
    const users = getAppwriteUsers();

    // 2. Create the Appwrite user
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
      const errInfo = (createErr ?? {}) as { message?: unknown; code?: unknown };
      const alreadyExists =
        (typeof errInfo.message === 'string' && errInfo.message.includes('already exists')) ||
        errInfo.code === 409;
      if (alreadyExists) {
        return res.status(409).json({
          error: 'Un compte existe déjà avec cette adresse e-mail. Veuillez vous connecter.',
        });
      } else {
        throw createErr;
      }
    }

    // 3. Mark email as verified immediately
    await users.updateEmailVerification(user.$id, true);

    return res.status(200).json({
      success: true,
      userId: user.$id,
      email: user.email,
      name: user.name,
      message: 'Compte créé et e-mail vérifié avec succès.',
    });
  } catch (error) {
    console.error('[verify-code] Error creating user:', error);
    return res.status(500).json({
      error: 'Erreur lors de la création du compte. Veuillez réessayer.',
    });
  }
}
