import { useState, useEffect, type FormEvent } from 'react'
import { trackAnalyticsEvent } from '@/shared/lib/analytics'
import {
  account,
  ID,
  OAuthProvider,
  saveStoredAppwriteSession,
} from '@/shared/services/appwrite'
import VerificationCodeModal from './VerificationCodeModal'
import './LoginScreen.css'

// Envoi du code de vérification à 4 chiffres par e-mail lors de l'inscription
const ENABLE_EMAIL_VERIFICATION = true

type AuthMode = 'login' | 'signup' | 'forgot-password' | 'reset-password'

interface LoginScreenProps {
  onLogin?: (email?: string) => void
  landingUrl?: string
}

function EyeIcon() {
  return (
    <svg width="20" height="20" viewBox="0 0 20 20" fill="none" xmlns="http://www.w3.org/2000/svg" aria-hidden="true">
      <path
        d="M2.01677 10.5943C1.90328 10.4146 1.84654 10.3248 1.81477 10.1862C1.79091 10.0821 1.79091 9.91791 1.81477 9.81381C1.84654 9.67522 1.90328 9.58537 2.01677 9.40567C2.95461 7.92069 5.74617 4.16666 10.0003 4.16666C14.2545 4.16666 17.0461 7.92069 17.9839 9.40567C18.0974 9.58537 18.1541 9.67522 18.1859 9.81381C18.2098 9.91791 18.2098 10.0821 18.1859 10.1862C18.1541 10.3248 18.0974 10.4146 17.9839 10.5943C17.0461 12.0793 14.2545 15.8333 10.0003 15.8333C5.74617 15.8333 2.95461 12.0793 2.01677 10.5943Z"
        stroke="currentColor"
        strokeWidth="1.66667"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
      <path
        d="M10.0003 12.5C11.381 12.5 12.5003 11.3807 12.5003 9.99999C12.5003 8.61928 11.381 7.49999 10.0003 7.49999C8.61962 7.49999 7.50034 8.61928 7.50034 9.99999C7.50034 11.3807 8.61962 12.5 10.0003 12.5Z"
        stroke="currentColor"
        strokeWidth="1.66667"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  )
}

function EyeOffIcon() {
  return (
    <svg width="20" height="20" viewBox="0 0 20 20" fill="none" xmlns="http://www.w3.org/2000/svg" aria-hidden="true">
      <path
        d="M8.95245 4.2436C9.29113 4.19353 9.64051 4.16667 10.0003 4.16667C14.2545 4.16667 17.0461 7.9207 17.9839 9.40569C18.0974 9.58542 18.1542 9.67528 18.1859 9.81389C18.2098 9.91799 18.2098 10.0822 18.1859 10.1863C18.1541 10.3249 18.097 10.4154 17.9827 10.5963C17.7328 10.9918 17.3518 11.5476 16.8471 12.1504M5.6036 5.59586C3.80187 6.81808 2.57871 8.51615 2.01759 9.4044C1.90357 9.58489 1.84656 9.67514 1.81478 9.81374C1.79091 9.91783 1.7909 10.082 1.81476 10.1861C1.84652 10.3247 1.90328 10.4146 2.01678 10.5943C2.95462 12.0793 5.74618 15.8333 10.0003 15.8333C11.7157 15.8333 13.1932 15.223 14.4073 14.3972M2.50035 2.5L17.5003 17.5M8.23258 8.23223C7.78017 8.68464 7.50035 9.30964 7.50035 10C7.50035 11.3807 8.61963 12.5 10.0003 12.5C10.6907 12.5 11.3157 12.2202 11.7681 11.7678"
        stroke="currentColor"
        strokeWidth="1.66667"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  )
}

export default function LoginScreen({ onLogin, landingUrl = 'https://redview.tech' }: LoginScreenProps) {
  const [mode, setMode] = useState<AuthMode>('login')
  const [name, setName] = useState('')
  const [email, setEmail] = useState('')
  const [password, setPassword] = useState('')
  const [confirmPassword, setConfirmPassword] = useState('')
  const [showPassword, setShowPassword] = useState(false)
  const [showConfirmPassword, setShowConfirmPassword] = useState(false)
  const [rememberMe, setRememberMe] = useState(false)
  const [loading, setLoading] = useState(false)
  const [errorMessage, setErrorMessage] = useState<string | null>(null)
  const [successMessage, setSuccessMessage] = useState<string | null>(null)

  // Auto-detect recovery token in URL query
  useEffect(() => {
    if (typeof window !== 'undefined') {
      const params = new URLSearchParams(window.location.search)
      if (params.has('userId') && params.has('secret')) {
        setMode('reset-password')
        setErrorMessage(null)
        setSuccessMessage(null)
        const paramEmail = params.get('email')
        if (paramEmail) setEmail(paramEmail)
      }
    }
  }, [])

  // Verification modal states
  const [showVerificationModal, setShowVerificationModal] = useState(false)
  const [verificationDebugCode, setVerificationDebugCode] = useState<string | undefined>()

  const handleSubmit = async (e: FormEvent) => {
    e.preventDefault()
    setErrorMessage(null)
    setSuccessMessage(null)
    setLoading(true)

    const trimmedEmail = email.trim()

    // 1. Forgot password mode: request recovery email
    if (mode === 'forgot-password') {
      if (!trimmedEmail || !trimmedEmail.includes('@')) {
        setErrorMessage('Veuillez fournir une adresse e-mail valide.')
        setLoading(false)
        return
      }

      try {
        await account.createRecovery(trimmedEmail, `${window.location.origin}/`)
        setSuccessMessage('Un e-mail de réinitialisation a été envoyé ! Consultez votre boîte de réception.')
      } catch (error: any) {
        setErrorMessage(error?.message || "Impossible d'envoyer l'e-mail de réinitialisation.")
      } finally {
        setLoading(false)
      }
      return
    }

    // 2. Reset password mode: update password with token from URL
    if (mode === 'reset-password') {
      if (!password || !confirmPassword) {
        setErrorMessage('Veuillez renseigner et confirmer le nouveau mot de passe.')
        setLoading(false)
        return
      }
      if (password !== confirmPassword) {
        setErrorMessage('Les mots de passe ne correspondent pas.')
        setLoading(false)
        return
      }
      if (password.length < 8) {
        setErrorMessage('Le mot de passe doit comporter au moins 8 caractères.')
        setLoading(false)
        return
      }

      try {
        const params = new URLSearchParams(window.location.search)
        const userId = params.get('userId')
        const secret = params.get('secret')
        if (!userId || !secret) {
          throw new Error('Jeton de réinitialisation manquant ou invalide.')
        }

        await account.updateRecovery(userId, secret, password)
        window.history.replaceState({}, document.title, window.location.pathname)
        setSuccessMessage('Votre mot de passe a été réinitialisé avec succès ! Vous pouvez maintenant vous connecter.')
        setMode('login')
        setPassword('')
        setConfirmPassword('')
      } catch (error: any) {
        setErrorMessage(error?.message || 'Erreur lors de la réinitialisation du mot de passe.')
      } finally {
        setLoading(false)
      }
      return
    }

    if (!trimmedEmail || !password) {
      setErrorMessage('Please provide both email and password.')
      setLoading(false)
      return
    }

    if (mode === 'signup') {
      if (!confirmPassword) {
        setErrorMessage('Please confirm your password.')
        setLoading(false)
        return
      }
      if (password !== confirmPassword) {
        setErrorMessage('Passwords do not match.')
        setLoading(false)
        return
      }
      if (password.length < 8) {
        setErrorMessage('Password must be at least 8 characters.')
        setLoading(false)
        return
      }
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

        if (ENABLE_EMAIL_VERIFICATION) {
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

        // Inscription directe (sans code) en attendant la validation DNS
        await account.create(ID.unique(), trimmedEmail, password, trimmedName)
        await account.createEmailPasswordSession(trimmedEmail, password)
      } else {
        // Mode login
        await account.createEmailPasswordSession(trimmedEmail, password)
      }

      const user = await account.get()
      saveStoredAppwriteSession({ id: user.$id, email: user.email, name: user.name })
      trackAnalyticsEvent({
        name: mode === 'signup' ? 'user_signup' : 'user_login',
        data: { method: 'email' },
      })
      if (typeof window !== 'undefined' && window.umami && user.email) {
        window.umami.identify({ email: user.email, userId: user.$id })
      }
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
                    setConfirmPassword('')
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
                {mode === 'forgot-password'
                  ? 'Mot de passe oublié'
                  : mode === 'reset-password'
                  ? 'Nouveau mot de passe'
                  : isLogin
                  ? 'Log in to your account'
                  : 'Create an account'}
              </h1>
              <p className="rv-login-subtitle">
                {mode === 'forgot-password'
                  ? 'Saisissez votre e-mail pour recevoir le lien de réinitialisation.'
                  : mode === 'reset-password'
                  ? 'Choisissez un nouveau mot de passe sécurisé (min. 8 caractères).'
                  : isLogin
                  ? 'Welcome back! Please enter your details.'
                  : 'Start your 30-day free trial.'}
              </p>
            </div>

            {/* Horizontal tabs */}
            {(mode === 'login' || mode === 'signup') && (
              <div className="rv-login-tabs" role="tablist">
                <button
                  type="button"
                  role="tab"
                  aria-selected={!isLogin}
                  className={`rv-login-tab-btn ${!isLogin ? 'rv-active' : ''}`}
                  onClick={() => {
                    setMode('signup')
                    setErrorMessage(null)
                    setSuccessMessage(null)
                    setConfirmPassword('')
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
                    setSuccessMessage(null)
                    setConfirmPassword('')
                  }}
                >
                  Log in
                </button>
              </div>
            )}
          </div>

          {/* Content Body */}
          <div className="rv-login-body">
            {/* Success Message banner (for reset-password, login, signup) */}
            {successMessage && mode !== 'forgot-password' && (
              <div
                style={{
                  padding: '12px 16px',
                  borderRadius: '10px',
                  background: 'rgba(34, 197, 94, 0.15)',
                  border: '1px solid rgba(34, 197, 94, 0.3)',
                  color: '#86efac',
                  fontSize: '14px',
                  lineHeight: '1.4',
                  textAlign: 'center',
                }}
              >
                {successMessage}
              </div>
            )}

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

            {/* If in forgot-password mode and email has been sent, show dedicated confirmation card */}
            {mode === 'forgot-password' && successMessage ? (
              <div className="rv-login-recovery-success" style={{ textAlign: 'center', padding: '16px 8px' }}>
                <div
                  style={{
                    width: '60px',
                    height: '60px',
                    borderRadius: '50%',
                    background: 'rgba(34, 197, 94, 0.15)',
                    border: '1px solid rgba(34, 197, 94, 0.3)',
                    display: 'flex',
                    alignItems: 'center',
                    justifyContent: 'center',
                    margin: '0 auto 16px',
                    color: '#4ade80',
                  }}
                >
                  <svg width="28" height="28" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                    <rect width="20" height="16" x="2" y="4" rx="2" />
                    <path d="m22 7-8.97 5.7a1.94 1.94 0 0 1-2.06 0L2 7" />
                  </svg>
                </div>
                <h2 style={{ fontSize: '18px', fontWeight: 600, color: '#ffffff', margin: '0 0 10px' }}>
                  E-mail de récupération envoyé
                </h2>
                <p style={{ fontSize: '14px', color: 'rgba(255, 255, 255, 0.7)', lineHeight: '1.5', margin: '0 0 24px' }}>
                  Un lien de réinitialisation sécurisé a été envoyé à <strong>{email.trim()}</strong>.<br />
                  Consultez votre boîte de réception ainsi que vos courriers indésirables (spams).
                </p>
                <button
                  type="button"
                  className="rv-login-submit-btn"
                  onClick={() => {
                    setMode('login')
                    setSuccessMessage(null)
                    setErrorMessage(null)
                  }}
                >
                  Retour à la connexion
                </button>
                <div style={{ marginTop: '16px' }}>
                  <button
                    type="button"
                    style={{
                      background: 'none',
                      border: 'none',
                      color: 'rgba(255, 255, 255, 0.5)',
                      fontSize: '13px',
                      cursor: 'pointer',
                      textDecoration: 'underline',
                    }}
                    onClick={() => {
                      setSuccessMessage(null)
                    }}
                  >
                    Renvoyer un autre e-mail
                  </button>
                </div>
              </div>
            ) : (
              /* Form */
              <form onSubmit={handleSubmit} className="rv-login-form">
              {/* Name Input Field (Sign up only) */}
              {mode === 'signup' && (
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

              {/* Email Input Field (all modes except reset-password) */}
              {mode !== 'reset-password' && (
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
              )}

              {/* Password Input Field (all modes except forgot-password) */}
              {mode !== 'forgot-password' && (
                <div className="rv-login-input-field">
                  <div className="rv-login-label-wrapper">
                    <label htmlFor="rv-password" className="rv-login-label">
                      {mode === 'reset-password' ? 'New password' : 'Password'}
                    </label>
                  </div>
                  <div className="rv-login-input-wrapper">
                    <input
                      id="rv-password"
                      type={showPassword ? 'text' : 'password'}
                      value={password}
                      onChange={(e) => setPassword(e.target.value)}
                      placeholder={mode === 'reset-password' ? '••••••••' : isLogin ? '••••••••' : 'Create a password'}
                      className="rv-login-input"
                      autoComplete={isLogin ? 'current-password' : 'new-password'}
                      required
                    />
                    <button
                      type="button"
                      className="rv-login-password-toggle"
                      onClick={() => setShowPassword((prev) => !prev)}
                      aria-label={showPassword ? 'Hide password' : 'Show password'}
                      title={showPassword ? 'Hide password' : 'Show password'}
                    >
                      {showPassword ? <EyeOffIcon /> : <EyeIcon />}
                    </button>
                  </div>
                  {mode !== 'login' && (
                    <span className="rv-login-hint-text">
                      Must be at least 8 characters.
                    </span>
                  )}
                </div>
              )}

              {/* Confirm Password Input Field (Sign up and Reset password only) */}
              {(mode === 'signup' || mode === 'reset-password') && (
                <div className="rv-login-input-field">
                  <div className="rv-login-label-wrapper">
                    <label htmlFor="rv-confirm-password" className="rv-login-label">
                      Confirm password
                    </label>
                  </div>
                  <div className="rv-login-input-wrapper">
                    <input
                      id="rv-confirm-password"
                      type={showConfirmPassword ? 'text' : 'password'}
                      value={confirmPassword}
                      onChange={(e) => setConfirmPassword(e.target.value)}
                      placeholder="Confirm your password"
                      className="rv-login-input"
                      autoComplete="new-password"
                      required
                    />
                    <button
                      type="button"
                      className="rv-login-password-toggle"
                      onClick={() => setShowConfirmPassword((prev) => !prev)}
                      aria-label={showConfirmPassword ? 'Hide password' : 'Show password'}
                      title={showConfirmPassword ? 'Hide password' : 'Show password'}
                    >
                      {showConfirmPassword ? <EyeOffIcon /> : <EyeIcon />}
                    </button>
                  </div>
                  {confirmPassword && password && confirmPassword !== password && (
                    <span className="rv-login-hint-error">
                      Passwords do not match.
                    </span>
                  )}
                </div>
              )}

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
                    onClick={() => {
                      setMode('forgot-password')
                      setErrorMessage(null)
                      setSuccessMessage(null)
                    }}
                  >
                    Forgot password
                  </button>
                </div>
              )}

              {/* Actions */}
              <div className="rv-login-actions">
                {/* Primary Button */}
                <button type="submit" className="rv-login-submit-btn" disabled={loading}>
                  {loading
                    ? 'Processing...'
                    : mode === 'forgot-password'
                    ? 'Envoyer le lien de réinitialisation'
                    : mode === 'reset-password'
                    ? 'Enregistrer le nouveau mot de passe'
                    : isLogin
                    ? 'Sign in'
                    : 'Get started'}
                </button>

                {/* Social Button: Google (only in login/signup) */}
                {(mode === 'login' || mode === 'signup') && (
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
                )}
              </div>
            </form>
            )}

            {/* Footer Action */}
            {mode === 'forgot-password' || mode === 'reset-password' ? (
              !(mode === 'forgot-password' && successMessage) && (
                <button
                  type="button"
                  className="rv-login-footer-action"
                  onClick={() => {
                    setMode('login')
                    setErrorMessage(null)
                    setSuccessMessage(null)
                  }}
                >
                  ← Back to log in
                </button>
              )
            ) : isLogin ? (
              <button
                type="button"
                className="rv-login-footer-action"
                onClick={() => {
                  // Fallback to dev login if needed
                  if (typeof window !== 'undefined') {
                    window.localStorage.setItem('redview:dev-session', 'true')
                  }
                  onLogin?.('dev@redview.tech')
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
                  setSuccessMessage(null)
                  setConfirmPassword('')
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
