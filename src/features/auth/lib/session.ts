/**
 * Vérification de session au démarrage.
 *
 * `probeSession` distingue trois issues pour `account.get()` :
 *   - `authenticated`   : session Appwrite valide ;
 *   - `unauthenticated` : 401 confirmé (pas de session / session expirée) → écran de connexion ;
 *   - `unreachable`     : timeout, erreur réseau ou 5xx → écran « Réessayer », jamais la connexion.
 */

/** Délai max d'attente d'Appwrite au démarrage avant d'afficher l'écran de reprise. */
export const SESSION_PROBE_TIMEOUT_MS = 8000

/**
 * Contrat d'expiration de session en cours d'usage : quand une requête Appwrite reçoit
 * un 401 confirmé (pas une erreur réseau), émettre sur `window` :
 *
 *   window.dispatchEvent(new CustomEvent('redview:session-expired', { detail: { reason: 'unauthorized' } }))
 *
 * (ou `dispatchSessionExpired()`). App.tsx l'écoute : snapshot local effacé, Dashboard
 * démonté, écran de connexion affiché.
 */
export const SESSION_EXPIRED_EVENT = 'redview:session-expired'

export type SessionExpiredEventDetail = {
  reason?: 'unauthorized'
}

export function dispatchSessionExpired(detail: SessionExpiredEventDetail = { reason: 'unauthorized' }): void {
  if (typeof window === 'undefined') return
  window.dispatchEvent(new CustomEvent<SessionExpiredEventDetail>(SESSION_EXPIRED_EVENT, { detail }))
}

export type SessionUser = { id: string; email?: string }

export type SessionProbeResult =
  | { kind: 'authenticated'; user: SessionUser }
  | { kind: 'unauthenticated' }
  | { kind: 'unreachable'; reason: 'timeout' | 'network'; error?: unknown }

type ProbeUser = { $id: string; email?: string }

export function isUnauthorizedError(error: unknown): boolean {
  return typeof error === 'object' && error !== null && (error as { code?: unknown }).code === 401
}

export async function probeSession(
  fetchUser: () => Promise<ProbeUser>,
  timeoutMs: number = SESSION_PROBE_TIMEOUT_MS,
): Promise<SessionProbeResult> {
  let timer: ReturnType<typeof setTimeout> | undefined
  const timeout = new Promise<'timeout'>((resolve) => {
    timer = setTimeout(() => resolve('timeout'), timeoutMs)
  })

  try {
    const outcome = await Promise.race([fetchUser(), timeout])
    if (outcome === 'timeout') {
      return { kind: 'unreachable', reason: 'timeout' }
    }
    return { kind: 'authenticated', user: { id: outcome.$id, email: outcome.email } }
  } catch (error) {
    if (isUnauthorizedError(error)) {
      return { kind: 'unauthenticated' }
    }
    return { kind: 'unreachable', reason: 'network', error }
  } finally {
    clearTimeout(timer)
  }
}
