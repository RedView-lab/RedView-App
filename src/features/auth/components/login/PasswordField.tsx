import { useState } from 'react'
import { EyeIcon, EyeOffIcon } from './icons'

interface PasswordFieldProps {
  id: string
  label: string
  value: string
  onChange: (value: string) => void
  placeholder: string
  autoComplete: string
  /** Aide ou erreur affichée sous le champ. */
  hint?: { text: string; error?: boolean } | null
}

/** Champ mot de passe avec bouton afficher / masquer. */
export function PasswordField({ id, label, value, onChange, placeholder, autoComplete, hint }: PasswordFieldProps) {
  const [visible, setVisible] = useState(false)
  return (
    <div className="rv-login-input-field">
      <div className="rv-login-label-wrapper">
        <label htmlFor={id} className="rv-login-label">
          {label}
        </label>
      </div>
      <div className="rv-login-input-wrapper">
        <input
          id={id}
          type={visible ? 'text' : 'password'}
          value={value}
          onChange={(e) => onChange(e.target.value)}
          placeholder={placeholder}
          className="rv-login-input"
          autoComplete={autoComplete}
          required
        />
        <button
          type="button"
          className="rv-login-password-toggle"
          onClick={() => setVisible((prev) => !prev)}
          aria-label={visible ? 'Hide password' : 'Show password'}
          title={visible ? 'Hide password' : 'Show password'}
        >
          {visible ? <EyeOffIcon /> : <EyeIcon />}
        </button>
      </div>
      {hint ? (
        <span className={hint.error ? 'rv-login-hint-error' : 'rv-login-hint-text'}>
          {hint.text}
        </span>
      ) : null}
    </div>
  )
}
