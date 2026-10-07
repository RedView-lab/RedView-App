import { useEffect } from 'react'
import { account, clearStoredAppwriteSession } from '@/shared/services/appwrite'

interface UseAuthUrlParamsOptions {
  /** Lien de réinitialisation ouvert : jetons gardés en mémoire seulement. */
  onRecoveryLink: (link: { userId: string; secret: string; email: string | null }) => void
  /** Erreur renvoyée dans l'URL (retour OAuth). */
  onUrlError: (message: string) => void
}

/**
 * Lit une seule fois l'URL d'arrivée : jeton de réinitialisation ou erreur
 * OAuth, puis les retire aussitôt de la barre d'adresse et de l'historique.
 */
export function useAuthUrlParams({ onRecoveryLink, onUrlError }: UseAuthUrlParamsOptions): void {
  useEffect(() => {
    if (typeof window !== 'undefined') {
      const params = new URLSearchParams(window.location.search)
      if (params.has('userId') && params.has('secret')) {
        const uid = params.get('userId')
        const sec = params.get('secret')
        if (uid && sec) {
          onRecoveryLink({ userId: uid, secret: sec, email: params.get('email') })

          // SECURITY: Purge pre-existing local session artifacts (Anti-Session Fixation)
          clearStoredAppwriteSession()
          try {
            account.deleteSession('current').catch(() => {})
          } catch {}

          // SECURITY: Immediately strip sensitive recovery tokens from browser address bar
          // and history to prevent token leakage via referrers, history or shoulder surfing
          window.history.replaceState({}, document.title, window.location.pathname)
        }
      } else if (params.has('error') || params.has('message')) {
        const urlError = params.get('error') || params.get('message')
        if (urlError) {
          onUrlError(decodeURIComponent(urlError))
          window.history.replaceState({}, document.title, window.location.pathname)
        }
      }
    }
    // Lecture unique de l'URL d'arrivée.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])
}
