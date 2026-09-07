import type { VercelRequest, VercelResponse } from '@vercel/node';
import { Query } from 'node-appwrite';
import { getAppwriteUsers } from '../_lib/appwrite.js';
import { requestVerificationCode } from '../_lib/verificationStore.js';

export default async function handler(req: VercelRequest, res: VercelResponse) {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method Not Allowed' });
  }

  const { email, name } = req.body || {};
  const trimmedEmail = typeof email === 'string' ? email.trim() : '';

  if (!trimmedEmail || !trimmedEmail.includes('@')) {
    return res.status(400).json({ error: 'Une adresse e-mail valide est requise.' });
  }

  try {
    // 1. Check if user already exists in Appwrite
    const users = getAppwriteUsers();
    const existing = await users.list([Query.equal('email', trimmedEmail)]);
    if (existing.total > 0) {
      return res.status(409).json({
        error: 'Un compte existe déjà avec cette adresse e-mail. Veuillez vous connecter.',
      });
    }

    // 2. Generate and dispatch verification code
    const result = await requestVerificationCode(trimmedEmail, name);

    return res.status(200).json({
      success: true,
      message: 'Un code de vérification à 4 chiffres a été envoyé par e-mail.',
      debugCode: result.debugCode,
    });
  } catch (error: any) {
    console.error('[send-verification-code] Error:', error);
    return res.status(500).json({
      error: error?.message || 'Impossible d’envoyer le code de vérification.',
    });
  }
}
