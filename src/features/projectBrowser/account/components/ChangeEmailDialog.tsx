/**
 * Changement de l'adresse e-mail du compte, en deux temps : la nouvelle
 * adresse et le mot de passe actuel, puis le code reçu à la nouvelle adresse
 * (api/auth/change-email.ts). Le mot de passe empêche une session restée
 * ouverte de prendre le compte ; le code prouve que la nouvelle boîte est la
 * sienne, donc l'adresse reste vérifiée.
 *
 * Pop-in commune de l'application (`.rv-dialog`, shared/styles/dialog.css) ;
 * champ, note et erreur reprennent ceux de la suppression du compte.
 */
import { useEffect, useRef, useState, type FormEvent } from 'react';
import { createPortal } from 'react-dom';

import { IconClose } from '@/features/itineraryPanel/components/icons';
import { useAppI18n } from '@/shared/i18n';
import { appScaleStyle, readAppScale } from '@/shared/lib/appScale';

import { confirmEmailChange, requestEmailChangeCode } from '../lib/emailChange';

import './DeleteAccountDialog.css';

type ChangeEmailDialogProps = {
  currentEmail: string;
  anchorEl: HTMLElement | null;
  onChanged: (email: string) => void;
  onClose: () => void;
};

type Step = 'address' | 'code';

const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

export function ChangeEmailDialog({ currentEmail, anchorEl, onChanged, onClose }: ChangeEmailDialogProps) {
  const { t } = useAppI18n();
  const [step, setStep] = useState<Step>('address');
  const [newEmail, setNewEmail] = useState('');
  const [password, setPassword] = useState('');
  const [code, setCode] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  const addressReady = EMAIL_PATTERN.test(newEmail.trim()) && password.length >= 8;

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape' && !busy) onClose();
    };
    document.addEventListener('keydown', onKeyDown);
    return () => document.removeEventListener('keydown', onKeyDown);
  }, [busy, onClose]);

  useEffect(() => {
    const handle = window.requestAnimationFrame(() => inputRef.current?.focus());
    return () => window.cancelAnimationFrame(handle);
  }, [step]);

  useEffect(() => () => anchorEl?.focus(), [anchorEl]);

  const sendCode = async (event?: FormEvent) => {
    event?.preventDefault();
    if (busy || !addressReady) return;
    setBusy(true);
    setError(null);
    try {
      await requestEmailChangeCode(newEmail);
      setCode('');
      setStep('code');
    } catch (nextError) {
      setError(nextError instanceof Error ? nextError.message : t('Impossible de changer l’adresse e-mail.'));
    } finally {
      setBusy(false);
    }
  };

  const confirmCode = async (event: FormEvent) => {
    event.preventDefault();
    if (busy || !/^\d{6}$/.test(code)) return;
    setBusy(true);
    setError(null);
    try {
      const email = await confirmEmailChange(newEmail, code, password);
      onChanged(email);
    } catch (nextError) {
      setError(nextError instanceof Error ? nextError.message : t('Impossible de changer l’adresse e-mail.'));
      setBusy(false);
    }
  };

  const scale = readAppScale(anchorEl);

  return createPortal(
    <div className="rv-dialog" role="presentation" onMouseDown={() => !busy && onClose()}>
      <div
        className="rv-dialog__card rv-delete-account"
        role="dialog"
        aria-modal="true"
        aria-labelledby="rv-change-email-title"
        style={appScaleStyle(scale)}
        onMouseDown={(event) => event.stopPropagation()}
      >
        <header className="rv-dialog__header">
          <div className="rv-dialog__heading">
            <h2 id="rv-change-email-title" className="rv-dialog__title">{t('Changer d’adresse e-mail')}</h2>
            <p className="rv-dialog__subtitle">{currentEmail}</p>
          </div>
          <button type="button" className="rv-dialog__close" aria-label={t('Fermer')} onClick={onClose} disabled={busy}>
            <IconClose size={16} />
          </button>
        </header>

        {step === 'address' ? (
          <form className="rv-dialog__body" onSubmit={(event) => void sendCode(event)}>
            <label className="rv-dialog__section">
              <span className="rv-dialog__section-title">{t('Nouvelle adresse e-mail')}</span>
              <input
                ref={inputRef}
                className="rv-delete-account__input"
                type="email"
                autoComplete="email"
                value={newEmail}
                onChange={(event) => {
                  setNewEmail(event.target.value);
                  setError(null);
                }}
                disabled={busy}
              />
            </label>
            <label className="rv-dialog__section">
              <span className="rv-dialog__section-title">{t('Mot de passe actuel')}</span>
              <input
                className="rv-delete-account__input"
                type="password"
                autoComplete="current-password"
                value={password}
                onChange={(event) => {
                  setPassword(event.target.value);
                  setError(null);
                }}
                disabled={busy}
              />
            </label>
            <p className="rv-delete-account__note">
              {t('Un code de confirmation sera envoyé à la nouvelle adresse. Votre adresse actuelle sera prévenue du changement.')}
            </p>
            {error ? <div className="rv-delete-account__error" role="alert">{error}</div> : null}
            <footer className="rv-dialog__footer rv-delete-account__footer">
              <button type="button" className="rv-dialog__btn" onClick={onClose} disabled={busy}>
                {t('Annuler')}
              </button>
              <button type="submit" className="rv-dialog__btn rv-dialog__btn--primary" disabled={busy || !addressReady}>
                {busy ? t('Envoi du code…') : t('Recevoir le code')}
              </button>
            </footer>
          </form>
        ) : (
          <form className="rv-dialog__body" onSubmit={(event) => void confirmCode(event)}>
            <p className="rv-delete-account__note">
              {t('Un code à 6 chiffres vient d’être envoyé à {{email}}. Il expire dans 10 minutes.', { email: newEmail.trim() })}
            </p>
            <input
              ref={inputRef}
              className="rv-delete-account__input rv-delete-account__code"
              value={code}
              inputMode="numeric"
              autoComplete="one-time-code"
              maxLength={6}
              placeholder="000000"
              aria-label={t('Code reçu par e-mail')}
              onChange={(event) => {
                setCode(event.target.value.replace(/\D/g, '').slice(0, 6));
                setError(null);
              }}
              disabled={busy}
            />
            {error ? <div className="rv-delete-account__error" role="alert">{error}</div> : null}
            <footer className="rv-dialog__footer rv-delete-account__footer">
              <button type="button" className="rv-dialog__btn" onClick={() => setStep('address')} disabled={busy}>
                {t('Modifier l’adresse')}
              </button>
              <button type="submit" className="rv-dialog__btn rv-dialog__btn--primary" disabled={busy || code.length !== 6}>
                {busy ? t('Vérification…') : t('Changer l’adresse')}
              </button>
            </footer>
          </form>
        )}
      </div>
    </div>,
    document.body,
  );
}
