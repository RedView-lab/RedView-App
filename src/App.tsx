import { useEffect, useState } from 'react'
import { hasStoredSupabaseSession, supabase } from './lib/supabase'
import { readProjectIdFromPath } from './lib/projectLocation'
import Dashboard from './pages/Dashboard'
import PayWall from './components/PayWall'
import './index.css'

type BootstrapStatus = 'loading' | 'ready'

function App() {
  const [session, setSession] = useState<{ user: { id: string; email?: string } } | null>(null)
  const [authStatus, setAuthStatus] = useState<BootstrapStatus>('loading')
  const [subscriptionStatus, setSubscriptionStatus] = useState<BootstrapStatus>('loading')
  const [isSubscribed, setIsSubscribed] = useState(false)
  const [initialProjectId] = useState(() => readProjectIdFromPath(window.location.pathname))

  const landingUrl = import.meta.env.VITE_LANDING_URL || 'http://localhost:3000'

  useEffect(() => {
    let cancelled = false

    const resolveInitialSession = async () => {
      const hash = window.location.hash.substring(1)
      const params = new URLSearchParams(hash)
      const accessToken = params.get('access_token')
      const refreshToken = params.get('refresh_token')
      const hasStoredSession = hasStoredSupabaseSession()

      try {
        if (accessToken && refreshToken) {
          // Clear hash from the URL immediately so refresh spam cannot re-process stale tokens.
          window.history.replaceState(null, '', window.location.pathname)
          const { data, error } = await supabase.auth.setSession({
            access_token: accessToken,
            refresh_token: refreshToken,
          })
          if (error) throw error
          if (!cancelled) setSession(data.session)
          return
        }

        if (!hasStoredSession) {
          if (!cancelled) setSession(null)
          return
        }

        const {
          data: { session },
          error,
        } = await supabase.auth.getSession()
        if (error) throw error
        if (!cancelled) setSession(session)
      } catch (error) {
        console.error('[app] Failed to resolve auth session during bootstrap', error)
        if (!cancelled) setSession(null)
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

    if (!session?.user?.id) {
      setIsSubscribed(false)
      setSubscriptionStatus('ready')
      return
    }

    setSubscriptionStatus('loading')

    const resolveSubscription = async () => {
      try {
        const { data, error } = await supabase
          .from('user_subscription_status')
          .select('is_subscribed')
          .eq('user_id', session.user.id)
          .maybeSingle()

        if (cancelled) return

        if (error) {
          console.error('[app] Failed to resolve subscription status', error)
          setIsSubscribed(false)
        } else {
          setIsSubscribed(data?.is_subscribed ?? false)
        }
      } catch (error) {
        if (cancelled) return
        console.error('[app] Subscription bootstrap crashed', error)
        setIsSubscribed(false)
      } finally {
        if (!cancelled) setSubscriptionStatus('ready')
      }
    }

    void resolveSubscription()

    return () => {
      cancelled = true
    }
  }, [session?.user?.id])

  if (authStatus === 'loading' || (session && subscriptionStatus === 'loading')) {
    return (
      <div className="loading">
        <p>Loading...</p>
      </div>
    )
  }

  if (!session) {
    window.location.href = `${landingUrl}/auth/login`
    return (
      <div className="loading">
        <p>Redirecting...</p>
      </div>
    )
  }

  if (!isSubscribed) {
    return <PayWall landingUrl={landingUrl} />
  }

  return (
    <Dashboard
      email={session.user.email || 'unknown'}
      initialProjectId={initialProjectId}
    />
  )
}

export default App
