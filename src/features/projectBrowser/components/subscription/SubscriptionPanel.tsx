import { useState } from 'react';

import { useAppI18n } from '@/shared/i18n';
import {
  isDemoPlan,
  resolveActivePlanId,
  getPlansForPeriod,
} from '../../lib';
import { SubscriptionPlanCard } from './SubscriptionPlanCard';
import type {
  BillingContactPreference,
  PaymentMethodSummary,
  SubscriptionPlan,
  SubscriptionPlanId,
  SubscriptionState,
} from '../../types';

type ManagedPlanId = Exclude<SubscriptionPlanId, 'demo'>;

type SubscriptionPanelProps = {
  subscriptionState: SubscriptionState;
  selectedPlanId: SubscriptionPlanId;
  setSelectedPlanId: (planId: SubscriptionPlanId) => void;
  contactPreference: BillingContactPreference;
  setContactPreference: React.Dispatch<React.SetStateAction<BillingContactPreference>>;
  accountEmail: string;
  paymentMethod: PaymentMethodSummary | null;
  paymentMethods: PaymentMethodSummary[];
  billingActionBusy: boolean;
  billingActionError: string | null;
  contactStatusMessage: string | null;
  onSelectPlan: (planId: ManagedPlanId) => void;
  onToggleManagedSubscription: () => void;
  onManagePaymentMethod: () => void;
  onSetDefaultPaymentMethod: (paymentMethodId: string) => void;
};

function formatDisplayedPaymentBrand(brand: string): string {
  const normalized = brand.trim().toLowerCase();

  if (normalized === 'visa') return 'VISA';
  if (normalized === 'mastercard') return 'Mastercard';
  if (normalized === 'american express' || normalized === 'amex') return 'AMEX';
  if (normalized === 'cartes bancaires') return 'CB';
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
  selectedPlanId,
  setSelectedPlanId,
  contactPreference,
  setContactPreference,
  accountEmail,
  paymentMethod,
  paymentMethods,
  billingActionBusy,
  billingActionError,
  contactStatusMessage,
  onSelectPlan,
  onToggleManagedSubscription,
  onManagePaymentMethod,
  onSetDefaultPaymentMethod,
}: SubscriptionPanelProps) {
  const { t } = useAppI18n();
  const showDemoUpsell = isDemoPlan(subscriptionState.snapshot);
  const activePlanId = resolveActivePlanId(subscriptionState.snapshot);
  const hasManagedSubscription = !showDemoUpsell;

  const [billingPeriod, setBillingPeriod] = useState<'yearly' | 'monthly'>(() => {
    if (activePlanId === 'founderMonthly' || activePlanId === 'patronMonthly') {
      return 'monthly';
    }
    return 'yearly';
  });

  const visiblePlans = getPlansForPeriod(billingPeriod);

  const effectiveSelectedPlanId: SubscriptionPlanId =
    selectedPlanId === 'demo' ? 'demo' : selectedPlanId;

  const savedPaymentMethods = paymentMethods.length > 0 ? paymentMethods : paymentMethod ? [paymentMethod] : [];
  const paymentMethodLabel = paymentMethod
    ? t('{{brand}} se terminant par {{last4}}', {
        brand: formatDisplayedPaymentBrand(paymentMethod.brand),
        last4: paymentMethod.last4,
      })
    : hasManagedSubscription
      ? t('Aucun moyen de paiement par défaut')
      : t('Plan Demo sans paiement');
  const paymentMethodHelper = paymentMethod
    ? t('Expire {{date}}.', {
        date: `${String(paymentMethod.expMonth).padStart(2, '0')}/${paymentMethod.expYear}`,
      })
    : hasManagedSubscription
      ? t('Ajoutez ou remplacez votre carte directement dans RedView App.')
      : t('L’accès Bêta Web ne requiert aucun paiement. Ajoutez un moyen de paiement uniquement si vous souhaitez devenir Membre Fondateur ou Mécène.');
  const panelError = billingActionError ?? subscriptionState.error;

  return (
    <section className="rvpb-subscription-panel" aria-label={t('Gestion de l’abonnement')}>
      {panelError ? (
        <div className="rvpb-error" role="alert">
          {panelError}
        </div>
      ) : null}

      <div className="rvpb-subscription-layout">
        <div className="rvpb-subscription-layout__main">
          {/* Main header matching landing page */}
          <div className="rvpb-subscription-header">
            <div className="rvpb-subscription-header__titles">
              <h2 className="rvpb-subscription-header__title">
                {t('Bêta Ouverte & Accès Fondateur')}
              </h2>
              <p className="rvpb-subscription-header__subtitle">
                {t('Explorez gratuitement le moteur 3D RedView sur le Web. Devenez Membre Fondateur pour financer l’application mobile et débloquer vos avantages à vie.')}
              </p>
            </div>

            <div
              className="rvpb-billing-toggle"
              role="radiogroup"
              aria-label={t('Formule de soutien')}
            >
              <button
                type="button"
                className={`rvpb-billing-toggle__btn${billingPeriod === 'yearly' ? ' is-active' : ''}`}
                onClick={() => setBillingPeriod('yearly')}
                role="radio"
                aria-checked={billingPeriod === 'yearly'}
              >
                {t('Pass Unique')}
              </button>
              <button
                type="button"
                className={`rvpb-billing-toggle__btn${billingPeriod === 'monthly' ? ' is-active' : ''}`}
                onClick={() => setBillingPeriod('monthly')}
                role="radio"
                aria-checked={billingPeriod === 'monthly'}
              >
                {t('Soutien Mensuel')}
              </button>
            </div>
          </div>

          {/* 3 cards grid */}
          <div className="rvpb-subscription-cards-grid">
            {visiblePlans.map((plan: SubscriptionPlan) => {
              const isCurrentPlanActive =
                activePlanId === plan.id ||
                (!hasManagedSubscription && plan.id === 'demo');

              const isSelectedPlan = effectiveSelectedPlanId === plan.id;
              const isDemoSelection = plan.id === 'demo';

              let ctaLabel: string | undefined;
              let ctaTone: 'danger' | 'neutral' = 'neutral';

              if (isCurrentPlanActive) {
                if (isDemoSelection) {
                  ctaLabel = t('Accès Bêta Actif');
                } else {
                  ctaLabel = subscriptionState.snapshot?.cancelAtPeriodEnd
                    ? t('Reprendre')
                    : t('Interrompre');
                  ctaTone = 'danger';
                }
              } else if (hasManagedSubscription) {
                ctaLabel = t('Basculer sur cette offre');
              } else {
                ctaLabel = plan.ctaDefaultLabel;
              }

              return (
                <SubscriptionPlanCard
                  key={`${billingPeriod}-${plan.id}`}
                  plan={plan}
                  selected={isSelectedPlan}
                  active={Boolean(isCurrentPlanActive)}
                  onSelect={setSelectedPlanId}
                  ctaLabel={ctaLabel}
                  ctaTone={ctaTone}
                  ctaDisabled={billingActionBusy || (isCurrentPlanActive && isDemoSelection)}
                  onCtaClick={
                    isDemoSelection
                      ? undefined
                      : isCurrentPlanActive
                        ? onToggleManagedSubscription
                        : () => onSelectPlan(plan.id as ManagedPlanId)
                  }
                />
              );
            })}
          </div>

          <div className="rvpb-divider" />

          {/* Payment information section */}
          <div className="rvpb-subscription-section">
            <div className="rvpb-subscription-section__label">
              <h2>{t('Informations de paiement')}</h2>
            </div>

            <div className="rvpb-subscription-section__content">
              <div className="rvpb-payment-methods">
                {savedPaymentMethods.length > 0 ? (
                  savedPaymentMethods.map((method) => (
                    <div
                      key={method.id}
                      className={`rvpb-payment-card${method.isDefault ? ' is-default' : ''}`}
                    >
                      <div className={`rvpb-payment-card__icon rvpb-payment-card__icon--${paymentBrandTone(method.brand)}`}>
                        <span className="rvpb-payment-card__brand-mark">
                          {formatDisplayedPaymentBrand(method.brand)}
                        </span>
                      </div>

                      <div className="rvpb-payment-card__copy">
                        <div className="rvpb-payment-card__headline">
                          <strong>
                            {t('{{brand}} se terminant par {{last4}}', {
                              brand: formatDisplayedPaymentBrand(method.brand),
                              last4: method.last4,
                            })}
                          </strong>
                          {method.isDefault ? (
                            <span className="rvpb-payment-card__badge">{t('Par défaut')}</span>
                          ) : null}
                        </div>

                        <span>
                          {t('Expire {{date}}.', {
                            date: `${String(method.expMonth).padStart(2, '0')}/${method.expYear}`,
                          })}
                        </span>
                      </div>

                      <div className="rvpb-payment-card__actions">
                        {!method.isDefault ? (
                          <button
                            type="button"
                            className="rvpb-action-link"
                            disabled={billingActionBusy}
                            onClick={() => onSetDefaultPaymentMethod(method.id)}
                          >
                            {t('Définir par défaut')}
                          </button>
                        ) : null}
                      </div>
                    </div>
                  ))
                ) : (
                  <div className="rvpb-payment-card rvpb-payment-card--empty">
                    <div className="rvpb-payment-card__icon rvpb-payment-card__icon--generic">
                      <span className="rvpb-payment-card__brand-mark">CARD</span>
                    </div>

                    <div className="rvpb-payment-card__copy">
                      <div className="rvpb-payment-card__headline">
                        <strong>{paymentMethodLabel}</strong>
                      </div>
                      <span>{paymentMethodHelper}</span>
                    </div>
                  </div>
                )}

                <div className="rvpb-payment-methods__footer">
                  <button
                    type="button"
                    className="rvpb-primary-button rvpb-primary-button--compact"
                    disabled={billingActionBusy}
                    onClick={onManagePaymentMethod}
                  >
                    {savedPaymentMethods.length > 0
                      ? t('Ajouter ou modifier un moyen de paiement')
                      : t('Ajouter un moyen de paiement')}
                  </button>
                </div>
              </div>
            </div>
          </div>

          <div className="rvpb-divider" />

          {/* Contact email section */}
          <div className="rvpb-subscription-section">
            <div className="rvpb-subscription-section__label">
              <h2>{t('E-mail de contact')}</h2>
            </div>

            <div className="rvpb-subscription-section__content">
              <div className="rvpb-contact-options">
                <label className="rvpb-contact-option">
                  <input
                    type="radio"
                    name="rvpb-billing-contact"
                    value="account"
                    checked={contactPreference.mode === 'account'}
                    onChange={() =>
                      setContactPreference((current) => ({
                        ...current,
                        mode: 'account',
                      }))
                    }
                  />
                  <span className="rvpb-radio-faux" aria-hidden="true" />
                  <div className="rvpb-contact-option__copy">
                    <strong>{t('Envoyer sur mon e-mail de compte')}</strong>
                    <span>{accountEmail || t('E-mail principal du compte')}</span>
                  </div>
                </label>

                <label className="rvpb-contact-option">
                  <input
                    type="radio"
                    name="rvpb-billing-contact"
                    value="alternative"
                    checked={contactPreference.mode === 'alternative'}
                    onChange={() =>
                      setContactPreference((current) => ({
                        ...current,
                        mode: 'alternative',
                      }))
                    }
                  />
                  <span className="rvpb-radio-faux" aria-hidden="true" />
                  <div className="rvpb-contact-option__copy">
                    <strong>{t('Envoyer sur un e-mail alternatif')}</strong>
                  </div>
                </label>

                {contactPreference.mode === 'alternative' ? (
                  <div className="rvpb-contact-field">
                    <input
                      type="email"
                      className="rvpb-input"
                      placeholder="facturation@entreprise.com"
                      value={contactPreference.alternativeEmail}
                      onChange={(event) =>
                        setContactPreference((current) => ({
                          ...current,
                          alternativeEmail: event.target.value,
                        }))
                      }
                    />
                  </div>
                ) : null}

                {contactStatusMessage ? (
                  <span className="rvpb-contact-status" role="status">
                    {contactStatusMessage}
                  </span>
                ) : null}
              </div>
            </div>
          </div>
        </div>
      </div>
    </section>
  );
}