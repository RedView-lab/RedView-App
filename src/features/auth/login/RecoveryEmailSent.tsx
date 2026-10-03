import { useAppI18n } from '@/shared/i18n'
import { MailIcon } from './icons'

interface RecoveryEmailSentProps {
  email: string
  /** Secondes avant de pouvoir redemander un e-mail (0 = possible). */
  resendCooldown: number
  onBackToLogin: () => void
  onSendAnother: () => void
}

/** Confirmation « e-mail de récupération envoyé » (mot de passe oublié). */
export function RecoveryEmailSent({ email, resendCooldown, onBackToLogin, onSendAnother }: RecoveryEmailSentProps) {
  const { t } = useAppI18n()
  return (
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
        <MailIcon />
      </div>
      <h2 style={{ fontSize: 'var(--rv-font-size-2xl)', fontWeight: 600, color: '#ffffff', margin: '0 0 10px' }}>
        E-mail de récupération envoyé
      </h2>
      <p style={{ fontSize: 'var(--rv-font-size-lg)', color: 'rgba(255, 255, 255, 0.7)', lineHeight: '1.5', margin: '0 0 24px' }}>
        Un lien de réinitialisation sécurisé a été envoyé à <strong>{email}</strong>.<br />
        Consultez votre boîte de réception ainsi que vos courriers indésirables (spams).
      </p>
      <button
        type="button"
        className="rv-login-submit-btn"
        onClick={onBackToLogin}
      >
        Retour à la connexion
      </button>
      <div style={{ marginTop: '16px' }}>
        <button
          type="button"
          disabled={resendCooldown > 0}
          style={{
            background: 'none',
            border: 'none',
            color: resendCooldown > 0 ? 'rgba(255, 255, 255, 0.35)' : 'rgba(255, 255, 255, 0.5)',
            fontSize: 'var(--rv-font-size-md)',
            cursor: resendCooldown > 0 ? 'not-allowed' : 'pointer',
            textDecoration: resendCooldown > 0 ? 'none' : 'underline',
          }}
          onClick={() => {
            if (resendCooldown <= 0) onSendAnother()
          }}
        >
          {resendCooldown > 0 ? t('Renvoyer un autre e-mail ({{seconds}}s)', { seconds: resendCooldown }) : 'Renvoyer un autre e-mail'}
        </button>
      </div>
    </div>
  )
}
