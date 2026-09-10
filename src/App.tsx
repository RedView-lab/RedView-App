import { Suspense, lazy, useEffect, useState } from 'react'
import {
  APPWRITE_DATABASE_ID,
  databases,
  getAppwriteUser,
  hasStoredAppwriteSession,
  Query,
  readStoredAppwriteSession,
  SUBSCRIPTIONS_COLLECTION_ID,
} from './shared/services/appwrite'
import { PROJECT_LOCATION_CHANGE_EVENT, readProjectIdFromPath } from './shared/utils/projectLocation'
import { LoginScreen } from './features/auth'
import { useAppI18n } from './shared/i18n'
import './index.css'

const Dashboard = lazy(() => import('./pages/Dashboard'))

type BootstrapStatus = 'loading' | 'ready'

type SubscriptionAccessState = {
  hasAccess: boolean
  status: string | null
}

const SUBSCRIPTION_CACHE_KEY_PREFIX = 'redview:subscription-status:v2:'
const SUBSCRIPTION_CACHE_TTL_MS = 6 * 60 * 60 * 1000

type CachedSubscriptionSnapshot = {
  hasAccess: boolean
  status: string | null
  cachedAt: number
}

type BootstrapSession = { user: { id: string; email?: string } } | null

let initialSessionBootstrapPromise: Promise<BootstrapSession> | null = null

function getSubscriptionCacheKey(userId: string): string {
  return `${SUBSCRIPTION_CACHE_KEY_PREFIX}${userId}`
}

function BootstrapScreen({ label }: { label: string }) {
  return (
    <div className="loading">
      <p>{label}</p>
    </div>
  )
}

function readCachedSubscription(userId: string | null | undefined): SubscriptionAccessState | null {
  if (!userId) return null

  try {
    const raw = window.localStorage.getItem(getSubscriptionCacheKey(userId))
    if (!raw) return null

    const parsed = JSON.parse(raw) as Partial<CachedSubscriptionSnapshot> & { isSubscribed?: boolean }
    if (typeof parsed.cachedAt !== 'number') {
      window.localStorage.removeItem(getSubscriptionCacheKey(userId))
      return null
    }

    if (Date.now() - parsed.cachedAt > SUBSCRIPTION_CACHE_TTL_MS) {
      window.localStorage.removeItem(getSubscriptionCacheKey(userId))
      return null
    }

    // In Open Beta, all registered users have free access to the web app
    const isSubscribed = parsed.status === 'active' || parsed.status === 'trialing'
    return {
      hasAccess: true,
      status: isSubscribed ? (parsed.status as string) : 'demo',
    }
  } catch {
    return null
  }
}

function writeCachedSubscription(userId: string, subscription: SubscriptionAccessState): void {
  try {
    const payload: CachedSubscriptionSnapshot = {
      hasAccess: subscription.hasAccess,
      status: subscription.status,
      cachedAt: Date.now(),
    }
    window.localStorage.setItem(getSubscriptionCacheKey(userId), JSON.stringify(payload))
  } catch {
    // Ignore storage write failures
  }
}

function resolveInitialAppwriteSession(): Promise<BootstrapSession> {
  if (!initialSessionBootstrapPromise) {
    initialSessionBootstrapPromise = (async () => {
      const stored = readStoredAppwriteSession()
      if (stored?.user?.id) {
        // Trigger background validation
        getAppwriteUser().catch(() => {})
        return stored
      }

      try {
        const user = await getAppwriteUser()
        if (user) {
          return { user: { id: user.$id, email: user.email } }
        }
        return null
      } catch (err) {
        console.warn('[app] resolveInitialAppwriteSession error', err)
        return null
      }
    })()
  }

  return initialSessionBootstrapPromise
}

function App() {
  const { t } = useAppI18n()
  const [session, setSession] = useState<{ user: { id: string; email?: string } } | null>(() => readStoredAppwriteSession())
  const [authStatus, setAuthStatus] = useState<BootstrapStatus>('loading')
  const [subscriptionStatus, setSubscriptionStatus] = useState<BootstrapStatus>(() => {
    const storedSession = readStoredAppwriteSession()
    return readCachedSubscription(storedSession?.user.id) == null ? 'loading' : 'ready'
  })
  const [subscriptionAccess, setSubscriptionAccess] = useState<SubscriptionAccessState>(() => {
    const storedSession = readStoredAppwriteSession()
    return readCachedSubscription(storedSession?.user.id) ?? { hasAccess: true, status: 'demo' }
  })
  const [pathname, setPathname] = useState(() => window.location.pathname)
  const initialProjectId = readProjectIdFromPath(pathname)

  const landingUrl = import.meta.env.VITE_LANDING_URL || 'http://landing.141.145.220.99.sslip.io'
  const offersUrl = `${landingUrl.replace(/\/$/, '')}/#offres`

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
    let cancelled = false

    const resolveSession = async () => {
      try {
        const nextSession = await resolveInitialAppwriteSession()
        if (!cancelled) setSession(nextSession)
      } catch (error) {
        console.error('[app] Failed to resolve auth session during bootstrap', error)
        if (!cancelled && !hasStoredAppwriteSession()) setSession(null)
      } finally {
        if (!cancelled) setAuthStatus('ready')
      }
    }

    void resolveSession()

    return () => {
      cancelled = true
    }
  }, [])

  // Check subscription status after session is available
  useEffect(() => {
    let cancelled = false

    if (authStatus !== 'ready') {
      return
    }

    if (!session?.user?.id) {
      setSubscriptionAccess({ hasAccess: false, status: null })
      setSubscriptionStatus('ready')
      return
    }

    if (session.user.id === 'dev-user-001') {
      setSubscriptionAccess({ hasAccess: true, status: 'pro' })
      setSubscriptionStatus('ready')
      return
    }

    const cachedSubscription = readCachedSubscription(session.user.id)
    if (cachedSubscription != null) {
      setSubscriptionAccess(cachedSubscription)
      setSubscriptionStatus('ready')
    } else {
      setSubscriptionStatus('loading')
    }

    const fetchSubscriptionStatus = async (userId: string): Promise<SubscriptionAccessState> => {
      try {
        const res = await databases.listDocuments(
          APPWRITE_DATABASE_ID,
          SUBSCRIPTIONS_COLLECTION_ID,
          [Query.equal('user_id', userId), Query.limit(1)],
        )

        const first = res.documents[0]
        if (first) {
          const status = (first.status as string) ?? null
          const isSubscribed = status === 'active' || status === 'trialing'
          return {
            hasAccess: true,
            status: isSubscribed ? status : 'demo',
          }
        }

        // Default to free demo access for all users in Open Beta
        return { hasAccess: true, status: 'demo' }
      } catch (err) {
        console.warn('[app] Appwrite subscription check error', err)
        return { hasAccess: true, status: 'demo' }
      }
    }

    const resolveSubscription = async () => {
      try {
        const nextSubscription = await fetchSubscriptionStatus(session.user.id)
        if (cancelled) return

        setSubscriptionAccess(nextSubscription)
        writeCachedSubscription(session.user.id, nextSubscription)
      } catch (error) {
        if (cancelled) return
        console.warn('[app] Subscription bootstrap error', error)
      } finally {
        if (!cancelled) setSubscriptionStatus('ready')
      }
    }

    void resolveSubscription()

    return () => {
      cancelled = true
    }
  }, [authStatus, session?.user?.id])

  if (authStatus === 'loading' || (session && subscriptionStatus === 'loading')) {
    return <BootstrapScreen label={t('Loading...')} />
  }

  if (!session) {
    return (
      <LoginScreen
        landingUrl={landingUrl}
        onLogin={(email) => {
          const stored = readStoredAppwriteSession()
          const nextSession = stored ?? {
            user: { id: 'dev-user-001', email: email || 'user@redview.app' },
          }
          setSession(nextSession)
          setSubscriptionAccess({ hasAccess: true, status: 'pro' })
          setSubscriptionStatus('ready')
        }}
      />
    )
  }

  // In Open Beta, all registered accounts access RedView App
  return (
    <Suspense fallback={<BootstrapScreen label={t('Loading dashboard...')} />}>
      <Dashboard
        email={session.user.email || 'unknown'}
        initialProjectId={initialProjectId}
        isDemoAccount={subscriptionAccess.status !== 'active' && subscriptionAccess.status !== 'trialing'}
        offersUrl={offersUrl}
      />
    </Suspense>
  )
}

export default App
