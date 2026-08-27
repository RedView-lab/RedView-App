import { Suspense, lazy, useEffect, useState } from 'react'
import { getSupabaseSession, hasStoredSupabaseSession, readStoredSupabaseSession, supabase } from './shared/services/supabase'
import { PROJECT_LOCATION_CHANGE_EVENT, readProjectIdFromPath } from './shared/utils/projectLocation'
import PayWall from './shared/components/PayWall'
import DevAuthScreen from './shared/components/DevAuthScreen'
import { useAppI18n } from './shared/i18n'
import './index.css'

const Dashboard = lazy(() => import('./pages/Dashboard'))

type BootstrapStatus = 'loading' | 'ready'

type SubscriptionAccessState = {
  hasAccess: boolean
  status: string | null
}

const AUTH_BOOT_TIMEOUT_MS = 8000
// Cold-start of supabase-js + a possible token refresh + the first PostgREST round trip
// can comfortably exceed 4s on a fresh tab. Give it a generous budget; the cached
// subscription state means the user never sees this latency anyway.
const SUBSCRIPTION_BOOT_TIMEOUT_MS = 12000
const SUBSCRIPTION_RETRY_TIMEOUT_MS = 15000
const SUBSCRIPTION_CACHE_KEY_PREFIX = 'redview:subscription-status:v2:'
const SUBSCRIPTION_CACHE_TTL_MS = 6 * 60 * 60 * 1000

function hasAppAccess(subscription: { is_subscribed?: boolean | null; status?: string | null } | null): boolean {
  if (!subscription) return true
  if (subscription.status == null || subscription.status === 'demo') return true
  return subscription.is_subscribed === true
}

function withTimeout<T>(promise: PromiseLike<T>, timeoutMs: number, label: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = window.setTimeout(() => {
      reject(new Error(`${label} timed out after ${timeoutMs}ms`))
    }, timeoutMs)

    promise.then(
      (value) => {
        window.clearTimeout(timer)
        resolve(value)
      },
      (error) => {
        window.clearTimeout(timer)
        reject(error)
      },
    )
  })
}

async function awaitSupabaseAuth<T>(promise: PromiseLike<T>, label: string): Promise<T> {
  const timer = window.setTimeout(() => {
    console.warn(`[app] ${label} is still pending after ${AUTH_BOOT_TIMEOUT_MS}ms`)
  }, AUTH_BOOT_TIMEOUT_MS)

  try {
    return await promise
  } finally {
    window.clearTimeout(timer)
  }
}

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
    const hasAccess =
      typeof parsed.hasAccess === 'boolean'
        ? parsed.hasAccess
        : typeof parsed.isSubscribed === 'boolean'
          ? parsed.isSubscribed
          : null

    if (typeof parsed.cachedAt !== 'number' || hasAccess == null) {
      window.localStorage.removeItem(getSubscriptionCacheKey(userId))
      return null
    }

    if (Date.now() - parsed.cachedAt > SUBSCRIPTION_CACHE_TTL_MS) {
      window.localStorage.removeItem(getSubscriptionCacheKey(userId))
      return null
    }

    return {
      hasAccess,
      status: typeof parsed.status === 'string' ? parsed.status : null,
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
    // Ignore storage write failures; runtime state already has the resolved value.
  }
}

function resolveInitialSupabaseSession(): Promise<BootstrapSession> {
  if (!initialSessionBootstrapPromise) {
    initialSessionBootstrapPromise = (async () => {
      const hash = window.location.hash.substring(1)
      const params = new URLSearchParams(hash)
      const accessToken = params.get('access_token')
      const refreshToken = params.get('refresh_token')
      const storedSession = readStoredSupabaseSession()

      if (accessToken && refreshToken) {
        window.history.replaceState(null, '', window.location.pathname)
        const { data, error } = await awaitSupabaseAuth(
          supabase.auth.setSession({
            access_token: accessToken,
            refresh_token: refreshToken,
          }),
          'supabase.auth.setSession',
        )
        if (error) throw error
        return data.session
      }

      if (!storedSession) {
        return null
      }

      try {
        const session = await awaitSupabaseAuth(getSupabaseSession(), 'supabase.auth.getSession')
        return session ?? storedSession
      } catch (warmupError) {
        console.warn('[app] supabase.auth.getSession() warmup failed', warmupError)
        return storedSession
      }
    })()
  }

  return initialSessionBootstrapPromise
}

function App() {
  const { t } = useAppI18n()
  const [session, setSession] = useState<{ user: { id: string; email?: string } } | null>(() => readStoredSupabaseSession())
  const [authStatus, setAuthStatus] = useState<BootstrapStatus>('loading')
  const [subscriptionStatus, setSubscriptionStatus] = useState<BootstrapStatus>(() => {
    const storedSession = readStoredSupabaseSession()
    return readCachedSubscription(storedSession?.user.id) == null ? 'loading' : 'ready'
  })
  const [subscriptionAccess, setSubscriptionAccess] = useState<SubscriptionAccessState>(() => {
    const storedSession = readStoredSupabaseSession()
    return readCachedSubscription(storedSession?.user.id) ?? { hasAccess: false, status: null }
  })
  const [pathname, setPathname] = useState(() => window.location.pathname)
  const initialProjectId = readProjectIdFromPath(pathname)

  const landingUrl = import.meta.env.VITE_LANDING_URL || 'http://localhost:3000'
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
    let authBootstrapSettled = false

    const resolveInitialSession = async () => {
      try {
        const nextSession = await resolveInitialSupabaseSession()
        if (!cancelled) setSession(nextSession)
      } catch (error) {
        console.error('[app] Failed to resolve auth session during bootstrap', error)
        if (!cancelled && !hasStoredSupabaseSession()) setSession(null)
      } finally {
        authBootstrapSettled = true
        if (!cancelled) setAuthStatus('ready')
      }
    }

    void resolveInitialSession()

    const { data: { subscription } } = supabase.auth.onAuthStateChange((_event, nextSession) => {
      if (cancelled) return
      setSession(nextSession)
      if (authBootstrapSettled) setAuthStatus('ready')
    })

    return () => {
      cancelled = true
      subscription.unsubscribe()
    }
  }, [])

  // Check subscription status after session is available
  useEffect(() => {
    let cancelled = false
    let activeSubscriptionAbortController: AbortController | null = null

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

    const fetchSubscriptionStatus = async (
      userId: string,
      timeoutMs: number,
    ): Promise<SubscriptionAccessState> => {
      activeSubscriptionAbortController?.abort()
      const abortController = new AbortController()
      activeSubscriptionAbortController = abortController

      try {
        const { data, error } = await withTimeout(
          supabase
            .from('user_subscription_status')
            .select('is_subscribed, status')
            .eq('user_id', userId)
            .abortSignal(abortController.signal)
            .maybeSingle(),
          timeoutMs,
          'user_subscription_status bootstrap',
        )

        if (error) throw error

        return {
          hasAccess: hasAppAccess(data),
          status: typeof data?.status === 'string' ? data.status : null,
        }
      } finally {
        if (activeSubscriptionAbortController === abortController) {
          activeSubscriptionAbortController = null
        }
        abortController.abort()
      }
    }

    const resetSessionToLogin = async () => {
      try {
        await supabase.auth.signOut()
      } catch (signOutError) {
        console.warn('[app] Failed to clear Supabase session after subscription bootstrap failure', signOutError)
      } finally {
        if (!cancelled) {
          setSubscriptionAccess({ hasAccess: false, status: null })
          setSession(null)
        }
      }
    }

    const resolveSubscription = async () => {
      try {
        const nextSubscription = await fetchSubscriptionStatus(
          session.user.id,
          SUBSCRIPTION_BOOT_TIMEOUT_MS,
        )
        if (cancelled) return

        setSubscriptionAccess(nextSubscription)
        writeCachedSubscription(session.user.id, nextSubscription)
      } catch (error) {
        if (cancelled) return

        const fallbackSubscription = readCachedSubscription(session.user.id)
        if (fallbackSubscription != null) {
          console.warn('[app] Subscription bootstrap timed out, using cached subscription state', error)
          setSubscriptionAccess(fallbackSubscription)
          return
        }

        console.warn('[app] Subscription bootstrap failed, refreshing auth before redirecting', error)

        try {
          const { data, error: refreshError } = await awaitSupabaseAuth(
            supabase.auth.refreshSession(),
            'supabase.auth.refreshSession',
          )

          if (refreshError) throw refreshError
          if (cancelled) return

          const refreshedSession = data.session
          if (!refreshedSession?.user?.id) {
            await resetSessionToLogin()
            return
          }

          setSession(refreshedSession)

          const nextSubscription = await fetchSubscriptionStatus(
            refreshedSession.user.id,
            SUBSCRIPTION_RETRY_TIMEOUT_MS,
          )
          if (cancelled) return

          setSubscriptionAccess(nextSubscription)
          writeCachedSubscription(refreshedSession.user.id, nextSubscription)
        } catch (recoveryError) {
          if (cancelled) return
          console.error('[app] Subscription bootstrap failed after refresh, redirecting to login', recoveryError)
          await resetSessionToLogin()
        }
      } finally {
        activeSubscriptionAbortController?.abort()
        if (!cancelled) setSubscriptionStatus('ready')
      }
    }

    void resolveSubscription()

    return () => {
      cancelled = true
      activeSubscriptionAbortController?.abort()
    }
  }, [authStatus, session?.user?.id])

  if (authStatus === 'loading' || (session && subscriptionStatus === 'loading')) {
    return <BootstrapScreen label={t('Loading...')} />
  }

  if (!session) {
    if (import.meta.env.DEV) {
      return (
        <DevAuthScreen
          landingUrl={landingUrl}
          onDevLogin={(email) => {
            if (typeof window !== 'undefined') {
              window.localStorage.setItem('redview:dev-session', 'true')
            }
            const devSession = { user: { id: 'dev-user-001', email: email || 'dev@redview.app' } }
            setSession(devSession)
            setSubscriptionAccess({ hasAccess: true, status: 'pro' })
            setSubscriptionStatus('ready')
          }}
        />
      )
    }

    window.location.href = `${landingUrl}/auth/login`
    return <BootstrapScreen label={t('Redirecting...')} />
  }

  if (!subscriptionAccess.hasAccess) {
    return <PayWall />
  }

  return (
    <Suspense fallback={<BootstrapScreen label={t('Loading dashboard...')} />}>
      <Dashboard
        email={session.user.email || 'unknown'}
        initialProjectId={initialProjectId}
        isDemoAccount={subscriptionAccess.status === 'demo'}
        offersUrl={offersUrl}
      />
    </Suspense>
  )
}

export default App
