/**
 * Retrait du consentement aux données de santé des fichiers .fit : plus aucun
 * .fit ne peut être ajouté, et, au choix, les fichiers déjà envoyés sont
 * effacés (ceux dont le compte est propriétaire, y compris les orphelins).
 *
 * Pop-in commune de l'application (`.rv-dialog`, shared/styles/dialog.css).
 */
import { useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';

import { IconClose } from '@/features/itineraryPanel/components/icons';
import { useAppI18n } from '@/shared/i18n';
import { appScaleStyle, readAppScale } from '@/shared/lib/appScale';
import { notify } from '@/shared/lib/notify';
import { withdrawHealthDataConsent } from '@/shared/services/healthDataConsent';
import { deleteOwnedFitFiles } from '@/shared/services/projects';

import './WithdrawHealthConsentDialog.css';

type WithdrawHealthConsentDialogProps = {
  anchorEl: HTMLElement | null;
  onClose: () => void;
  onWithdrawn: () => void;
};

export function WithdrawHealthConsentDialog({ anchorEl, onClose, onWithdrawn }: WithdrawHealthConsentDialogProps) {
  const { t } = useAppI18n();
  const [deleteFiles, setDeleteFiles] = useState(true);
  const [busy, setBusy] = useState(false);
  const closeRef = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape' && !busy) onClose();
    };
    document.addEventListener('keydown', onKeyDown);
    return () => document.removeEventListener('keydown', onKeyDown);
  }, [busy, onClose]);

  useEffect(() => {
    const handle = window.requestAnimationFrame(() => closeRef.current?.focus());
    return () => window.cancelAnimationFrame(handle);
  }, []);

  useEffect(() => () => anchorEl?.focus(), [anchorEl]);

  const confirm = async () => {
    if (busy) return;
    setBusy(true);
    try {
      await withdrawHealthDataConsent();
    } catch (error) {
      console.warn('[account] health consent withdrawal failed', error);
      notify.error('Le retrait de votre accord n’a pas pu être enregistré. Vérifiez votre connexion et réessayez.');
      setBusy(false);
      return;
    }
    if (deleteFiles) {
      try {
        const { deleted, failed } = await deleteOwnedFitFiles();
        if (failed > 0) {
          notify.error('Accord retiré. {{failed}} fichier(s) .fit n’ont pas pu être effacés : réessayez plus tard.', { failed });
        } else {
          notify.success('Accord retiré et {{count}} fichier(s) .fit effacé(s).', { count: deleted });
        }
      } catch (error) {
        console.warn('[account] owned FIT files deletion failed', error);
        notify.error('Accord retiré, mais vos fichiers .fit n’ont pas pu être effacés. Réessayez plus tard.');
      }
    } else {
      notify.success('Accord retiré : vous ne pourrez plus ajouter de fichiers .fit.');
    }
    onWithdrawn();
    onClose();
  };

  return createPortal(
    <div className="rv-dialog" role="presentation" onMouseDown={() => !busy && onClose()}>
      <div
        className="rv-dialog__card rv-health-withdraw"
        role="dialog"
        aria-modal="true"
        aria-labelledby="rv-health-withdraw-title"
        style={appScaleStyle(readAppScale(anchorEl))}
        onMouseDown={(event) => event.stopPropagation()}
      >
        <header className="rv-dialog__header">
          <div className="rv-dialog__heading">
            <h2 id="rv-health-withdraw-title" className="rv-dialog__title">{t('Retirer votre accord')}</h2>
          </div>
          <button ref={closeRef} type="button" className="rv-dialog__close" aria-label={t('Fermer')} onClick={onClose} disabled={busy}>
            <IconClose size={16} />
          </button>
        </header>
        <div className="rv-dialog__body">
          <p className="rv-health-withdraw__text">
            {t('Vous ne pourrez plus ajouter de fichiers .fit. La prédiction reste disponible avec vos réglages de rythme.')}
          </p>
          <label className="rv-health-withdraw__option">
            <input type="checkbox" checked={deleteFiles} onChange={(event) => setDeleteFiles(event.target.checked)} disabled={busy} />
            <span>{t('Effacer aussi tous les fichiers .fit que j’ai déjà envoyés')}</span>
          </label>
        </div>
        <footer className="rv-dialog__footer">
          <button type="button" className="rv-dialog__btn" onClick={onClose} disabled={busy}>
            {t('Annuler')}
          </button>
          <button type="button" className="rv-dialog__btn rv-dialog__btn--primary" onClick={() => void confirm()} disabled={busy}>
            {busy ? t('Retrait…') : t('Retirer mon accord')}
          </button>
        </footer>
      </div>
    </div>,
    document.body,
  );
}
