import { useState, type FormEvent } from 'react'
import { supabase } from '@/shared/services/supabase'

interface DevAuthScreenProps {
  onDevLogin: (email?: string) => void
  landingUrl: string
}

export default function DevAuthScreen({ onDevLogin, landingUrl }: DevAuthScreenProps) {
  const [email, setEmail] = useState('')
  const [password, setPassword] = useState('')
  const [loading, setLoading] = useState(false)
  const [errorMessage, setErrorMessage] = useState<string | null>(null)
  const [showSupabaseForm, setShowSupabaseForm] = useState(false)

  const handleSupabaseLogin = async (e: FormEvent) => {
    e.preventDefault()
    if (!email || !password) {
      setErrorMessage('Veuillez renseigner email et mot de passe.')
      return
    }

    setLoading(true)
    setErrorMessage(null)

    try {
      const { error } = await supabase.auth.signInWithPassword({
        email: email.trim(),
        password,
      })

      if (error) {
        setErrorMessage(error.message)
      }
    } catch (err) {
      setErrorMessage(err instanceof Error ? err.message : 'Erreur de connexion')
    } finally {
      setLoading(false)
    }
  }

  return (
    <div
      style={{
        minHeight: '100vh',
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        background: '#090a0f',
        color: '#f3f4f6',
        fontFamily: "'Rethink Sans', 'DM Sans', system-ui, sans-serif",
        padding: '24px',
      }}
    >
      <div
        style={{
          width: '100%',
          maxWidth: '440px',
          background: 'rgba(18, 20, 29, 0.95)',
          border: '1px solid rgba(255, 255, 255, 0.08)',
          borderRadius: '16px',
          boxShadow: '0 20px 50px rgba(0, 0, 0, 0.5), 0 0 0 1px rgba(255, 255, 255, 0.05)',
          padding: '32px',
          display: 'flex',
          flexDirection: 'column',
          gap: '24px',
        }}
      >
        {/* Header */}
        <div style={{ textAlign: 'center', display: 'flex', flexDirection: 'column', alignItems: 'center', gap: '8px' }}>
          <div
            style={{
              display: 'inline-flex',
              alignItems: 'center',
              gap: '8px',
              background: 'rgba(239, 68, 68, 0.12)',
              border: '1px solid rgba(239, 68, 68, 0.3)',
              borderRadius: '999px',
              padding: '4px 12px',
              fontSize: '12px',
              fontWeight: 600,
              color: '#f87171',
              letterSpacing: '0.04em',
              textTransform: 'uppercase',
            }}
          >
            <span style={{ width: '6px', height: '6px', borderRadius: '50%', background: '#ef4444' }} />
            Environnement Local
          </div>
          <h1 style={{ fontSize: '24px', fontWeight: 700, margin: '6px 0 2px', letterSpacing: '-0.02em', color: '#fff' }}>
            RedView Dev
          </h1>
          <p style={{ fontSize: '13px', color: '#9ca3af', lineHeight: 1.5, margin: 0 }}>
            Aucune session active détectée. Vous pouvez accéder directement à l&apos;application en mode dev ou vous connecter.
          </p>
        </div>

        {/* 1-Click Dev Access */}
        <div style={{ display: 'flex', flexDirection: 'column', gap: '10px' }}>
          <button
            type="button"
            onClick={() => onDevLogin()}
            style={{
              width: '100%',
              padding: '12px 18px',
              background: 'linear-gradient(135deg, #ef4444 0%, #dc2626 100%)',
              color: '#ffffff',
              border: 'none',
              borderRadius: '10px',
              fontSize: '14px',
              fontWeight: 600,
              cursor: 'pointer',
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
              gap: '8px',
              boxShadow: '0 4px 14px rgba(239, 68, 68, 0.35)',
              transition: 'transform 0.15s ease, box-shadow 0.15s ease',
            }}
            onMouseOver={(e) => {
              e.currentTarget.style.transform = 'translateY(-1px)'
              e.currentTarget.style.boxShadow = '0 6px 18px rgba(239, 68, 68, 0.45)'
            }}
            onMouseOut={(e) => {
              e.currentTarget.style.transform = 'none'
              e.currentTarget.style.boxShadow = '0 4px 14px rgba(239, 68, 68, 0.35)'
            }}
          >
            ⚡ Entrer directement (Mode Dev Pro)
          </button>
          <span style={{ fontSize: '11px', color: '#6b7280', textAlign: 'center' }}>
            Accès instantané avec toutes les fonctionnalités débloquées
          </span>
        </div>

        {/* Divider */}
        <div style={{ display: 'flex', alignItems: 'center', gap: '12px' }}>
          <div style={{ flex: 1, height: '1px', background: 'rgba(255, 255, 255, 0.08)' }} />
          <span style={{ fontSize: '11px', color: '#6b7280', textTransform: 'uppercase', letterSpacing: '0.05em' }}>ou</span>
          <div style={{ flex: 1, height: '1px', background: 'rgba(255, 255, 255, 0.08)' }} />
        </div>

        {/* Supabase direct login toggle */}
        {!showSupabaseForm ? (
          <button
            type="button"
            onClick={() => setShowSupabaseForm(true)}
            style={{
              width: '100%',
              padding: '10px 16px',
              background: 'rgba(255, 255, 255, 0.04)',
              border: '1px solid rgba(255, 255, 255, 0.08)',
              borderRadius: '10px',
              color: '#d1d5db',
              fontSize: '13px',
              fontWeight: 500,
              cursor: 'pointer',
              transition: 'background 0.15s ease',
            }}
            onMouseOver={(e) => (e.currentTarget.style.background = 'rgba(255, 255, 255, 0.08)')}
            onMouseOut={(e) => (e.currentTarget.style.background = 'rgba(255, 255, 255, 0.04)')}
          >
            🔑 Connexion avec compte Supabase
          </button>
        ) : (
          <form onSubmit={handleSupabaseLogin} style={{ display: 'flex', flexDirection: 'column', gap: '12px' }}>
            <div style={{ display: 'flex', flexDirection: 'column', gap: '6px' }}>
              <label style={{ fontSize: '12px', color: '#9ca3af', fontWeight: 500 }}>Email Supabase</label>
              <input
                type="email"
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                placeholder="votre-email@example.com"
                required
                style={{
                  width: '100%',
                  padding: '10px 12px',
                  background: 'rgba(0, 0, 0, 0.3)',
                  border: '1px solid rgba(255, 255, 255, 0.12)',
                  borderRadius: '8px',
                  color: '#fff',
                  fontSize: '13px',
                  outline: 'none',
                }}
              />
            </div>
            <div style={{ display: 'flex', flexDirection: 'column', gap: '6px' }}>
              <label style={{ fontSize: '12px', color: '#9ca3af', fontWeight: 500 }}>Mot de passe</label>
              <input
                type="password"
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                placeholder="••••••••"
                required
                style={{
                  width: '100%',
                  padding: '10px 12px',
                  background: 'rgba(0, 0, 0, 0.3)',
                  border: '1px solid rgba(255, 255, 255, 0.12)',
                  borderRadius: '8px',
                  color: '#fff',
                  fontSize: '13px',
                  outline: 'none',
                }}
              />
            </div>

            {errorMessage && (
              <div
                style={{
                  fontSize: '12px',
                  color: '#f87171',
                  background: 'rgba(239, 68, 68, 0.1)',
                  border: '1px solid rgba(239, 68, 68, 0.2)',
                  borderRadius: '6px',
                  padding: '8px 10px',
                }}
              >
                {errorMessage}
              </div>
            )}

            <button
              type="submit"
              disabled={loading}
              style={{
                width: '100%',
                padding: '10px 16px',
                background: '#374151',
                color: '#fff',
                border: 'none',
                borderRadius: '8px',
                fontSize: '13px',
                fontWeight: 600,
                cursor: loading ? 'not-allowed' : 'pointer',
                opacity: loading ? 0.7 : 1,
              }}
            >
              {loading ? 'Connexion en cours...' : 'Se connecter'}
            </button>
          </form>
        )}

        {/* Footer landing page link */}
        <div style={{ textAlign: 'center', paddingTop: '4px' }}>
          <a
            href={`${landingUrl}/auth/login`}
            style={{
              fontSize: '12px',
              color: '#6b7280',
              textDecoration: 'none',
              transition: 'color 0.15s ease',
            }}
            onMouseOver={(e) => (e.currentTarget.style.color = '#9ca3af')}
            onMouseOut={(e) => (e.currentTarget.style.color = '#6b7280')}
          >
            Ouvrir la Landing Page ({landingUrl}) ↗
          </a>
        </div>
      </div>
    </div>
  )
}
