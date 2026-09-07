import type { VercelRequest, VercelResponse } from '@vercel/node';
import { ID } from 'node-appwrite';
import { getAppwriteUsers } from '../_lib/appwrite.js';
import { validateVerificationCode } from '../_lib/verificationStore.js';

export default async function handler(req: VercelRequest, res: VercelResponse) {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method Not Allowed' });
  }

  const { email, code, name, password } = req.body || {};
  const trimmedEmail = typeof email === 'string' ? email.trim() : '';
  const trimmedCode = typeof code === 'string' ? code.trim() : '';

  if (!trimmedEmail || !trimmedCode) {
    return res.status(400).json({ error: 'E-mail et code de vérification requis.' });
  }

  // 1. Validate code
  const validation = validateVerificationCode(trimmedEmail, trimmedCode);
  if (!validation.valid) {
    return res.status(400).json({ error: validation.error || 'Code invalide.' });
  }

  try {
    const users = getAppwriteUsers();

    // 2. Create the Appwrite user
    const finalName = (typeof name === 'string' && name.trim()) || trimmedEmail.split('@')[0] || 'User';
    const user = await users.create(
      ID.unique(),
      trimmedEmail,
      undefined,
      typeof password === 'string' ? password : undefined,
      finalName,
    );

    // 3. Mark email as verified immediately
    await users.updateEmailVerification(user.$id, true);

    return res.status(200).json({
      success: true,
      userId: user.$id,
      email: user.email,
      name: user.name,
      message: 'Compte créé et e-mail vérifié avec succès.',
    });
  } catch (error: any) {
    console.error('[verify-code] Error creating user:', error);
    return res.status(500).json({
      error: error?.message || 'Erreur lors de la création du compte.',
    });
  }
}
