/**
 * « Résilier votre contrat » (art. L.215-1-1 du Code de la consommation) :
 * accessible directement depuis l'onglet Abonnement, un récapitulatif qui
 * identifie le contrat et donne sa date de fin, puis la confirmation. Le
 * webhook Stripe envoie ensuite la confirmation par e-mail (support durable).
 *
 * Pop-in commune de l'application (`.rv-dialog`, shared/styles/dialog.css).
 */
import { useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';

import { IconClose } from '@/features/itineraryPanel/components/icons';
import { useAppI18n } from '@/shared/i18n';
import { appScaleStyle, readAppScale } from '@/shared/lib/appScale';
import { trapFocus } from '@/shared/lib/focusTrap';

import { formatLongDate, getDisplayPlan } from '../../lib';
import type { SubscriptionSnapshot } from '../../types';

type CancelSubscriptionDialogProps = {
  snapshot: SubscriptionSnapshot;
  accountEmail: string;
  anchorEl: HTMLElement | null;
  onConfirm: () => Promise<boolean>;
  onClose: () => void;
};

export function CancelSubscriptionDialog({ snapshot, accountEmail, anchorEl, onConfirm, onClose }: CancelSubscriptionDialogProps) {
  const { t } = useAppI18n();
  const [busy, setBusy] = useState(false);
  const closeRef = useRef<HTMLButtonElement>(null);
  const cardRef = useRef<HTMLDivElement>(null);
  const endDate = formatLongDate(snapshot.currentPeriodEnd);
  const planLabel = snapshot.planId ? t(getDisplayPlan(snapshot.planId).durationLabel) : '—';
  const trialing = snapshot.status === 'trialing';

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape' && !busy) onClose();
      // aria-modal : Tab ne sort pas vers l'onglet Abonnement masqué par le voile (C3-3).
      else if (event.key === 'Tab' && cardRef.current) trapFocus(event, cardRef.current);
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
    const done = await onConfirm();
    if (done) onClose();
    else setBusy(false);
  };

  return createPortal(
    <div className="rv-dialog" role="presentation" onMouseDown={() => !busy && onClose()}>
      <div
        ref={cardRef}
        className="rv-dialog__card rvpb-cancel-subscription"
        role="dialog"
        aria-modal="true"
        aria-labelledby="rvpb-cancel-subscription-title"
        style={appScaleStyle(readAppScale(anchorEl))}
        onMouseDown={(event) => event.stopPropagation()}
      >
        <header className="rv-dialog__header">
          <div className="rv-dialog__heading">
            <h2 id="rvpb-cancel-subscription-title" className="rv-dialog__title">{t('Résilier votre contrat')}</h2>
          </div>
          <button ref={closeRef} type="button" className="rv-dialog__close" aria-label={t('Fermer')} onClick={onClose} disabled={busy}>
            <IconClose size={16} />
          </button>
        </header>
        <div className="rv-dialog__body">
          <dl className="rvpb-cancel-subscription__recap">
            <dt>{t('Compte')}</dt>
            <dd>{accountEmail || '—'}</dd>
            <dt>{t('Formule')}</dt>
            <dd>{t('Abonnement RedView · {{plan}}', { plan: planLabel })}</dd>
            <dt>{t('Référence du contrat')}</dt>
            <dd className="rvpb-cancel-subscription__ref">{snapshot.subscriptionId ?? '—'}</dd>
            <dt>{t('Fin du contrat')}</dt>
            <dd>{endDate}</dd>
          </dl>
          <p className="rvpb-cancel-subscription__text">
            {trialing
              ? t('Votre essai prendra fin le {{date}} et aucun prélèvement ne sera effectué.', { date: endDate })
              : t('Votre abonnement prendra fin le {{date}}. Vous gardez l’accès jusqu’à cette date et ne serez plus prélevé.', { date: endDate })}
          </p>
          <p className="rvpb-cancel-subscription__text rvpb-cancel-subscription__text--muted">
            {t('Une confirmation vous sera envoyée par e-mail. Vous pourrez reprendre votre abonnement jusqu’à cette date.')}
          </p>
        </div>
        <footer className="rv-dialog__footer">
          <button type="button" className="rv-dialog__btn" onClick={onClose} disabled={busy}>
            {t('Garder mon abonnement')}
          </button>
          <button type="button" className="rv-dialog__btn rv-dialog__btn--primary" onClick={() => void confirm()} disabled={busy}>
            {busy ? t('Résiliation…') : t('Confirmer la résiliation')}
          </button>
        </footer>
      </div>
    </div>,
    document.body,
  );
}
