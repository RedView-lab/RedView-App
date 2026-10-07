/**
 * Appels à l'API d'authentification (/api/auth/*). Les réponses d'erreur sont
 * renvoyées telles quelles : les messages sont choisis par l'écran.
 */

interface ApiResult {
  ok: boolean
  status: number
  data: { error?: string; message?: string }
}

async function postJson(url: string, body: unknown): Promise<ApiResult> {
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  })
  const data = await res.json().catch(() => ({}))
  return { ok: res.ok, status: res.status, data }
}

/** Lien de réinitialisation (réponse identique que le compte existe ou non). */
export function requestPasswordRecovery(email: string): Promise<ApiResult> {
  return postJson('/api/auth/forgot-password', {
    email,
    redirectUrl: `${window.location.origin}/`,
  })
}

/** Code de vérification à 6 chiffres envoyé par e-mail à l'inscription. */
export function sendVerificationCode(email: string, name: string): Promise<ApiResult> {
  return postJson('/api/auth/send-verification-code', { email, name })
}

/** Vérifie le code et crée le compte (adresse vérifiée). */
export function verifyCodeAndCreateAccount(
  email: string,
  code: string,
  name: string,
  password: string,
): Promise<ApiResult> {
  return postJson('/api/auth/verify-code', { email, code, name, password })
}

/** Nom affiché par défaut : saisi, sinon partie locale de l'e-mail. */
export function resolveSignupName(name: string, email: string): string {
  return name.trim() || email.split('@')[0] || 'User'
}
