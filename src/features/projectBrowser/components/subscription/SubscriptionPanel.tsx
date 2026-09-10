import { SvgV2Icon } from '@/shared/components/SvgV2Icon';
import { useAppI18n } from '@/shared/i18n';

import {
  isDemoPlan,
  resolveActivePlanId,
  SUBSCRIPTION_PLANS,
} from '../../lib';
import { SubscriptionPlanCard } from './SubscriptionPlanCard';
import type {
  BillingContactPreference,
  PaymentMethodSummary,
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
  const visiblePlans = hasManagedSubscription
    ? SUBSCRIPTION_PLANS.filter((plan) => plan.id !== 'demo')
    : SUBSCRIPTION_PLANS;
  const effectiveSelectedPlanId: SubscriptionPlanId =
    hasManagedSubscription && selectedPlanId === 'demo' ? activePlanId : selectedPlanId;
  const selectedPlan =
    SUBSCRIPTION_PLANS.find((plan) => plan.id === effectiveSelectedPlanId) ?? SUBSCRIPTION_PLANS[2];
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
      : t('Le plan Demo ne requiert aucun paiement. Ajoutez un moyen de paiement uniquement lorsque vous passez à une offre payante.');
  const panelError = billingActionError ?? subscriptionState.error;
  const subscriptionOffersContent = (
    <div className="rvpb-subscription-section__content rvpb-subscription-section__content--stacked">
      {visiblePlans.map((plan) => {
        const isActivePlan = activePlanId === plan.id;
        const isSelectedPlan = selectedPlan.id === plan.id;
        const isDemoSelection = plan.id === 'demo';

        return (
          <SubscriptionPlanCard
            key={plan.id}
            plan={plan}
            selected={isSelectedPlan}
            active={Boolean(isActivePlan)}
            onSelect={setSelectedPlanId}
            ctaLabel={
              isActivePlan && !isDemoSelection
                ? subscriptionState.snapshot?.cancelAtPeriodEnd
                  ? 'Reprendre'
                  : 'Interrompre'
                : isSelectedPlan && !isDemoSelection
                  ? hasManagedSubscription
                    ? 'Basculer sur cette offre'
                    : 'Choisir cette offre'
                  : undefined
            }
            ctaTone={isActivePlan && !isDemoSelection ? 'danger' : 'neutral'}
            ctaDisabled={billingActionBusy}
            onCtaClick={
              isDemoSelection
                ? undefined
                : isActivePlan
                  ? onToggleManagedSubscription
                  : () => onSelectPlan(plan.id as ManagedPlanId)
            }
          />
        );
      })}
    </div>
  );

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
                <h2>{t('Abonnements')}</h2>
                <p>{t('Découvrez nos offres d’abonnement.')}</p>
              </div>

              {subscriptionOffersContent}
            </div>

          <div className="rvpb-divider" />

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

                        <div className="rvpb-link-row">
                          {!method.isDefault ? (
                            <button
                              type="button"
                              className="rvpb-text-link"
                              onClick={() => onSetDefaultPaymentMethod(method.id)}
                              disabled={billingActionBusy}
                            >
                              {t('Définir par défaut')}
                            </button>
                          ) : null}
                          <button
                            type="button"
                            className="rvpb-text-link"
                            onClick={onManagePaymentMethod}
                            disabled={billingActionBusy}
                          >
                            {t('Modifier')}
                          </button>
                        </div>
                      </div>
                    </div>
                  ))
                ) : (
                  <div className="rvpb-payment-card">
                    <div className="rvpb-payment-card__icon rvpb-payment-card__icon--generic">
                      <SvgV2Icon name="credit-card-02.svg" size={18} />
                    </div>
                    <div className="rvpb-payment-card__copy">
                      <strong>{paymentMethodLabel}</strong>
                      <span>{paymentMethodHelper}</span>
                      <div className="rvpb-link-row">
                        <button
                          type="button"
                          className="rvpb-text-link"
                          onClick={onManagePaymentMethod}
                          disabled={billingActionBusy}
                        >
                          {showDemoUpsell
                            ? t('Choisir une offre payante')
                            : paymentMethod
                              ? t('Remplacer mon moyen de paiement')
                              : t('Ajouter un moyen de paiement')}
                        </button>
                      </div>
                    </div>
                  </div>
                )}
              </div>

              <p className="rvpb-inline-note">
                {hasManagedSubscription
                  ? t('Toute carte confirmée pendant la souscription ou via le formulaire Stripe apparaît ici automatiquement et peut devenir votre carte par défaut.')
                  : t('Quand vous passez à une offre payante, la carte validée pendant la souscription sera enregistrée ici automatiquement.')}
              </p>

              <button
                type="button"
                className="rvpb-add-row"
                onClick={onManagePaymentMethod}
                disabled={billingActionBusy}
              >
                <SvgV2Icon name="plus.svg" size={16} />
                <span>
                  {showDemoUpsell
                    ? t('Passer à une offre payante')
                    : savedPaymentMethods.length > 0
                      ? t('Ajouter une nouvelle carte')
                      : t('Ajouter un moyen de paiement')}
                </span>
              </button>
            </div>
          </div>

          <div className="rvpb-divider" />

          <div className="rvpb-subscription-section">
            <div className="rvpb-subscription-section__label">
              <h2>{t('E-mail de contact')}</h2>
            </div>

            <div className="rvpb-subscription-section__content rvpb-subscription-section__content--stacked">
              {contactStatusMessage ? <p className="rvpb-inline-note">{contactStatusMessage}</p> : null}

              <label className="rvpb-contact-option">
                <input
                  type="radio"
                  name="billing-contact"
                  checked={contactPreference.mode === 'account'}
                  onChange={() =>
                    setContactPreference((prev) => ({
                      ...prev,
                      mode: 'account',
                    }))
                  }
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
                    onChange={() =>
                      setContactPreference((prev) => ({
                        ...prev,
                        mode: 'alternative',
                      }))
                    }
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
                    onChange={(event) =>
                      setContactPreference({
                        mode: 'alternative',
                        alternativeEmail: event.target.value,
                      })
                    }
                  />
                </label>
              </div>
            </div>
          </div>
        </div>
      </div>
    </section>
  );
}