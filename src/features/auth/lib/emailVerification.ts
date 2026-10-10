/**
 * Vérification de l'adresse d'un compte existant (api/auth/verify-email.ts) :
 * un compte dont l'adresse n'est pas prouvée (créé directement par l'API
 * d'Appwrite) reçoit un code à son adresse avant d'entrer dans l'app (A15-2).
 */
import { translateAppText } from '@/shared/i18n';
import { apiFetch } from '@/shared/lib/apiFetch';
import { forgetRecentAppwriteUser, getAppwriteJwt } from '@/shared/services/appwrite';

/** Appwrite + envoi d'un e-mail (Resend) côté serveur. */
const VERIFY_EMAIL_TIMEOUT_MS = 30_000;

async function verifyEmailRequest(body: Record<string, unknown>): Promise<Record<string, unknown>> {
  const send = async (fresh: boolean) => {
    const token = await getAppwriteJwt({ fresh });
    if (!token) throw new Error(translateAppText('Session expirée. Reconnectez-vous puis réessayez.'));
    return apiFetch('/api/auth/verify-email', {
      timeoutMs: VERIFY_EMAIL_TIMEOUT_MS,
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
      body: JSON.stringify(body),
    });
  };
  let response = await send(false);
  // JWT réutilisé mais refusé (session renouvelée entre-temps) : un nouveau, une fois.
  if (response.status === 401) response = await send(true);
  const data = (await response.json().catch(() => ({}))) as Record<string, unknown>;
  if (!response.ok) {
    throw new Error(translateAppText(typeof data.error === 'string' ? data.error : 'Impossible de vérifier l’adresse e-mail.'));
  }
  return data;
}

/** Envoie un code à l'adresse du compte ; vrai si l'adresse était déjà vérifiée. */
export async function requestAccountEmailCode(): Promise<{ alreadyVerified: boolean }> {
  const data = await verifyEmailRequest({ action: 'request-code' });
  return { alreadyVerified: data.verified === true };
}

export async function confirmAccountEmail(code: string): Promise<void> {
  await verifyEmailRequest({ action: 'confirm', code: code.trim() });
  // Le compte relu ensuite doit porter `emailVerification: true`.
  forgetRecentAppwriteUser();
}
