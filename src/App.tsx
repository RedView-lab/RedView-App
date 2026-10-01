import { Suspense, lazy, useEffect, useRef, useState } from 'react'
import {
  account,
  clearStoredAppwriteSession,
  getAppwriteUser,
  hasStoredAppwriteSession,
  readStoredAppwriteSession,
  saveStoredAppwriteSession,
} from './shared/services/appwrite'
import { PROJECT_LOCATION_CHANGE_EVENT, readProjectIdFromPath } from './shared/utils/projectLocation'
import { LoginScreen, probeSession, SESSION_EXPIRED_EVENT } from './features/auth'
import type { SessionProbeResult } from './features/auth'
import { MobileBlockScreen } from './shared/components/MobileBlockScreen'
import { useIsMobileDevice } from './shared/hooks/useIsMobileDevice'
import { useAppI18n } from './shared/i18n'
import './index.css'

const Dashboard = lazy(() => import('./pages/Dashboard'))

/** 'unreachable' : Appwrite injoignable (timeout / réseau) sans session locale → écran de reprise. */
type AuthStatus = 'loading' | 'ready' | 'unreachable'

let initialSessionProbePromise: Promise<SessionProbeResult> | null = null

const ANALYTICS_RECORDER_SRC = 'https://analytics.redview.tech/recorder.js'
const ANALYTICS_WEBSITE_ID = '794b9933-1d87-4e8c-af69-a09982cc2353'
const DEV_FALLBACK_USER_ID = 'dev-user-001'

/**
 * Session replay is only loaded for a confirmed, authenticated Appwrite user —
 * never on the login / password-reset screens, so credentials typed there are
 * never recorded. Injected at most once per page.
 */
function injectAnalyticsRecorder(): void {
  if (typeof document === 'undefined') return
  if (document.querySelector(`script[src="${ANALYTICS_RECORDER_SRC}"]`)) return

  const script = document.createElement('script')
  script.defer = true
  script.src = ANALYTICS_RECORDER_SRC
  script.dataset.websiteId = ANALYTICS_WEBSITE_ID
  document.body.appendChild(script)
}

function BootstrapScreen({ label }: { label: string }) {
  return (
    <div className="loading">
      <p>{label}</p>
    </div>
  )
}

function ServerUnreachableScreen({ onRetry }: { onRetry: () => void }) {
  const { t } = useAppI18n()
  return (
    <div className="loading" role="alert">
      <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 12, textAlign: 'center', padding: 16 }}>
        <p style={{ margin: 0, fontSize: 16, color: 'inherit' }}>{t('Connexion au serveur impossible')}</p>
        <p style={{ margin: 0 }}>{t('Vérifiez votre connexion internet puis réessayez.')}</p>
        <button
          type="button"
          onClick={onRetry}
          style={{
            padding: '8px 20px',
            borderRadius: 8,
            border: '1px solid currentColor',
            background: 'transparent',
            color: 'inherit',
            font: 'inherit',
            cursor: 'pointer',
          }}
        >
          {t('Réessayer')}
        </button>
      </div>
    </div>
  )
}

function isPasswordResetLocation(): boolean {
  if (typeof window === 'undefined') return false
  const params = new URLSearchParams(window.location.search)
  return params.has('userId') && params.has('secret')
}

/**
 * Vérifie la session auprès d'Appwrite (borné par SESSION_PROBE_TIMEOUT_MS) et
 * synchronise le snapshot local : sauvegardé si valide, effacé seulement sur 401.
 */
async function probeAppwriteSession(): Promise<SessionProbeResult> {
  const result = await probeSession(() => account.get())
  if (result.kind === 'authenticated') {
    saveStoredAppwriteSession(result.user)
  } else if (result.kind === 'unauthenticated') {
    clearStoredAppwriteSession()
  }
  return result
}

/** Dédoublonne la vérification initiale (double montage StrictMode) ; `refresh` relance. */
function resolveInitialAppwriteSession(refresh = false): Promise<SessionProbeResult> {
  if (refresh || !initialSessionProbePromise) {
    initialSessionProbePromise = probeAppwriteSession()
  }
  return initialSessionProbePromise
}

function App() {
  const { t } = useAppI18n()
  const isPasswordResetUrl = isPasswordResetLocation()

  const [session, setSession] = useState<{ user: { id: string; email?: string } } | null>(() => {
    if (isPasswordResetUrl) return null
    return readStoredAppwriteSession()
  })
  // Avec un snapshot local, on rend tout de suite (validation en arrière-plan) ;
  // sans snapshot, on attend Appwrite au plus SESSION_PROBE_TIMEOUT_MS.
  const [authStatus, setAuthStatus] = useState<AuthStatus>(() => {
    if (isPasswordResetUrl) return 'ready'
    return hasStoredAppwriteSession() ? 'ready' : 'loading'
  })
  const [authAttempt, setAuthAttempt] = useState(0)
  const [pathname, setPathname] = useState(() => window.location.pathname)
  const initialProjectId = readProjectIdFromPath(pathname)

  const landingUrl = import.meta.env.VITE_LANDING_URL || 'https://redview.tech'
  const offersUrl = `${landingUrl.replace(/\/$/, '')}/pricing`

  useEffect(() => {
    const syncPathname = () => {
      const nextPath = window.location.pathname
      setPathname((prev) => (prev === nextPath ? prev : nextPath))
    }

    window.addEventListener('popstate', syncPathname)
    window.addEventListener(PROJECT_LOCATION_CHANGE_EVENT, syncPathname)

    return () => {
      window.removeEventListener('popstate', syncPathname)
      window.removeEventListener(PROJECT_LOCATION_CHANGE_EVENT, syncPathname)
    }
  }, [])

  useEffect(() => {
    // Lien de réinitialisation de mot de passe : écran de connexion, pas de vérification.
    if (isPasswordResetLocation()) return

    let cancelled = false
    const hadStoredSession = hasStoredAppwriteSession()

    void resolveInitialAppwriteSession(authAttempt > 0).then((result) => {
      if (cancelled) return

      if (result.kind === 'authenticated') {
        setSession({ user: result.user })
        setAuthStatus('ready')
        return
      }

      if (result.kind === 'unauthenticated') {
        // 401 confirmé : pas (ou plus) de session → écran de connexion.
        setSession(null)
        setAuthStatus('ready')
        return
      }

      console.warn('[app] Appwrite unreachable during session bootstrap', result.reason, result.error)
      // Session locale connue : on garde l'utilisateur dans l'app (usage hors ligne).
      // Sinon : écran « Réessayer » plutôt qu'un chargement infini ou un renvoi au login.
      setAuthStatus(hadStoredSession ? 'ready' : 'unreachable')
    })

    return () => {
      cancelled = true
    }
  }, [authAttempt])

  // Session expirée en cours d'usage (401 confirmé signalé par la couche Appwrite) :
  // on quitte le Dashboard pour l'écran de connexion plutôt que de laisser une
  // interface dont toutes les requêtes échouent. Ignoré pour la session démo de dev.
  const sessionUserIdRef = useRef<string | null>(session?.user?.id ?? null)
  useEffect(() => {
    sessionUserIdRef.current = session?.user?.id ?? null
  }, [session?.user?.id])

  useEffect(() => {
    const handleSessionExpired = () => {
      const userId = sessionUserIdRef.current
      if (!userId || userId === DEV_FALLBACK_USER_ID) return
      console.warn('[app] Appwrite session expired, returning to login')
      clearStoredAppwriteSession()
      setSession(null)
      setAuthStatus('ready')
    }

    window.addEventListener(SESSION_EXPIRED_EVENT, handleSessionExpired)
    return () => {
      window.removeEventListener(SESSION_EXPIRED_EVENT, handleSessionExpired)
    }
  }, [])

  // Session replay: only once Appwrite confirms a real authenticated user
  // (not the dev/demo fallback session, not the login/reset screens).
  useEffect(() => {
    const userId = session?.user?.id
    if (authStatus !== 'ready' || isPasswordResetUrl || !userId || userId === DEV_FALLBACK_USER_ID) {
      return
    }

    let cancelled = false
    getAppwriteUser()
      .then((user) => {
        if (!cancelled && user?.$id === userId) injectAnalyticsRecorder()
      })
      .catch(() => {})

    return () => {
      cancelled = true
    }
  }, [authStatus, isPasswordResetUrl, session?.user?.id])

  const { isMobile } = useIsMobileDevice()

  if (isMobile) {
    return <MobileBlockScreen landingUrl={landingUrl} />
  }

  if (authStatus === 'unreachable') {
    return (
      <ServerUnreachableScreen
        onRetry={() => {
          setAuthStatus('loading')
          setAuthAttempt((attempt) => attempt + 1)
        }}
      />
    )
  }

  if (authStatus === 'loading') {
    return <BootstrapScreen label={t('Loading...')} />
  }

  if (!session) {
    return (
      <LoginScreen
        landingUrl={landingUrl}
        onLogin={(email) => {
          const stored = readStoredAppwriteSession()
          if (stored) {
            setSession(stored)
            return
          }

          // Compte démo local (sans Appwrite) : uniquement en développement.
          if (import.meta.env.DEV) {
            setSession({ user: { id: DEV_FALLBACK_USER_ID, email: email || 'user@redview.tech' } })
            return
          }

          // Session Appwrite créée mais snapshot local illisible (stockage bloqué) :
          // on relit l'utilisateur côté serveur plutôt que d'inventer une identité.
          void getAppwriteUser().then((user) => {
            if (!user) return
            setSession({ user: { id: user.$id, email: user.email } })
          })
        }}
      />
    )
  }

  // Open beta : tout compte inscrit a un accès complet. Le statut d'abonnement réel
  // est lu côté serveur (billing, Project Browser) ; rien en aval n'affiche « démo ».
  return (
    <Suspense fallback={<BootstrapScreen label={t('Loading dashboard...')} />}>
      <Dashboard
        email={session.user.email || 'unknown'}
        initialProjectId={initialProjectId}
        isDemoAccount={false}
        offersUrl={offersUrl}
      />
    </Suspense>
  )
}

export default App
