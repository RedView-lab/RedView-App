import { useState, type FormEvent } from 'react'
import {
  account,
  OAuthProvider,
  saveStoredAppwriteSession,
} from '@/shared/services/appwrite'
import VerificationCodeModal from './VerificationCodeModal'
import './LoginScreen.css'

interface LoginScreenProps {
  onLogin?: (email?: string) => void
  landingUrl?: string
}

type AuthMode = 'login' | 'signup'

export default function LoginScreen({ onLogin, landingUrl = 'http://landing.141.145.220.99.sslip.io' }: LoginScreenProps) {
  const [mode, setMode] = useState<AuthMode>('login')
  const [name, setName] = useState('')
  const [email, setEmail] = useState('')
  const [password, setPassword] = useState('')
  const [rememberMe, setRememberMe] = useState(false)
  const [loading, setLoading] = useState(false)
  const [errorMessage, setErrorMessage] = useState<string | null>(null)

  // Verification modal states
  const [showVerificationModal, setShowVerificationModal] = useState(false)
  const [verificationDebugCode, setVerificationDebugCode] = useState<string | undefined>()

  const handleSubmit = async (e: FormEvent) => {
    e.preventDefault()
    setErrorMessage(null)
    setLoading(true)

    const trimmedEmail = email.trim()
    if (!trimmedEmail || !password) {
      setErrorMessage('Please provide both email and password.')
      setLoading(false)
      return
    }

    try {
      // In case an old session remains active
      try {
        await account.deleteSession('current')
      } catch {
        // Ignore if no active session
      }

      if (mode === 'signup') {
        const trimmedName = name.trim() || trimmedEmail.split('@')[0] || 'User'
        // Call API to send 4-digit verification code via Resend
        const res = await fetch('/api/auth/send-verification-code', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ email: trimmedEmail, name: trimmedName }),
        })
        const data = await res.json().catch(() => ({}))

        if (!res.ok) {
          setErrorMessage(data.error || "Impossible d'envoyer le code de vérification.")
          setLoading(false)
          return
        }

        setVerificationDebugCode(data.debugCode)
        setShowVerificationModal(true)
        setLoading(false)
        return
      }

      // Mode login
      await account.createEmailPasswordSession(trimmedEmail, password)

      const user = await account.get()
      saveStoredAppwriteSession({ id: user.$id, email: user.email, name: user.name })
      onLogin?.(user.email)
    } catch (error: any) {
      console.warn('[auth] Appwrite action error:', error)
      const message = error?.message || 'Authentication failed. Please check your credentials.'
      setErrorMessage(message)
    } finally {
      setLoading(false)
    }
  }

  const handleConfirmVerification = async (code: string): Promise<{ success: boolean; error?: string }> => {
    const trimmedEmail = email.trim()
    const trimmedName = name.trim() || trimmedEmail.split('@')[0] || 'User'

    try {
      const res = await fetch('/api/auth/verify-code', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          email: trimmedEmail,
          code,
          name: trimmedName,
          password,
        }),
      })

      const data = await res.json().catch(() => ({}))
      if (!res.ok) {
        return { success: false, error: data.error || 'Code invalide.' }
      }

      // Account created with email verified -> establish session
      await account.createEmailPasswordSession(trimmedEmail, password)
      const user = await account.get()
      saveStoredAppwriteSession({ id: user.$id, email: user.email, name: user.name })

      setShowVerificationModal(false)
      onLogin?.(user.email)
      return { success: true }
    } catch (err: any) {
      return { success: false, error: err?.message || 'Erreur lors de la confirmation du compte.' }
    }
  }

  const handleResendVerification = async (): Promise<{ success: boolean; debugCode?: string; error?: string }> => {
    const trimmedEmail = email.trim()
    const trimmedName = name.trim() || trimmedEmail.split('@')[0] || 'User'

    try {
      const res = await fetch('/api/auth/send-verification-code', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email: trimmedEmail, name: trimmedName }),
      })
      const data = await res.json().catch(() => ({}))
      if (!res.ok) {
        return { success: false, error: data.error || 'Impossible de renvoyer le code.' }
      }
      return { success: true, debugCode: data.debugCode }
    } catch (err: any) {
      return { success: false, error: err?.message || 'Erreur lors du renvoi du code.' }
    }
  }

  const handleGoogleAuth = () => {
    setErrorMessage(null)
    try {
      account.createOAuth2Session(
        OAuthProvider.Google,
        window.location.origin,
        window.location.origin,
      )
    } catch (error: any) {
      setErrorMessage(error?.message || 'Failed to initiate Google OAuth.')
    }
  }

  const isLogin = mode === 'login'

  return (
    <div className="rv-login-page">
      {!showVerificationModal && (
        <>
          {/* Header navigation */}
          <header className="rv-login-header-nav">
            <div className="rv-login-header-container">
              {/* Frame 36468 — Logo */}
              <a href={landingUrl} className="rv-login-logo-link" aria-label="RedView">
                <img
                  src="/landing/icons/redview-logo.svg"
                  alt="RedView"
                  className="rv-login-logo-img"
                />
              </a>

              {/* Row */}
              <div className="rv-login-header-row">
                <span className="rv-login-header-text">
                  {isLogin ? "Don't have an account?" : 'Already have an account?'}
                </span>
                <button
                  type="button"
                  className="rv-login-header-btn"
                  onClick={() => {
                    setMode(isLogin ? 'signup' : 'login')
                    setErrorMessage(null)
                  }}
                >
                  {isLogin ? 'Sign up' : 'Log in'}
                </button>
              </div>
            </div>
          </header>

          {/* Container */}
          <main className="rv-login-main-container">
        {/* Content */}
        <div className="rv-login-content">
          {/* Header */}
          <div className="rv-login-card-header">
            {/* Text and supporting text */}
            <div className="rv-login-title-group">
              <h1 className="rv-login-title">
                {isLogin ? 'Log in to your account' : 'Create an account'}
              </h1>
              <p className="rv-login-subtitle">
                {isLogin
                  ? 'Welcome back! Please enter your details.'
                  : 'Start your 30-day free trial.'}
              </p>
            </div>

            {/* Horizontal tabs */}
            <div className="rv-login-tabs" role="tablist">
              <button
                type="button"
                role="tab"
                aria-selected={!isLogin}
                className={`rv-login-tab-btn ${!isLogin ? 'rv-active' : ''}`}
                onClick={() => {
                  setMode('signup')
                  setErrorMessage(null)
                }}
              >
                Sign up
              </button>
              <button
                type="button"
                role="tab"
                aria-selected={isLogin}
                className={`rv-login-tab-btn ${isLogin ? 'rv-active' : ''}`}
                onClick={() => {
                  setMode('login')
                  setErrorMessage(null)
                }}
              >
                Log in
              </button>
            </div>
          </div>

          {/* Content Body */}
          <div className="rv-login-body">
            {/* Error Message banner */}
            {errorMessage && (
              <div
                style={{
                  padding: '12px 16px',
                  borderRadius: '10px',
                  background: 'rgba(239, 68, 68, 0.15)',
                  border: '1px solid rgba(239, 68, 68, 0.3)',
                  color: '#fca5a5',
                  fontSize: '14px',
                  lineHeight: '1.4',
                  textAlign: 'center',
                }}
              >
                {errorMessage}
              </div>
            )}

            {/* Form */}
            <form onSubmit={handleSubmit} className="rv-login-form">
              {/* Name Input Field (Sign up only) */}
              {!isLogin && (
                <div className="rv-login-input-field">
                  <div className="rv-login-label-wrapper">
                    <label htmlFor="rv-name" className="rv-login-label">
                      Name
                    </label>
                  </div>
                  <input
                    id="rv-name"
                    type="text"
                    value={name}
                    onChange={(e) => setName(e.target.value)}
                    placeholder="Enter your name"
                    className="rv-login-input"
                    autoComplete="name"
                    required
                  />
                </div>
              )}

              {/* Email Input Field */}
              <div className="rv-login-input-field">
                <div className="rv-login-label-wrapper">
                  <label htmlFor="rv-email" className="rv-login-label">
                    Email
                  </label>
                </div>
                <input
                  id="rv-email"
                  type="email"
                  value={email}
                  onChange={(e) => setEmail(e.target.value)}
                  placeholder="Enter your email"
                  className="rv-login-input"
                  autoComplete="email"
                  required
                />
              </div>

              {/* Password Input Field */}
              <div className="rv-login-input-field">
                <div className="rv-login-label-wrapper">
                  <label htmlFor="rv-password" className="rv-login-label">
                    Password
                  </label>
                </div>
                <input
                  id="rv-password"
                  type="password"
                  value={password}
                  onChange={(e) => setPassword(e.target.value)}
                  placeholder={isLogin ? '••••••••' : 'Create a password'}
                  className="rv-login-input"
                  autoComplete={isLogin ? 'current-password' : 'new-password'}
                  required
                />
                {!isLogin && (
                  <span className="rv-login-hint-text">
                    Must be at least 8 characters.
                  </span>
                )}
              </div>

              {/* Row: Checkbox & Forgot Password (Log in only) */}
              {isLogin && (
                <div className="rv-login-row">
                  <label className="rv-login-checkbox-label">
                    <input
                      type="checkbox"
                      checked={rememberMe}
                      onChange={(e) => setRememberMe(e.target.checked)}
                      className="rv-login-checkbox"
                    />
                    <span className="rv-login-checkbox-text">Remember for 30 days</span>
                  </label>

                  <button
                    type="button"
                    className="rv-login-forgot-btn"
                    onClick={() => alert('Password reset instructions will be sent to your email.')}
                  >
                    Forgot password
                  </button>
                </div>
              )}

              {/* Actions */}
              <div className="rv-login-actions">
                {/* Primary Button */}
                <button type="submit" className="rv-login-submit-btn" disabled={loading}>
                  {loading ? 'Processing...' : isLogin ? 'Sign in' : 'Get started'}
                </button>

                {/* Social Button: Google */}
                <div className="rv-login-social-group">
                  <button
                    type="button"
                    className="rv-login-social-btn"
                    onClick={handleGoogleAuth}
                    disabled={loading}
                  >
                    <span className="rv-login-social-icon">
                      <svg width="24" height="24" viewBox="0 0 24 24" fill="none" aria-hidden="true">
                        <path
                          fill="#4285F4"
                          d="M23.49 12.27c0-.79-.07-1.55-.2-2.27H12v4.29h6.44a5.5 5.5 0 0 1-2.39 3.61v2.99h3.86c2.26-2.08 3.58-5.15 3.58-8.62Z"
                        />
                        <path
                          fill="#34A853"
                          d="M12 24c3.24 0 5.95-1.07 7.93-2.91l-3.86-2.99c-1.07.72-2.44 1.14-4.07 1.14-3.13 0-5.79-2.11-6.74-4.95H1.27v3.08A11.99 11.99 0 0 0 12 24Z"
                        />
                        <path
                          fill="#FBBC05"
                          d="M5.26 14.29A7.2 7.2 0 0 1 4.88 12c0-.79.14-1.56.38-2.29V6.63H1.27A11.99 11.99 0 0 0 0 12c0 1.94.46 3.77 1.27 5.37l3.99-3.08Z"
                        />
                        <path
                          fill="#EA4335"
                          d="M12 4.77c1.76 0 3.34.61 4.58 1.81l3.43-3.43C17.94 1.15 15.24 0 12 0A11.99 11.99 0 0 0 1.27 6.63l3.99 3.08c.95-2.84 3.61-4.94 6.74-4.94Z"
                        />
                      </svg>
                    </span>
                    {isLogin ? 'Sign in with Google' : 'Sign up with Google'}
                  </button>
                </div>
              </div>
            </form>

            {/* Footer Action */}
            {isLogin ? (
              <button
                type="button"
                className="rv-login-footer-action"
                onClick={() => {
                  // Fallback to dev login if needed
                  if (typeof window !== 'undefined') {
                    window.localStorage.setItem('redview:dev-session', 'true')
                  }
                  onLogin?.('dev@redview.app')
                }}
              >
                Continue with Demo account
              </button>
            ) : (
              <button
                type="button"
                className="rv-login-footer-action"
                onClick={() => {
                  setMode('login')
                  setErrorMessage(null)
                }}
              >
                Already have an account? Log in
              </button>
            )}
          </div>
        </div>
      </main>
        </>
      )}

      {/* 4-digit Email Verification Modal */}
      <VerificationCodeModal
        isOpen={showVerificationModal}
        email={email.trim()}
        debugCode={verificationDebugCode}
        onClose={() => setShowVerificationModal(false)}
        onConfirm={handleConfirmVerification}
        onResend={handleResendVerification}
      />
    </div>
  )
}
