import { useEffect, useRef } from 'react'

import { notify } from '@/shared/lib/notify'
import { account, clearStoredAppwriteSession } from '@/shared/services/appwrite'

import { confirmAccountEmail, requestAccountEmailCode } from '../lib/emailVerification'
import VerificationCodeModal from './VerificationCodeModal'

interface VerifyEmailScreenProps {
  /** Adresse prouvée : l'app s'ouvre. */
  onVerified: () => void
  /** Fermer = se déconnecter (on n'entre pas sans adresse vérifiée). */
  onSignedOut: () => void
}

/**
 * Compte connecté dont l'adresse n'est pas vérifiée (A15-2) : même pop-in de
 * code que l'inscription, envoyé à l'adresse du compte à l'ouverture.
 */
export default function VerifyEmailScreen({ onVerified, onSignedOut }: VerifyEmailScreenProps) {
  const requested = useRef(false)

  useEffect(() => {
    // Un seul envoi à l'ouverture (double montage StrictMode compris).
    if (requested.current) return
    requested.current = true
    void requestAccountEmailCode()
      .then(({ alreadyVerified }) => { if (alreadyVerified) onVerified() })
      .catch((error: unknown) => {
        // Rien n'est parti : la personne le sait, « Renvoyer le code » reste là.
        console.warn('[auth] verification code request failed', error)
        notify.error(error instanceof Error ? error.message : 'Impossible de vérifier l’adresse e-mail.')
      })
  }, [onVerified])

  const signOut = () => {
    void account.deleteSession('current').catch(() => undefined).finally(() => {
      clearStoredAppwriteSession()
      onSignedOut()
    })
  }

  return (
    <VerificationCodeModal
      isOpen
      onClose={signOut}
      onConfirm={async (code) => {
        try {
          await confirmAccountEmail(code)
          onVerified()
          return { success: true }
        } catch (error) {
          return { success: false, error: error instanceof Error ? error.message : undefined }
        }
      }}
      onResend={async () => {
        try {
          await requestAccountEmailCode()
          return { success: true }
        } catch (error) {
          return { success: false, error: error instanceof Error ? error.message : undefined }
        }
      }}
    />
  )
}
