import { useEffect, useState } from 'react'
import { supabase } from './lib/supabase'
import Dashboard from './pages/Dashboard'
import './index.css'

function App() {
  const [session, setSession] = useState<{ user: { email?: string } } | null>(null)
  const [loading, setLoading] = useState(true)

  useEffect(() => {
    supabase.auth.getSession().then(({ data: { session } }) => {
      setSession(session)
      setLoading(false)
    })

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
        <p className="accent">{"> "}loading...</p>
      </div>
    )
  }

  if (!session) {
    const landingUrl = import.meta.env.VITE_LANDING_URL || 'http://localhost:3000'
    window.location.href = `${landingUrl}/auth/login`
    return (
      <div className="loading">
        <p>{"> "}redirecting to authentication...</p>
      </div>
    )
  }

  return <Dashboard email={session.user.email || 'unknown'} onLogout={handleLogout} />
}

export default App
