import { Suspense, lazy, useEffect, useRef, useState, type ReactNode } from 'react'
import {
  account,
  clearStoredAppwriteSession,
  getAppwriteUser,
  hasStoredAppwriteSession,
  readStoredAppwriteSession,
  saveStoredAppwriteSession,
} from './shared/services/appwrite'
import { PROJECT_LOCATION_CHANGE_EVENT, readProjectIdFromPath } from './shared/lib/projectLocation'
import { LoginScreen, probeSession, SESSION_EXPIRED_EVENT } from './features/auth'
import { syncAnalyticsAccount } from './features/auth/lib/authAnalytics'
import { getCurrentAnalyticsScreen, trackScreen, type AnalyticsScreen } from './shared/lib/analytics'
import type { SessionProbeResult } from './features/auth'
import { MobileBlockScreen, NarrowViewportOverlay } from './shared/components/MobileBlockScreen'
import { useIsMobileDevice } from './shared/hooks/useIsMobileDevice'
import { useAppI18n } from './shared/i18n'
import { QueryClientProvider } from '@tanstack/react-query'
import { appQueryClient } from './shared/services/queryClient'
import { AppToaster } from './shared/components/AppToaster/AppToaster'
import './index.css'

const Dashboard = lazy(() => import('./pages/Dashboard'))

/** 'unreachable' : Appwrite injoignable (timeout / réseau) sans session locale → écran de reprise. */
type AuthStatus = 'loading' | 'ready' | 'unreachable'

let initialSessionProbePromise: Promise<SessionProbeResult> | null = null

const DEV_FALLBACK_USER_ID = 'dev-user-001'

/** Tracé du logo de l'écran de démarrage (même valeur que dans index.html). */
const RV_BOOT_MARK_PATH = 'M19.4062 0C30.1245 4.68511e-07 38.8135 8.68894 38.8135 19.4072C38.8134 30.1255 30.1245 38.8145 19.4062 38.8145H0V19.4072C4.68499e-07 8.68922 8.68835 0.000449258 19.4062 0ZM18.3975 9.5752C16.4695 6.89461 13.0946 6.02423 10.8594 7.63184C8.62427 9.23948 8.37583 12.7159 10.3037 15.3965C10.6901 15.9337 11.1354 16.3968 11.6172 16.7832C8.02224 19.2662 5.54738 23.1551 5.85449 28.0723C10.6499 41.0727 34.9963 36.8349 32.8154 20.3682C30.9355 16.1664 27.0222 14.0922 22.7451 13.7637C24.6583 14.907 25.9403 16.9979 25.9404 19.3887C25.9403 23.0056 23.0075 25.9373 19.3906 25.9375C15.7739 25.9371 12.8419 23.0055 12.8418 19.3887C12.8418 18.7932 12.9223 18.2164 13.0713 17.668C14.6945 18.3774 16.4797 18.3195 17.8418 17.3398C20.077 15.7322 20.3253 12.2558 18.3975 9.5752Z'

/**
 * Écran de démarrage : même markup que celui peint par index.html avant le
 * JS (styles `.rv-boot` inline dans index.html), pour un passage sans flash
 * jusqu'au gestionnaire de projets.
 */
function BootstrapScreen({ label }: { label: string }) {
  return (
    <div className="rv-boot" role="status" aria-live="polite">
      <svg className="rv-boot__mark" viewBox="0 0 39 39" aria-hidden="true">
        <path fill="currentColor" fillRule="evenodd" clipRule="evenodd" d={RV_BOOT_MARK_PATH} />
      </svg>
      <div className="rv-boot__bar" />
      <span className="rv-boot__label">{label}</span>
    </div>
  )
}

function ServerUnreachableScreen({ onRetry }: { onRetry: () => void }) {
  const { t } = useAppI18n()
  return (
    <div className="loading" role="alert">
      <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 12, textAlign: 'center', padding: 16 }}>
        <p style={{ margin: 0, fontSize: 'var(--rv-font-size-xl)', color: 'inherit' }}>{t('Connexion au serveur impossible')}</p>
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
  const { locale, t } = useAppI18n()
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

  // Titre d'onglet par défaut (index.html / replaceProjectLocation) : suit la langue.
  useEffect(() => {
    if (typeof document === 'undefined') return
    const translated = t(document.title)
    if (translated !== document.title) document.title = translated
  }, [locale, t])

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

  // Aucun état serveur en cache ne passe d'un compte à l'autre (déconnexion,
  // session expirée, autre utilisateur).
  const sessionUserId = session?.user?.id ?? null
  useEffect(() => {
    appQueryClient.clear()
  }, [sessionUserId])

  // Mesure d'audience : contexte du compte (ancienneté par tranche, compte
  // interne exclu) et issue d'un retour OAuth, une fois par session.
  useEffect(() => {
    if (!sessionUserId || sessionUserId === DEV_FALLBACK_USER_ID) return
    let cancelled = false
    void getAppwriteUser().then((user) => {
      if (!cancelled && user && user.$id === sessionUserId) syncAnalyticsAccount(user)
    })
    return () => {
      cancelled = true
    }
  }, [sessionUserId])

  const { isMobile, showNarrowViewportOverlay, dismissNarrowViewportOverlay } = useIsMobileDevice()

  // Écrans sans application montée (la connexion et le Dashboard mesurent les leurs).
  useEffect(() => {
    if (isMobile) trackScreen('blocked_mobile')
    else if (authStatus === 'unreachable') trackScreen('unreachable')
  }, [isMobile, authStatus])
  const screenBeforeNarrowRef = useRef<AnalyticsScreen | null>(null)
  useEffect(() => {
    if (showNarrowViewportOverlay) {
      screenBeforeNarrowRef.current = getCurrentAnalyticsScreen()
      trackScreen('blocked_small_window')
    } else if (screenBeforeNarrowRef.current) {
      trackScreen(screenBeforeNarrowRef.current)
      screenBeforeNarrowRef.current = null
    }
  }, [showNarrowViewportOverlay])

  // Vrai appareil mobile (détecté au chargement) : blocage, l'app n'est pas montée.
  if (isMobile) {
    return <MobileBlockScreen landingUrl={landingUrl} />
  }

  let content: ReactNode
  if (authStatus === 'unreachable') {
    content = (
      <ServerUnreachableScreen
        onRetry={() => {
          setAuthStatus('loading')
          setAuthAttempt((attempt) => attempt + 1)
        }}
      />
    )
  } else if (authStatus === 'loading') {
    content = <BootstrapScreen label={t('Loading...')} />
  } else if (!session) {
    content = (
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
  } else {
    // Open beta : tout compte inscrit a un accès complet. Le statut d'abonnement réel
    // est lu côté serveur (billing, Project Browser) ; rien en aval n'affiche « démo ».
    content = (
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

  // Fenêtre de bureau rétrécie : simple superposition, l'app reste montée dessous
  // (historique d'annulation, imports, LiDAR, contexte WebGL conservés).
  return (
    <QueryClientProvider client={appQueryClient}>
      {content}
      {showNarrowViewportOverlay && <NarrowViewportOverlay onContinue={dismissNarrowViewportOverlay} />}
      <AppToaster />
    </QueryClientProvider>
  )
}

export default App
