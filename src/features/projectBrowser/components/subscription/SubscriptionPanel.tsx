import { useState } from 'react';

import { SvgV2Icon } from '@/shared/components/SvgV2Icon';
import { useAppI18n } from '@/shared/i18n';

import {
  DISPLAY_PLANS,
  hasLiveSubscription,
  hasPaymentIssue,
  subscriptionStatusLine,
} from '../../lib';
import { CancelSubscriptionDialog } from './CancelSubscriptionDialog';
import { SubscriptionPlanCard } from './SubscriptionPlanCard';
import type {
  BillingContactPreference,
  PaymentMethodSummary,
  SubscriptionPlanId,
  SubscriptionState,
} from '../../types';

type SubscriptionPanelProps = {
  subscriptionState: SubscriptionState;
  contactPreference: BillingContactPreference;
  setContactPreference: React.Dispatch<React.SetStateAction<BillingContactPreference>>;
  accountEmail: string;
  paymentMethods: PaymentMethodSummary[];
  billingActionBusy: boolean;
  billingActionError: string | null;
  contactStatusMessage: string | null;
  /** Souscrire à une durée (pas d'abonnement en cours). */
  onChoosePlan: (planId: SubscriptionPlanId) => void;
  /** Passer l'abonnement en cours à une autre durée (portail Stripe). */
  onSwitchPlan: (planId: SubscriptionPlanId) => void;
  /** Résiliation confirmée ; true quand elle a abouti. */
  onCancelSubscription: () => Promise<boolean>;
  onResumeSubscription: () => void;
  onOpenPortal: () => void;
  onManagePaymentMethod: () => void;
  onSetDefaultPaymentMethod: (paymentMethodId: string) => void;
};

function formatDisplayedPaymentBrand(brand: string): string {
  const normalized = brand.trim().toLowerCase();

  if (normalized === 'visa') return 'VISA';
  if (normalized === 'mastercard') return 'Mastercard';
  if (normalized === 'american express' || normalized === 'amex') return 'AMEX';
  if (normalized === 'cartes bancaires' || normalized === 'cartes_bancaires') return 'CB';
  if (normalized === 'paypal') return 'PayPal';
  if (normalized === 'sepa_debit') return 'SEPA';
  if (normalized === 'link') return 'Link';
  if (!normalized) return 'CARD';

  return normalized.replace(/_/g, ' ').toUpperCase();
}

function paymentBrandTone(brand: string): 'visa' | 'mastercard' | 'amex' | 'generic' {
  const normalized = brand.trim().toLowerCase();

  if (normalized === 'visa') return 'visa';
  if (normalized === 'mastercard') return 'mastercard';
  if (normalized === 'american express' || normalized === 'amex') return 'amex';

  return 'generic';
}

export function SubscriptionPanel({
  subscriptionState,
  contactPreference,
  setContactPreference,
  accountEmail,
  paymentMethods,
  billingActionBusy,
  billingActionError,
  contactStatusMessage,
  onChoosePlan,
  onSwitchPlan,
  onCancelSubscription,
  onResumeSubscription,
  onOpenPortal,
  onManagePaymentMethod,
  onSetDefaultPaymentMethod,
}: SubscriptionPanelProps) {
  const { t } = useAppI18n();
  // Bouton qui a ouvert la pop-in de résiliation (le focus y revient) ; null = fermée.
  const [cancelAnchor, setCancelAnchor] = useState<HTMLElement | null>(null);
  const snapshot = subscriptionState.snapshot;
  const live = hasLiveSubscription(snapshot);
  const loading = subscriptionState.isLoading && !snapshot;
  // Changer de durée : seulement un abonnement à jour et non résilié.
  const canSwitch = live && !snapshot?.cancelAtPeriodEnd && !hasPaymentIssue(snapshot);
  const panelError = billingActionError ?? subscriptionState.error;

  const planCards = DISPLAY_PLANS.map((plan) => {
    const current = live && snapshot?.planId === plan.id;
    if (!live) {
      return (
        <SubscriptionPlanCard
          key={plan.id}
          plan={plan}
          current={false}
          showTrial={subscriptionState.trialEligible}
          ctaLabel={t('Choisir')}
          ctaDisabled={billingActionBusy || loading || Boolean(subscriptionState.error && !snapshot)}
          onCta={() => onChoosePlan(plan.id)}
        />
      );
    }
    return (
      <SubscriptionPlanCard
        key={plan.id}
        plan={plan}
        current={current}
        showTrial={false}
        statusLabel={current ? (snapshot?.status === 'trialing' ? t('Essai en cours') : t('Votre formule')) : undefined}
        ctaLabel={current ? t('Formule actuelle') : t('Passer à cette formule')}
        ctaDisabled={current || !canSwitch || billingActionBusy}
        ctaTitle={!current && !canSwitch ? t('Reprenez d’abord votre abonnement pour changer de formule.') : undefined}
        onCta={() => onSwitchPlan(plan.id)}
      />
    );
  });

  const showPaymentSection = live || paymentMethods.length > 0;

  return (
    <section className="rvpb-subscription-panel" aria-label={t('Gestion de l’abonnement')}>
      {panelError ? (
        <div className="rvpb-error" role="alert">
          {panelError}
        </div>
      ) : null}

      <div className="rvpb-subscription-layout">
        <div className="rvpb-subscription-layout__main">
          <div className="rvpb-subscription-section">
            <div className="rvpb-subscription-section__label">
              <h2>{t('Abonnement RedView')}</h2>
              <p>
                {t('Un seul abonnement, toutes les fonctionnalités : moteur 3D et LiDAR, météo, neige, routage, export GPX et co-édition. Seule la durée change le prix.')}
              </p>
            </div>

            <div className="rvpb-subscription-section__content">
              {live && snapshot ? (
                <div className={`rvpb-subscription-status${hasPaymentIssue(snapshot) ? ' is-warning' : ''}`} role="status">
                  <p>{subscriptionStatusLine(snapshot)}</p>
                  <div className="rvpb-subscription-status__actions">
                    {snapshot.cancelAtPeriodEnd ? (
                      <button type="button" className="rvpb-inline-cta" onClick={onResumeSubscription} disabled={billingActionBusy}>
                        {t('Reprendre mon abonnement')}
                      </button>
                    ) : (
                      <button
                        type="button"
                        className="rvpb-inline-cta is-danger"
                        onClick={(event) => setCancelAnchor(event.currentTarget)}
                        disabled={billingActionBusy}
                      >
                        {t('Résilier votre contrat')}
                      </button>
                    )}
                    <button type="button" className="rvpb-inline-cta" onClick={onOpenPortal} disabled={billingActionBusy}>
                      {t('Factures et reçus')}
                    </button>
                  </div>
                </div>
              ) : null}

              <div className="rvpb-plan-grid" aria-busy={loading}>
                {planCards}
              </div>

              <p className="rvpb-inline-note">
                {live
                  ? t('Le changement de formule s’applique tout de suite : la différence est calculée au prorata et facturée par Stripe, qui vous montre le montant avant de confirmer.')
                  : subscriptionState.trialEligible
                    ? t('Prix TTC. Aucun prélèvement pendant les 7 jours d’essai : le premier a lieu à la fin de l’essai, puis à chaque échéance. Renouvellement automatique, résiliable à tout moment depuis cet onglet, avec effet à la fin de la période en cours. Paiement sécurisé par Stripe.')
                    : t('Prix TTC, prélevés à la souscription puis à chaque échéance. Renouvellement automatique, résiliable à tout moment depuis cet onglet, avec effet à la fin de la période en cours. Paiement sécurisé par Stripe.')}
              </p>
            </div>
          </div>

          {showPaymentSection ? (
            <>
              <div className="rvpb-divider" />

              <div className="rvpb-subscription-section">
                <div className="rvpb-subscription-section__label">
                  <h2>{t('Informations de paiement')}</h2>
                </div>

                <div className="rvpb-subscription-section__content">
                  <div className="rvpb-payment-methods">
                    {paymentMethods.map((method) => (
                      <div key={method.id} className={`rvpb-payment-card${method.isDefault ? ' is-default' : ''}`}>
                        <div className={`rvpb-payment-card__icon rvpb-payment-card__icon--${paymentBrandTone(method.brand)}`}>
                          <span className="rvpb-payment-card__brand-mark">{formatDisplayedPaymentBrand(method.brand)}</span>
                        </div>

                        <div className="rvpb-payment-card__copy">
                          <div className="rvpb-payment-card__headline">
                            <strong>
                              {method.last4
                                ? t('{{brand}} se terminant par {{last4}}', {
                                    brand: formatDisplayedPaymentBrand(method.brand),
                                    last4: method.last4,
                                  })
                                : formatDisplayedPaymentBrand(method.brand)}
                            </strong>
                            {method.isDefault ? <span className="rvpb-payment-card__badge">{t('Par défaut')}</span> : null}
                          </div>

                          {method.expMonth && method.expYear ? (
                            <span>
                              {t('Expire {{date}}.', {
                                date: `${String(method.expMonth).padStart(2, '0')}/${method.expYear}`,
                              })}
                            </span>
                          ) : null}

                          {!method.isDefault ? (
                            <div className="rvpb-link-row">
                              <button
                                type="button"
                                className="rvpb-text-link"
                                onClick={() => onSetDefaultPaymentMethod(method.id)}
                                disabled={billingActionBusy}
                              >
                                {t('Définir par défaut')}
                              </button>
                            </div>
                          ) : null}
                        </div>
                      </div>
                    ))}
                  </div>

                  <p className="rvpb-inline-note">
                    {t('Les prochains prélèvements utilisent le moyen de paiement par défaut.')}
                  </p>

                  <button type="button" className="rvpb-add-row" onClick={onManagePaymentMethod} disabled={billingActionBusy}>
                    <SvgV2Icon name="plus.svg" size={16} />
                    <span>{paymentMethods.length > 0 ? t('Ajouter un moyen de paiement') : t('Enregistrer un moyen de paiement')}</span>
                  </button>
                </div>
              </div>
            </>
          ) : null}

          <div className="rvpb-divider" />

          <div className="rvpb-subscription-section">
            <div className="rvpb-subscription-section__label">
              <h2>{t('E-mail de facturation')}</h2>
              <p>{t('Reçus, factures et e-mails de l’abonnement.')}</p>
            </div>

            <div className="rvpb-subscription-section__content rvpb-subscription-section__content--stacked">
              {contactStatusMessage ? <p className="rvpb-inline-note">{contactStatusMessage}</p> : null}

              <label className="rvpb-contact-option">
                <input
                  type="radio"
                  name="billing-contact"
                  checked={contactPreference.mode === 'account'}
                  onChange={() => setContactPreference((prev) => ({ ...prev, mode: 'account' }))}
                />
                <span className="rvpb-radio-faux" aria-hidden="true" />
                <span className="rvpb-contact-option__copy">
                  <strong>{t('Envoyer sur mon e-mail de compte')}</strong>
                  <span>{accountEmail || t('Adresse indisponible')}</span>
                </span>
              </label>

              <div className="rvpb-contact-group">
                <label className="rvpb-contact-option">
                  <input
                    type="radio"
                    name="billing-contact"
                    checked={contactPreference.mode === 'alternative'}
                    onChange={() => setContactPreference((prev) => ({ ...prev, mode: 'alternative' }))}
                  />
                  <span className="rvpb-radio-faux" aria-hidden="true" />
                  <span className="rvpb-contact-option__copy">
                    <strong>{t('Envoyer sur un e-mail alternatif')}</strong>
                  </span>
                </label>

                <label className="rvpb-input-wrap">
                  <span className="rvpb-input-icon">
                    <SvgV2Icon name="mail-02.svg" size={16} />
                  </span>
                  <input
                    type="email"
                    value={contactPreference.alternativeEmail}
                    placeholder={t('billing@votre-domaine.com')}
                    aria-label={t('E-mail de facturation alternatif')}
                    onChange={(event) =>
                      setContactPreference({ mode: 'alternative', alternativeEmail: event.target.value })
                    }
                  />
                </label>
              </div>
            </div>
          </div>
        </div>
      </div>

      {cancelAnchor && snapshot ? (
        <CancelSubscriptionDialog
          snapshot={snapshot}
          accountEmail={accountEmail}
          anchorEl={cancelAnchor}
          onConfirm={onCancelSubscription}
          onClose={() => setCancelAnchor(null)}
        />
      ) : null}
    </section>
  );
}
