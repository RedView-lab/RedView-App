import { useState, type FormEvent } from 'react'
import './LoginScreen.css'

interface LoginScreenProps {
  onLogin?: (email?: string) => void
  landingUrl?: string
}

type AuthMode = 'login' | 'signup'

export default function LoginScreen({ onLogin, landingUrl = 'http://localhost:3002' }: LoginScreenProps) {
  const [mode, setMode] = useState<AuthMode>('login')
  const [email, setEmail] = useState('')
  const [password, setPassword] = useState('')
  const [rememberMe, setRememberMe] = useState(false)

  const handleSubmit = (e: FormEvent) => {
    e.preventDefault()
    onLogin?.(email.trim())
  }

  const isLogin = mode === 'login'

  return (
    <div className="rv-login-page">
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
              onClick={() => setMode(isLogin ? 'signup' : 'login')}
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
                  : 'Start your 3D spatial journey today.'}
              </p>
            </div>

            {/* Horizontal tabs */}
            <div className="rv-login-tabs" role="tablist">
              <button
                type="button"
                role="tab"
                aria-selected={!isLogin}
                className={`rv-login-tab-btn ${!isLogin ? 'rv-active' : ''}`}
                onClick={() => setMode('signup')}
              >
                Sign up
              </button>
              <button
                type="button"
                role="tab"
                aria-selected={isLogin}
                className={`rv-login-tab-btn ${isLogin ? 'rv-active' : ''}`}
                onClick={() => setMode('login')}
              >
                Log in
              </button>
            </div>
          </div>

          {/* Content Body */}
          <div className="rv-login-body">
            {/* Form */}
            <form onSubmit={handleSubmit} className="rv-login-form">
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
                  placeholder="••••••••"
                  className="rv-login-input"
                  autoComplete={isLogin ? 'current-password' : 'new-password'}
                  required
                />
              </div>

              {/* Row: Checkbox & Forgot Password */}
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

                {isLogin && (
                  <button
                    type="button"
                    className="rv-login-forgot-btn"
                    onClick={() => alert('Password reset link will be sent to your email.')}
                  >
                    Forgot password
                  </button>
                )}
              </div>

              {/* Actions */}
              <div className="rv-login-actions">
                {/* Primary Button */}
                <button type="submit" className="rv-login-submit-btn">
                  {isLogin ? 'Sign in' : 'Create account'}
                </button>

                {/* Social Button: Google */}
                <div className="rv-login-social-group">
                  <button
                    type="button"
                    className="rv-login-social-btn"
                    onClick={() => onLogin?.('google-user@redview.app')}
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
                    Sign in with Google
                  </button>
                </div>
              </div>
            </form>

            {/* Footer Action */}
            <button
              type="button"
              className="rv-login-footer-action"
              onClick={() => onLogin?.(email || 'magic-link@redview.app')}
            >
              Continue with one-time e-mail
            </button>
          </div>
        </div>
      </main>
    </div>
  )
}
