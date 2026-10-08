/**
 * Pop-in de consentement aux données de santé des fichiers .fit (RGPD art. 9
 * § 2 a), montée une fois dans App. Elle s'ouvre quand un point d'entrée appelle
 * `ensureHealthDataConsent()` et répond par « J'accepte » ou « Refuser »
 * (fermer ou Échap = refuser). Texte versionné : le modifier impose
 * d'augmenter HEALTH_DATA_CONSENT_VERSION (shared/lib/healthDataConsent.ts).
 *
 * Pop-in commune de l'application (`.rv-dialog`, shared/styles/dialog.css).
 */
import { useEffect, useRef, useSyncExternalStore } from 'react';
import { createPortal } from 'react-dom';

import { useAppI18n } from '@/shared/i18n';
import { appScaleStyle, readAppScale } from '@/shared/lib/appScale';
import {
  answerHealthDataConsentRequest,
  isHealthDataConsentRequested,
  subscribeHealthDataConsentRequest,
} from '@/shared/services/healthDataConsent';

import './HealthDataConsentHost.css';

export function HealthDataConsentHost() {
  const open = useSyncExternalStore(subscribeHealthDataConsentRequest, isHealthDataConsentRequested, () => false);
  return open ? <HealthDataConsentDialog /> : null;
}

function HealthDataConsentDialog() {
  const { t } = useAppI18n();
  const refuseRef = useRef<HTMLButtonElement>(null);
  // Même densité que l'élément qui a demandé l'accord (canevas mis à l'échelle).
  const scale = readAppScale(document.activeElement ?? document.querySelector('[style*="--app-scale"]'));

  useEffect(() => {
    const previous = document.activeElement as HTMLElement | null;
    const handle = window.requestAnimationFrame(() => refuseRef.current?.focus());
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        event.preventDefault();
        answerHealthDataConsentRequest(false);
      }
    };
    document.addEventListener('keydown', onKeyDown);
    return () => {
      window.cancelAnimationFrame(handle);
      document.removeEventListener('keydown', onKeyDown);
      previous?.focus?.();
    };
  }, []);

  return createPortal(
    <div className="rv-dialog" role="presentation" onMouseDown={() => answerHealthDataConsentRequest(false)}>
      <div
        className="rv-dialog__card rv-health-consent"
        role="dialog"
        aria-modal="true"
        aria-labelledby="rv-health-consent-title"
        aria-describedby="rv-health-consent-intro"
        style={appScaleStyle(scale)}
        onMouseDown={(event) => event.stopPropagation()}
      >
        <header className="rv-dialog__header">
          <div className="rv-dialog__heading">
            <h2 id="rv-health-consent-title" className="rv-dialog__title">{t('Vos fichiers .fit et vos données de santé')}</h2>
          </div>
        </header>
        <div className="rv-dialog__body">
          <p id="rv-health-consent-intro" className="rv-health-consent__text">
            {t('Un fichier .fit contient des données de santé. Nous avons besoin de votre accord explicite avant de le lire et de l’enregistrer.')}
          </p>
          <dl className="rv-health-consent__list">
            <dt>{t('Quelles données')}</dt>
            <dd>{t('Votre trace GPS horodatée, votre fréquence cardiaque, votre puissance et votre cadence.')}</dd>
            <dt>{t('Pourquoi')}</dt>
            <dd>{t('Calibrer la prédiction de votre temps de parcours sur vos sorties réelles. Rien d’autre : ni publicité, ni partage avec des tiers.')}</dd>
            <dt>{t('Où')}</dt>
            <dd>{t('Sur les serveurs de RedView, dans le projet où vous les ajoutez. Les personnes avec qui vous partagez ce projet peuvent les voir.')}</dd>
            <dt>{t('Combien de temps')}</dt>
            <dd>{t('Tant que le projet existe : supprimer le fichier, l’itinéraire ou le projet les efface.')}</dd>
            <dt>{t('Votre choix')}</dt>
            <dd>{t('Vous pouvez retirer votre accord à tout moment dans Compte → Vos données, et y effacer les fichiers déjà envoyés. Sans accord, la prédiction reste disponible avec vos réglages de rythme.')}</dd>
          </dl>
        </div>
        <footer className="rv-dialog__footer">
          <button ref={refuseRef} type="button" className="rv-dialog__btn" onClick={() => answerHealthDataConsentRequest(false)}>
            {t('Refuser')}
          </button>
          <button type="button" className="rv-dialog__btn rv-dialog__btn--primary" onClick={() => answerHealthDataConsentRequest(true)}>
            {t('J’accepte')}
          </button>
        </footer>
      </div>
    </div>,
    document.body,
  );
}
