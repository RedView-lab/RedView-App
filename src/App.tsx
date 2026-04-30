import { Suspense, lazy, useEffect, useState } from 'react'
import { hasStoredSupabaseSession, readStoredSupabaseSession, supabase } from './shared/services/supabase'
import { readProjectIdFromPath } from './shared/utils/projectLocation'
import PayWall from './shared/components/PayWall'
import './index.css'

const Dashboard = lazy(() => import('./pages/Dashboard'))

type BootstrapStatus = 'loading' | 'ready'

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

type CachedSubscriptionSnapshot = {
  isSubscribed: boolean
  cachedAt: number
}

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

function readCachedSubscription(userId: string | null | undefined): boolean | null {
  if (!userId) return null

  try {
    const raw = window.localStorage.getItem(getSubscriptionCacheKey(userId))
    if (!raw) return null

    const parsed = JSON.parse(raw) as Partial<CachedSubscriptionSnapshot>
    if (typeof parsed.cachedAt !== 'number' || typeof parsed.isSubscribed !== 'boolean') {
      window.localStorage.removeItem(getSubscriptionCacheKey(userId))
      return null
    }

    if (Date.now() - parsed.cachedAt > SUBSCRIPTION_CACHE_TTL_MS) {
      window.localStorage.removeItem(getSubscriptionCacheKey(userId))
      return null
    }

    return parsed.isSubscribed
  } catch {
    return null
  }
}

function writeCachedSubscription(userId: string, isSubscribed: boolean): void {
  try {
    const payload: CachedSubscriptionSnapshot = {
      isSubscribed,
      cachedAt: Date.now(),
    }
    window.localStorage.setItem(getSubscriptionCacheKey(userId), JSON.stringify(payload))
  } catch {
    // Ignore storage write failures; runtime state already has the resolved value.
  }
}

function App() {
  const [session, setSession] = useState<{ user: { id: string; email?: string } } | null>(() => readStoredSupabaseSession())
  const [authStatus, setAuthStatus] = useState<BootstrapStatus>('loading')
  const [subscriptionStatus, setSubscriptionStatus] = useState<BootstrapStatus>(() => {
    const storedSession = readStoredSupabaseSession()
    return readCachedSubscription(storedSession?.user.id) == null ? 'loading' : 'ready'
  })
  const [isSubscribed, setIsSubscribed] = useState(() => {
    const storedSession = readStoredSupabaseSession()
    return readCachedSubscription(storedSession?.user.id) ?? false
  })
  const [initialProjectId] = useState(() => readProjectIdFromPath(window.location.pathname))

  const landingUrl = import.meta.env.VITE_LANDING_URL || 'http://localhost:3000'

  useEffect(() => {
    let cancelled = false

    const resolveInitialSession = async () => {
      const hash = window.location.hash.substring(1)
      const params = new URLSearchParams(hash)
      const accessToken = params.get('access_token')
      const refreshToken = params.get('refresh_token')
      const storedSession = readStoredSupabaseSession()

      try {
        if (accessToken && refreshToken) {
          // Clear hash from the URL immediately so refresh spam cannot re-process stale tokens.
          window.history.replaceState(null, '', window.location.pathname)
          const { data, error } = await withTimeout(
            supabase.auth.setSession({
              access_token: accessToken,
              refresh_token: refreshToken,
            }),
            AUTH_BOOT_TIMEOUT_MS,
            'supabase.auth.setSession',
          )
          if (error) throw error
          if (!cancelled) setSession(data.session)
          return
        }

        if (!storedSession) {
          if (!cancelled) setSession(null)
          return
        }

        // Optimistic UI: surface the stored session immediately so the dashboard can mount.
        if (!cancelled) setSession(storedSession)

        // IMPORTANT: pre-warm the supabase-js auth client. Without this the very first
        // authenticated query (e.g. `from('user_subscription_status')`) is the one that
        // triggers `_initialize()` + a possible refresh token roundtrip, which on a cold
        // tab routinely blows past the subscription bootstrap timeout. `getSession()` waits
        // on the LockManager for any in-flight refresh and returns a usable token, so all
        // subsequent PostgREST calls run against an already-initialised client.
        try {
          const { data, error } = await withTimeout(
            supabase.auth.getSession(),
            AUTH_BOOT_TIMEOUT_MS,
            'supabase.auth.getSession',
          )
          if (error) throw error
          if (!cancelled && data.session) setSession(data.session)
        } catch (warmupError) {
          // Non-fatal: the subscription bootstrap below will retry via refreshSession() if
          // it fails. We just log and let the rest of the bootstrap proceed.
          console.warn('[app] supabase.auth.getSession() warmup failed', warmupError)
        }
      } catch (error) {
        console.error('[app] Failed to resolve auth session during bootstrap', error)
        if (!cancelled && !hasStoredSupabaseSession()) setSession(null)
      } finally {
        if (!cancelled) setAuthStatus('ready')
      }
    }

    void resolveInitialSession()

    const { data: { subscription } } = supabase.auth.onAuthStateChange((_event, nextSession) => {
      if (cancelled) return
      setSession(nextSession)
      setAuthStatus('ready')
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
      setIsSubscribed(false)
      setSubscriptionStatus('ready')
      return
    }

    const cachedSubscription = readCachedSubscription(session.user.id)
    if (cachedSubscription != null) {
      setIsSubscribed(cachedSubscription)
      setSubscriptionStatus('ready')
    } else {
      setSubscriptionStatus('loading')
    }

    const fetchSubscriptionStatus = async (userId: string, timeoutMs: number): Promise<boolean> => {
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

        return hasAppAccess(data)
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
          setIsSubscribed(false)
          setSession(null)
        }
      }
    }

    const resolveSubscription = async () => {
      try {
        const nextIsSubscribed = await fetchSubscriptionStatus(session.user.id, SUBSCRIPTION_BOOT_TIMEOUT_MS)
        if (cancelled) return

        setIsSubscribed(nextIsSubscribed)
        writeCachedSubscription(session.user.id, nextIsSubscribed)
      } catch (error) {
        if (cancelled) return

        const fallbackIsSubscribed = readCachedSubscription(session.user.id)
        if (fallbackIsSubscribed != null) {
          console.warn('[app] Subscription bootstrap timed out, using cached subscription state', error)
          setIsSubscribed(fallbackIsSubscribed)
          return
        }

        console.warn('[app] Subscription bootstrap failed, refreshing auth before redirecting', error)

        try {
          const { data, error: refreshError } = await withTimeout(
            supabase.auth.refreshSession(),
            AUTH_BOOT_TIMEOUT_MS,
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

          const nextIsSubscribed = await fetchSubscriptionStatus(
            refreshedSession.user.id,
            SUBSCRIPTION_RETRY_TIMEOUT_MS,
          )
          if (cancelled) return

          setIsSubscribed(nextIsSubscribed)
          writeCachedSubscription(refreshedSession.user.id, nextIsSubscribed)
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
    return <BootstrapScreen label="Loading..." />
  }

  if (!session) {
    window.location.href = `${landingUrl}/auth/login`
    return <BootstrapScreen label="Redirecting..." />
  }

  if (!isSubscribed) {
    return <PayWall />
  }

  return (
    <Suspense fallback={<BootstrapScreen label="Loading dashboard..." />}>
      <Dashboard
        email={session.user.email || 'unknown'}
        initialProjectId={initialProjectId}
      />
    </Suspense>
  )
}

export default App
