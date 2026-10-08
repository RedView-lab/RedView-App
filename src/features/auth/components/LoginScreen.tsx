import { useState, useEffect, type FormEvent } from 'react'
import { trackAnalyticsEvent, trackScreen } from '@/shared/lib/analytics'
import { authFailureReason, rememberOAuthIntent } from '../lib/authAnalytics'
import { RedViewLogo } from '@/shared/components/RedViewLogo'
import { errorMessage as thrownMessage } from '@/shared/lib/errors'
import {
  account,
  AppwriteException,
  ID,
  OAuthProvider,
  saveStoredAppwriteSession,
} from '@/shared/services/appwrite'
import VerificationCodeModal from './VerificationCodeModal'
import {
  requestPasswordRecovery,
  resolveSignupName,
  sendVerificationCode,
  verifyCodeAndCreateAccount,
} from './login/authRequests'
import { GoogleIcon } from './login/icons'
import { PasswordField } from './login/PasswordField'
import { RecoveryEmailSent } from './login/RecoveryEmailSent'
import { useAuthUrlParams } from './login/useAuthUrlParams'
import './LoginScreen.css'

// Envoi du code de vérification à 6 chiffres par e-mail lors de l'inscription
const ENABLE_EMAIL_VERIFICATION = true

type AuthMode = 'login' | 'signup' | 'forgot-password' | 'reset-password'

interface LoginScreenProps {
  onLogin?: (email?: string) => void
  landingUrl?: string
}

export default function LoginScreen({ onLogin, landingUrl = 'https://redview.tech' }: LoginScreenProps) {
  const [mode, setMode] = useState<AuthMode>('login')
  const [name, setName] = useState('')
  const [email, setEmail] = useState('')
  const [password, setPassword] = useState('')
  const [confirmPassword, setConfirmPassword] = useState('')
  const [rememberMe, setRememberMe] = useState(false)
  const [loading, setLoading] = useState(false)
  const [errorMessage, setErrorMessage] = useState<string | null>(null)
  const [successMessage, setSuccessMessage] = useState<string | null>(null)

  // États des jetons de récupération gardés en mémoire (retirés de l'URL immédiatement)
  const [recoveryUserId, setRecoveryUserId] = useState<string | null>(null)
  const [recoverySecret, setRecoverySecret] = useState<string | null>(null)
  const [resendCooldown, setResendCooldown] = useState(0)

  useAuthUrlParams({
    onRecoveryLink: ({ userId, secret, email: linkEmail }) => {
      setRecoveryUserId(userId)
      setRecoverySecret(secret)
      setMode('reset-password')
      setErrorMessage(null)
      setSuccessMessage(null)
      if (linkEmail) setEmail(linkEmail)
    },
    onUrlError: setErrorMessage,
  })

  // Minuteur de délai du bouton de renvoi de récupération
  useEffect(() => {
    if (resendCooldown <= 0) return
    const timer = setInterval(() => {
      setResendCooldown((prev) => (prev > 0 ? prev - 1 : 0))
    }, 1000)
    return () => clearInterval(timer)
  }, [resendCooldown])

  // États de la fenêtre de vérification
  const [showVerificationModal, setShowVerificationModal] = useState(false)

  // Page vue virtuelle de l'écran affiché (mesure d'audience).
  useEffect(() => {
    trackScreen(mode === 'signup' ? 'signup' : mode === 'login' ? 'login' : 'reset_password')
  }, [mode])

  const handleSubmit = async (e: FormEvent) => {
    e.preventDefault()
    setErrorMessage(null)
    setSuccessMessage(null)
    setLoading(true)

    const trimmedEmail = email.trim()

    // 1. Mode mot de passe oublié : demande l'e-mail de récupération via un point d'accès serveur sécurisé (anti-énumération)
    if (mode === 'forgot-password') {
      if (!trimmedEmail || !trimmedEmail.includes('@')) {
        setErrorMessage('Veuillez fournir une adresse e-mail valide.')
        setLoading(false)
        return
      }

      try {
        const { ok, status, data } = await requestPasswordRecovery(trimmedEmail)

        if (!ok && status !== 200) {
          setErrorMessage(data?.error || "Impossible d'envoyer l'e-mail de réinitialisation.")
          setLoading(false)
          return
        }

        trackAnalyticsEvent({ name: 'password_reset_requested' })
        // Message de confirmation générique (anti-énumération)
        setSuccessMessage(
          data?.message ||
            'Si un compte est associé à cette adresse e-mail, un lien de réinitialisation vous a été envoyé.'
        )
        setResendCooldown(60)
      } catch {
        // Anti-énumération défensive : on affiche toujours la carte de confirmation
        setSuccessMessage(
          'Si un compte est associé à cette adresse e-mail, un lien de réinitialisation vous a été envoyé.'
        )
        setResendCooldown(60)
      } finally {
        setLoading(false)
      }
      return
    }

    // 2. Mode réinitialisation : met à jour le mot de passe avec le jeton en mémoire ou dans l'URL
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

      const userId = recoveryUserId || new URLSearchParams(window.location.search).get('userId')
      const secret = recoverySecret || new URLSearchParams(window.location.search).get('secret')

      if (!userId || !secret) {
        setErrorMessage('Ce lien de réinitialisation est incomplet ou invalide. Veuillez refaire une demande.')
        setLoading(false)
        return
      }

      try {
        await account.updateRecovery(userId, secret, password)
        trackAnalyticsEvent({ name: 'password_reset_completed' })
        setSuccessMessage('Votre mot de passe a été réinitialisé avec succès ! Vous pouvez maintenant vous connecter.')
        setMode('login')
        setPassword('')
        setConfirmPassword('')
        setRecoveryUserId(null)
        setRecoverySecret(null)
      } catch (error) {
        trackAnalyticsEvent({ name: 'auth_failed', data: { method: 'email', step: 'reset', reason: authFailureReason(error) } })
        if (
          (error instanceof AppwriteException && (error.type === 'user_invalid_token' || error.code === 401)) ||
          /token|invalid credential/i.test(thrownMessage(error, ''))
        ) {
          setErrorMessage('Ce lien de réinitialisation a expiré ou est invalide. Veuillez refaire une demande.')
        } else {
          setErrorMessage(thrownMessage(error, 'Erreur lors de la réinitialisation du mot de passe.'))
        }
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
      if (password.length > 256) {
        setErrorMessage('Password must be at most 256 characters.')
        setLoading(false)
        return
      }
    }

    try {
      // Au cas où une ancienne session serait encore active
      try {
        await account.deleteSession('current')
      } catch {
        // Ignoré s'il n'y a pas de session active
      }

      if (mode === 'signup') {
        const trimmedName = resolveSignupName(name, trimmedEmail)

        if (ENABLE_EMAIL_VERIFICATION) {
          // Call API to send 6-digit verification code via Resend.
          // Anti-énumération : l'API répond 200 avec le même message que
          // l'adresse soit libre ou déjà associée à un compte (dans ce cas
          // l'utilisateur reçoit un e-mail « compte existant » au lieu du
          // code). Seules les erreurs de validation (400), de quota (429) ou
          // serveur (5xx) arrivent ici en !res.ok.
          const { ok, data } = await sendVerificationCode(trimmedEmail, trimmedName)

          if (!ok) {
            trackAnalyticsEvent({ name: 'auth_failed', data: { method: 'email', step: 'signup', reason: 'other' } })
            setErrorMessage(data.error || "Impossible d'envoyer le code de vérification.")
            setLoading(false)
            return
          }

          setShowVerificationModal(true)
          setLoading(false)
          return
        }

        // Inscription directe (sans code) en attendant la validation DNS
        await account.create(ID.unique(), trimmedEmail, password, trimmedName)
        await account.createEmailPasswordSession(trimmedEmail, password)
      } else {
        // Mode connexion
        await account.createEmailPasswordSession(trimmedEmail, password)
      }

      const user = await account.get()
      saveStoredAppwriteSession({ id: user.$id, email: user.email, name: user.name })
      trackAnalyticsEvent({
        name: mode === 'signup' ? 'signup_completed' : 'login_completed',
        data: { method: 'email' },
      })
      onLogin?.(user.email)
    } catch (error) {
      console.warn('[auth] Appwrite action error:', error)
      trackAnalyticsEvent({
        name: 'auth_failed',
        data: { method: 'email', step: mode === 'signup' ? 'signup' : 'login', reason: authFailureReason(error) },
      })
      setErrorMessage(thrownMessage(error, 'Authentication failed. Please check your credentials.'))
    } finally {
      setLoading(false)
    }
  }

  const handleConfirmVerification = async (code: string): Promise<{ success: boolean; error?: string }> => {
    const trimmedEmail = email.trim()

    try {
      const { ok, data } = await verifyCodeAndCreateAccount(trimmedEmail, code, resolveSignupName(name, trimmedEmail), password)
      if (!ok) {
        trackAnalyticsEvent({ name: 'auth_failed', data: { method: 'email', step: 'verification', reason: 'code' } })
        return { success: false, error: data.error || 'Code invalide.' }
      }

      // Compte créé avec e-mail vérifié -> ouvre la session
      await account.createEmailPasswordSession(trimmedEmail, password)
      const user = await account.get()
      saveStoredAppwriteSession({ id: user.$id, email: user.email, name: user.name })
      trackAnalyticsEvent({ name: 'signup_completed', data: { method: 'email' } })

      setShowVerificationModal(false)
      onLogin?.(user.email)
      return { success: true }
    } catch (err) {
      return { success: false, error: thrownMessage(err, 'Erreur lors de la confirmation du compte.') }
    }
  }

  const handleResendVerification = async (): Promise<{ success: boolean; error?: string }> => {
    const trimmedEmail = email.trim()

    try {
      const { ok, data } = await sendVerificationCode(trimmedEmail, resolveSignupName(name, trimmedEmail))
      if (!ok) {
        return { success: false, error: data.error || 'Impossible de renvoyer le code.' }
      }
      return { success: true }
    } catch (err) {
      return { success: false, error: thrownMessage(err, 'Erreur lors du renvoi du code.') }
    }
  }

  const handleGoogleAuth = () => {
    setErrorMessage(null)
    setLoading(true)
    // Issue (inscription ou connexion) décidée au retour d'OAuth : authAnalytics.ts.
    rememberOAuthIntent('google')
    try {
      account.createOAuth2Session(
        OAuthProvider.Google,
        window.location.origin,
        window.location.origin,
      )
    } catch (error) {
      trackAnalyticsEvent({ name: 'auth_failed', data: { method: 'google', step: mode === 'signup' ? 'signup' : 'login', reason: authFailureReason(error) } })
      setLoading(false)
      setErrorMessage(thrownMessage(error, 'Failed to initiate Google OAuth.'))
    }
  }

  const isLogin = mode === 'login'

  return (
    <div className="rv-login-page">
      {!showVerificationModal && (
        <>
          {/* Navigation d'en-tête */}
          <header className="rv-login-header-nav">
            <div className="rv-login-header-container">
              {/* Frame 36468 — logo */}
              <a href={landingUrl} className="rv-login-logo-link" aria-label="RedView">
                <RedViewLogo className="rv-login-logo-img" />
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
            {/* Texte et texte d'accompagnement */}
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

            {/* Onglets horizontaux */}
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

          {/* Corps du contenu */}
          <div className="rv-login-body">
            {/* Bandeau de message de succès (réinitialisation, connexion, inscription) */}
            {successMessage && mode !== 'forgot-password' && (
              <div
                style={{
                  padding: '12px 16px',
                  borderRadius: '10px',
                  background: 'rgba(34, 197, 94, 0.15)',
                  border: '1px solid rgba(34, 197, 94, 0.3)',
                  color: '#86efac',
                  fontSize: 'var(--rv-font-size-lg)',
                  lineHeight: '1.4',
                  textAlign: 'center',
                }}
              >
                {successMessage}
              </div>
            )}

            {/* Bandeau de message d'erreur */}
            {errorMessage && (
              <div
                style={{
                  padding: '12px 16px',
                  borderRadius: '10px',
                  background: 'rgba(239, 68, 68, 0.15)',
                  border: '1px solid rgba(239, 68, 68, 0.3)',
                  color: '#fca5a5',
                  fontSize: 'var(--rv-font-size-lg)',
                  lineHeight: '1.4',
                  textAlign: 'center',
                }}
              >
                {errorMessage}
              </div>
            )}

            {/* En mode mot de passe oublié, une fois l'e-mail envoyé, affiche une carte de confirmation dédiée */}
            {mode === 'forgot-password' && successMessage ? (
              <RecoveryEmailSent
                email={email.trim()}
                resendCooldown={resendCooldown}
                onBackToLogin={() => {
                  setMode('login')
                  setSuccessMessage(null)
                  setErrorMessage(null)
                }}
                onSendAnother={() => setSuccessMessage(null)}
              />
            ) : (
              /* Form */
              <form onSubmit={handleSubmit} className="rv-login-form">
              {/* Champ nom (inscription seulement) */}
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
                    maxLength={100}
                    required
                  />
                </div>
              )}

              {/* Champ e-mail (tous les modes sauf réinitialisation) */}
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
                    maxLength={254}
                    required
                  />
                </div>
              )}

              {/* Champ mot de passe (tous les modes sauf mot de passe oublié) */}
              {mode !== 'forgot-password' && (
                <PasswordField
                  id="rv-password"
                  label={mode === 'reset-password' ? 'New password' : 'Password'}
                  value={password}
                  onChange={setPassword}
                  placeholder={mode === 'reset-password' ? '••••••••' : isLogin ? '••••••••' : 'Create a password'}
                  autoComplete={isLogin ? 'current-password' : 'new-password'}
                  hint={mode !== 'login' ? { text: 'Must be at least 8 characters.' } : null}
                />
              )}

              {/* Champ de confirmation du mot de passe (inscription et réinitialisation seulement) */}
              {(mode === 'signup' || mode === 'reset-password') && (
                <PasswordField
                  id="rv-confirm-password"
                  label="Confirm password"
                  value={confirmPassword}
                  onChange={setConfirmPassword}
                  placeholder="Confirm your password"
                  autoComplete="new-password"
                  hint={
                    confirmPassword && password && confirmPassword !== password
                      ? { text: 'Passwords do not match.', error: true }
                      : null
                  }
                />
              )}

              {/* Ligne : case à cocher et mot de passe oublié (connexion seulement) */}
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
                {/* Bouton principal */}
                <button type="submit" className="rv-login-submit-btn" disabled={loading}>
                  {loading
                    ? 'Processing...'
                    : mode === 'forgot-password'
                    ? 'Envoyer le lien de réinitialisation'
                    : mode === 'reset-password'
                    ? 'Enregistrer le nouveau mot de passe'
                    : isLogin
                    ? 'Log in'
                    : 'Get started'}
                </button>

                {/* Bouton social : Google (connexion / inscription seulement) */}
                {(mode === 'login' || mode === 'signup') && (
                  <div className="rv-login-social-group">
                    <button
                      type="button"
                      className="rv-login-social-btn"
                      onClick={handleGoogleAuth}
                      disabled={loading}
                    >
                      <span className="rv-login-social-icon">
                        <GoogleIcon />
                      </span>
                      {isLogin ? 'Sign in with Google' : 'Sign up with Google'}
                    </button>
                  </div>
                )}
              </div>
            </form>
            )}

            {/* Action de pied de page */}
            {mode === 'forgot-password' || mode === 'reset-password' ? (
              !(mode === 'forgot-password' && successMessage) && (
                <button
                  type="button"
                  className="rv-login-footer-action"
                  onClick={() => {
                    setMode('login')
                    setErrorMessage(null)
                    setSuccessMessage(null)
                    if (typeof window !== 'undefined' && window.location.search) {
                      window.history.replaceState({}, document.title, window.location.pathname)
                    }
                  }}
                >
                  ← Back to log in
                </button>
              )
            ) : isLogin ? (
              // Compte démo local réservé au développement : `import.meta.env.DEV`
              // vaut `false` en build, la branche (et son libellé) est éliminée du bundle.
              import.meta.env.DEV ? (
                <button
                  type="button"
                  className="rv-login-footer-action"
                  onClick={() => onLogin?.('dev@redview.tech')}
                >
                  Continue with Demo account
                </button>
              ) : null
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

      {/* Fenêtre de vérification de l'e-mail à 6 chiffres */}
      <VerificationCodeModal
        isOpen={showVerificationModal}
        onClose={() => setShowVerificationModal(false)}
        onConfirm={handleConfirmVerification}
        onResend={handleResendVerification}
      />
    </div>
  )
}
