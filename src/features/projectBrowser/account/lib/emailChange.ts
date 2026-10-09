/**
 * Changement de l'adresse e-mail du compte (api/auth/change-email.ts) : un
 * code envoyé à la nouvelle adresse, puis la confirmation avec ce code et le
 * mot de passe actuel. Une fois fait, la session gardée sur l'appareil
 * reprend la nouvelle adresse.
 */
import { translateAppText } from '@/shared/i18n';
import { apiFetch } from '@/shared/lib/apiFetch';
import { getAppwriteJwt, readStoredAppwriteSession, saveStoredAppwriteSession } from '@/shared/services/appwrite';

/** Appwrite + envoi d'un e-mail (Resend) côté serveur. */
const CHANGE_EMAIL_TIMEOUT_MS = 30_000;

async function changeEmailRequest<T>(body: Record<string, unknown>): Promise<T> {
  const send = async (fresh: boolean) => {
    const token = await getAppwriteJwt({ fresh });
    if (!token) throw new Error(translateAppText('Session expirée. Reconnectez-vous puis réessayez.'));
    return apiFetch('/api/auth/change-email', {
      timeoutMs: CHANGE_EMAIL_TIMEOUT_MS,
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
      body: JSON.stringify(body),
    });
  };
  let response = await send(false);
  // JWT réutilisé mais refusé (session renouvelée entre-temps) : un nouveau, une fois.
  // Un mauvais mot de passe répond 400, jamais 401.
  if (response.status === 401) response = await send(true);
  const data = (await response.json().catch(() => ({}))) as Record<string, unknown>;
  if (!response.ok) {
    throw new Error(translateAppText(typeof data.error === 'string' ? data.error : 'Impossible de changer l’adresse e-mail.'));
  }
  return data as T;
}

export async function requestEmailChangeCode(newEmail: string): Promise<void> {
  await changeEmailRequest({ action: 'request-code', newEmail: newEmail.trim() });
}

/** Rend la nouvelle adresse (normalisée par le serveur). */
export async function confirmEmailChange(newEmail: string, code: string, password: string): Promise<string> {
  const { email } = await changeEmailRequest<{ email: string }>({
    action: 'confirm',
    newEmail: newEmail.trim(),
    code: code.trim(),
    password,
  });
  const stored = readStoredAppwriteSession();
  if (stored?.user.id) saveStoredAppwriteSession({ ...stored.user, email });
  return email;
}
