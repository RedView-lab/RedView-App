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

          // SÉCURITÉ : purge les traces de session locale préexistantes (anti-fixation de session)
          clearStoredAppwriteSession()
          try {
            account.deleteSession('current').catch(() => {})
          } catch {}

          // SÉCURITÉ : retire immédiatement les jetons de récupération sensibles de la barre
          // d'adresse et de l'historique, contre les fuites par referrer, historique ou regard indiscret
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
