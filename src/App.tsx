import { Suspense, lazy, useEffect, useState } from 'react'
import { hasStoredSupabaseSession, readStoredSupabaseSession, supabase } from './lib/supabase'
import { readProjectIdFromPath } from './lib/projectLocation'
import PayWall from './components/PayWall'
import './index.css'

const Dashboard = lazy(() => import('./pages/Dashboard'))

type BootstrapStatus = 'loading' | 'ready'

const AUTH_BOOT_TIMEOUT_MS = 4000
const SUBSCRIPTION_BOOT_TIMEOUT_MS = 4000
const SUBSCRIPTION_CACHE_KEY_PREFIX = 'redview:subscription-status:'
const SUBSCRIPTION_CACHE_TTL_MS = 6 * 60 * 60 * 1000

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

        if (!cancelled) setSession(storedSession)
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

    const resolveSubscription = async () => {
      const abortController = new AbortController()

      try {
        const { data, error } = await withTimeout(
          supabase
            .from('user_subscription_status')
            .select('is_subscribed')
            .eq('user_id', session.user.id)
            .abortSignal(abortController.signal)
            .maybeSingle(),
          SUBSCRIPTION_BOOT_TIMEOUT_MS,
          'user_subscription_status bootstrap',
        )

        if (cancelled) return

        if (error) {
          console.error('[app] Failed to resolve subscription status', error)
          setIsSubscribed(false)
          writeCachedSubscription(session.user.id, false)
        } else {
          const nextIsSubscribed = data?.is_subscribed ?? false
          setIsSubscribed(nextIsSubscribed)
          writeCachedSubscription(session.user.id, nextIsSubscribed)
        }
      } catch (error) {
        abortController.abort()
        if (cancelled) return
        console.error('[app] Subscription bootstrap crashed', error)
        const fallbackIsSubscribed = readCachedSubscription(session.user.id) ?? false
        setIsSubscribed(fallbackIsSubscribed)
      } finally {
        abortController.abort()
        if (!cancelled) setSubscriptionStatus('ready')
      }
    }

    void resolveSubscription()

    return () => {
      cancelled = true
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
    return <PayWall landingUrl={landingUrl} />
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
