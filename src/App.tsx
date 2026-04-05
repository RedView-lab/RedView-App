import { useEffect, useState } from 'react'
import { supabase } from './lib/supabase'
import Dashboard from './pages/Dashboard'
import './index.css'

function App() {
  const [session, setSession] = useState<{ user: { email?: string } } | null>(null)
  const [loading, setLoading] = useState(true)

  useEffect(() => {
    const hash = window.location.hash.substring(1)
    const params = new URLSearchParams(hash)
    const accessToken = params.get('access_token')
    const refreshToken = params.get('refresh_token')

    if (accessToken && refreshToken) {
      // Clear hash from URL
      window.history.replaceState(null, '', window.location.pathname)
      supabase.auth.setSession({ access_token: accessToken, refresh_token: refreshToken }).then(({ data }) => {
        setSession(data.session)
        setLoading(false)
      })
    } else {
      supabase.auth.getSession().then(({ data: { session } }) => {
        setSession(session)
        setLoading(false)
      })
    }

    const { data: { subscription } } = supabase.auth.onAuthStateChange((_event, session) => {
      setSession(session)
    })

    return () => subscription.unsubscribe()
  }, [])

  const handleLogout = async () => {
    await supabase.auth.signOut()
    const landingUrl = import.meta.env.VITE_LANDING_URL || 'http://localhost:3000'
    window.location.href = landingUrl
  }

  if (loading) {
    return (
      <div className="loading">
        <p>Loading...</p>
      </div>
    )
  }

  if (!session) {
    const landingUrl = import.meta.env.VITE_LANDING_URL || 'http://localhost:3000'
    window.location.href = `${landingUrl}/auth/login`
    return (
      <div className="loading">
        <p>Redirecting...</p>
      </div>
    )
  }

  return <Dashboard email={session.user.email || 'unknown'} onLogout={handleLogout} />
}

export default App
