import { useEffect } from 'react'
import { account, clearStoredAppwriteSession } from '@/shared/services/appwrite'

interface UseAuthUrlParamsOptions {
  /** Lien de réinitialisation ouvert : jetons gardés en mémoire seulement. */
  onRecoveryLink: (link: { userId: string; secret: string; email: string | null }) => void
  /** Erreur renvoyée dans l'URL (retour OAuth) : toujours un message de l'app, jamais le texte de l'URL. */
  onUrlError: (message: string) => void
}

/** Paramètre posé par l'app sur l'URL d'échec de l'OAuth (`createOAuth2Session`). */
export const OAUTH_FAILURE_PARAM = 'oauth'
const OAUTH_FAILURE_MESSAGE = 'La connexion avec Google a échoué. Réessayez.'

/**
 * Message à afficher pour une URL d'arrivée, ou null. Seuls les retours connus
 * produisent un message, et c'est toujours un texte de l'app : un `?message=`
 * ou `?error=` arbitraire s'affichait tel quel dans l'encadré d'erreur de
 * l'écran de connexion officiel (lien d'hameçonnage, A8-2), et un échec OAuth
 * y montrait le JSON brut d'Appwrite (`?error={"message":…}`). Aucun décodage
 * de plus : `URLSearchParams` a déjà décodé, et un second `decodeURIComponent`
 * levait `URIError` sur un « % » et faisait planter toute l'app (A8-1).
 */
export function authUrlErrorMessage(params: URLSearchParams): string | null {
  if (params.get(OAUTH_FAILURE_PARAM) === 'failed' || params.has('error')) return OAUTH_FAILURE_MESSAGE
  return null
}

/**
 * Lit une seule fois l'URL d'arrivée : jeton de réinitialisation ou erreur
 * OAuth, puis les retire aussitôt de la barre d'adresse et de l'historique.
 */
export function useAuthUrlParams({ onRecoveryLink, onUrlError }: UseAuthUrlParamsOptions): void {
  useEffect(() => {
    if (typeof window === 'undefined') return
    const params = new URLSearchParams(window.location.search)
    if (params.has('userId') && params.has('secret')) {
      const uid = params.get('userId')
      const sec = params.get('secret')
      if (uid && sec) {
        // SÉCURITÉ : retire immédiatement les jetons de récupération sensibles de la barre
        // d'adresse et de l'historique, contre les fuites par referrer, historique ou regard indiscret
        window.history.replaceState({}, document.title, window.location.pathname)
        onRecoveryLink({ userId: uid, secret: sec, email: params.get('email') })

        // SÉCURITÉ : purge les traces de session locale préexistantes (anti-fixation de session)
        clearStoredAppwriteSession()
        try {
          account.deleteSession('current').catch(() => {})
        } catch {}
      }
      return
    }
    if (params.has('error') || params.has('message') || params.has(OAUTH_FAILURE_PARAM)) {
      // URL nettoyée d'abord : un rechargement ne retombe jamais sur le même paramètre.
      window.history.replaceState({}, document.title, window.location.pathname)
      const message = authUrlErrorMessage(params)
      if (message) onUrlError(message)
    }
    // Lecture unique de l'URL d'arrivée.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])
}
