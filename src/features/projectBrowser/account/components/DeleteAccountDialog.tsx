/**
 * Suppression définitive du compte, en deux temps : on dit ce qui sera effacé
 * (avec l'export à portée de main) et on fait taper « SUPPRIMER », puis un
 * code envoyé à l'adresse du compte confirme. Le code prouve l'accès à la
 * boîte : une session restée ouverte ne suffit pas, et il marche aussi pour
 * les comptes Google sans mot de passe.
 *
 * Pop-in commune de l'application (`.rv-dialog`, shared/styles/dialog.css).
 */
import { useEffect, useRef, useState, type FormEvent } from 'react';
import { createPortal } from 'react-dom';

import { IconClose } from '@/features/itineraryPanel/components/icons';
import { useAppI18n } from '@/shared/i18n';
import { appScaleStyle, readAppScale } from '@/shared/lib/appScale';

import { clearLocalAccountData } from '../lib/profile';
import { confirmAccountDeletion, requestAccountDeletionCode } from '../lib/accountData';

import './DeleteAccountDialog.css';

type DeleteAccountDialogProps = {
  email: string;
  anchorEl: HTMLElement | null;
  exporting: boolean;
  onExport: () => void;
  onClose: () => void;
};

type Step = 'confirm' | 'code' | 'done';

const CONFIRM_WORD = 'SUPPRIMER';

export function DeleteAccountDialog({ email, anchorEl, exporting, onExport, onClose }: DeleteAccountDialogProps) {
  const { t } = useAppI18n();
  const [step, setStep] = useState<Step>('confirm');
  const [typed, setTyped] = useState('');
  const [code, setCode] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);
  const closeRef = useRef<HTMLButtonElement>(null);
  const confirmWord = t(CONFIRM_WORD);

  // Le compte supprimé, plus rien n'est fermable : la page repart sur l'écran de connexion.
  const closable = step !== 'done' && !busy;

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape' && closable) onClose();
    };
    document.addEventListener('keydown', onKeyDown);
    return () => document.removeEventListener('keydown', onKeyDown);
  }, [closable, onClose]);

  useEffect(() => {
    const handle = window.requestAnimationFrame(() => (inputRef.current ?? closeRef.current)?.focus());
    return () => window.cancelAnimationFrame(handle);
  }, [step]);

  useEffect(() => () => anchorEl?.focus(), [anchorEl]);

  const sendCode = async (event?: FormEvent) => {
    event?.preventDefault();
    if (busy || typed.trim().toUpperCase() !== confirmWord.toUpperCase()) return;
    setBusy(true);
    setError(null);
    try {
      await requestAccountDeletionCode();
      setStep('code');
    } catch (nextError) {
      setError(nextError instanceof Error ? nextError.message : t('La suppression du compte a échoué.'));
    } finally {
      setBusy(false);
    }
  };

  const confirmCode = async (event: FormEvent) => {
    event.preventDefault();
    if (busy || !/^\d{6}$/.test(code.trim())) return;
    setBusy(true);
    setError(null);
    try {
      const outcome = await confirmAccountDeletion(code);
      setPending(outcome === 'pending');
      setStep('done');
      await clearLocalAccountData();
      window.setTimeout(() => window.location.reload(), 4000);
    } catch (nextError) {
      setError(nextError instanceof Error ? nextError.message : t('La suppression du compte a échoué.'));
      setBusy(false);
    }
  };

  const scale = readAppScale(anchorEl);

  return createPortal(
    <div className="rv-dialog" role="presentation" onMouseDown={() => closable && onClose()}>
      <div
        className="rv-dialog__card rv-delete-account"
        role="dialog"
        aria-modal="true"
        aria-labelledby="rv-delete-account-title"
        style={appScaleStyle(scale)}
        onMouseDown={(event) => event.stopPropagation()}
      >
        <header className="rv-dialog__header">
          <div className="rv-dialog__heading">
            <h2 id="rv-delete-account-title" className="rv-dialog__title">
              {step === 'done' ? t('Compte supprimé') : t('Supprimer votre compte')}
            </h2>
            <p className="rv-dialog__subtitle">{email}</p>
          </div>
          {closable ? (
            <button ref={closeRef} type="button" className="rv-dialog__close" aria-label={t('Fermer')} onClick={onClose}>
              <IconClose size={16} />
            </button>
          ) : null}
        </header>

        {step === 'confirm' ? (
          <form className="rv-dialog__body" onSubmit={(event) => void sendCode(event)}>
            <section className="rv-dialog__section">
              <div className="rv-dialog__section-title">{t('Sera effacé définitivement')}</div>
              <ul className="rv-delete-account__list">
                <li>{t('Vos projets, avec leurs fichiers .fit et miniatures')}</li>
                <li>{t('Vos dossiers, vos réglages et vos profils de tracé')}</li>
                <li>{t('Vos partages : les projets que vous partagez sont supprimés pour tous leurs éditeurs')}</li>
                <li>{t('Votre abonnement, arrêté immédiatement et sans remboursement')}</li>
              </ul>
              <p className="rv-delete-account__note">
                {t('Vos commentaires et modifications dans les projets que d’autres vous ont partagés y restent. Les sauvegardes chiffrées du service sont effacées par rotation, au plus tard 12 mois après.')}
              </p>
            </section>
            <button type="button" className="rv-dialog__btn rv-delete-account__export" onClick={onExport} disabled={exporting}>
              {exporting ? t('Export en cours…') : t('Télécharger mes données d’abord')}
            </button>
            <label className="rv-dialog__section">
              <span className="rv-dialog__section-title">{t('Tapez {{word}} pour continuer', { word: confirmWord })}</span>
              <input
                ref={inputRef}
                className="rv-delete-account__input"
                value={typed}
                autoComplete="off"
                spellCheck={false}
                aria-label={t('Tapez {{word}} pour continuer', { word: confirmWord })}
                onChange={(event) => {
                  setTyped(event.target.value);
                  setError(null);
                }}
                disabled={busy}
              />
            </label>
            {error ? <div className="rv-delete-account__error" role="alert">{error}</div> : null}
            <footer className="rv-dialog__footer rv-delete-account__footer">
              <button type="button" className="rv-dialog__btn" onClick={onClose} disabled={busy}>
                {t('Annuler')}
              </button>
              <button
                type="submit"
                className="rv-dialog__btn rv-dialog__btn--primary"
                disabled={busy || typed.trim().toUpperCase() !== confirmWord.toUpperCase()}
              >
                {busy ? t('Envoi du code…') : t('Recevoir le code')}
              </button>
            </footer>
          </form>
        ) : null}

        {step === 'code' ? (
          <form className="rv-dialog__body" onSubmit={(event) => void confirmCode(event)}>
            <p className="rv-delete-account__note">
              {t('Un code à 6 chiffres vient d’être envoyé à {{email}}. Il expire dans 10 minutes.', { email })}
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
              <button type="button" className="rv-dialog__btn" onClick={() => void sendCode()} disabled={busy}>
                {t('Renvoyer le code')}
              </button>
              <button type="submit" className="rv-dialog__btn rv-dialog__btn--primary" disabled={busy || code.length !== 6}>
                {busy ? t('Suppression…') : t('Supprimer définitivement')}
              </button>
            </footer>
          </form>
        ) : null}

        {step === 'done' ? (
          <div className="rv-dialog__body rv-delete-account__done" role="status">
            <p className="rv-delete-account__note">
              {pending
                ? t('Votre compte est désactivé. La suppression de vos données se termine sur nos serveurs ; vous recevrez un e-mail de confirmation.')
                : t('Votre compte et vos données ont été supprimés. Un e-mail de confirmation vous a été envoyé.')}
            </p>
            <p className="rv-delete-account__note">{t('Merci d’avoir utilisé RedView.')}</p>
          </div>
        ) : null}
      </div>
    </div>,
    document.body,
  );
}
