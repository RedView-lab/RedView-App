import { SvgV2Icon } from '@/shared/components/SvgV2Icon';

import {
  isDemoPlan,
  LANDING_URL,
  resolveActivePlanId,
  SUBSCRIPTION_PLANS,
} from '../lib';
import { SubscriptionPlanCard } from './SubscriptionPlanCard';
import type {
  BillingContactPreference,
  PaymentMethodSummary,
  SubscriptionPlanId,
  SubscriptionState,
} from '../types';

type ManagedPlanId = Exclude<SubscriptionPlanId, 'demo'>;

type SubscriptionPanelProps = {
  subscriptionState: SubscriptionState;
  selectedPlanId: SubscriptionPlanId;
  setSelectedPlanId: (planId: SubscriptionPlanId) => void;
  contactPreference: BillingContactPreference;
  setContactPreference: React.Dispatch<React.SetStateAction<BillingContactPreference>>;
  accountEmail: string;
  paymentMethod: PaymentMethodSummary | null;
  billingActionBusy: boolean;
  billingActionError: string | null;
  contactStatusMessage: string | null;
  onSelectPlan: (planId: ManagedPlanId) => void;
  onToggleManagedSubscription: () => void;
  onManagePaymentMethod: () => void;
};

export function SubscriptionPanel({
  subscriptionState,
  selectedPlanId,
  setSelectedPlanId,
  contactPreference,
  setContactPreference,
  accountEmail,
  paymentMethod,
  billingActionBusy,
  billingActionError,
  contactStatusMessage,
  onSelectPlan,
  onToggleManagedSubscription,
  onManagePaymentMethod,
}: SubscriptionPanelProps) {
  const showDemoUpsell = isDemoPlan(subscriptionState.snapshot);
  const selectedPlan =
    SUBSCRIPTION_PLANS.find((plan) => plan.id === selectedPlanId) ?? SUBSCRIPTION_PLANS[2];
  const activePlanId = resolveActivePlanId(subscriptionState.snapshot);
  const hasManagedSubscription = !showDemoUpsell;
  const offersUrl = `${LANDING_URL.replace(/\/$/, '')}/#offres`;
  const paymentMethodLabel = paymentMethod
    ? `${paymentMethod.brand.toUpperCase()} se terminant par ${paymentMethod.last4}`
    : hasManagedSubscription
      ? 'Aucun moyen de paiement par défaut'
      : 'Plan Demo sans paiement';
  const paymentMethodHelper = paymentMethod
    ? `Expire ${String(paymentMethod.expMonth).padStart(2, '0')}/${paymentMethod.expYear}.`
    : hasManagedSubscription
      ? 'Ajoutez ou remplacez votre carte directement dans RedView App.'
      : 'Le plan Demo ne requiert aucun paiement. Ajoutez un moyen de paiement uniquement lorsque vous passez à une offre payante.';
  const panelError = billingActionError ?? subscriptionState.error;

  return (
    <section className="rvpb-subscription-panel" aria-label="Gestion de l’abonnement">
      {panelError ? (
        <div className="rvpb-error" role="alert">
          {panelError}
        </div>
      ) : null}

      <div className={`rvpb-subscription-layout${showDemoUpsell ? ' has-demo-upsell' : ''}`}>
        {showDemoUpsell ? (
          <aside className="rvpb-demo-upsell" aria-label="Découvrir les offres payantes">
            <p>
              Vous êtes sur une démo réduite de RedView. Pour activer l’interface,
              choisissez votre abonnement:
            </p>
            <a className="rvpb-demo-upsell__cta" href={offersUrl}>
              <SvgV2Icon name="feedback-play.svg" size={20} />
              <span>Découvrir les offres</span>
            </a>
          </aside>
        ) : null}

        <div className="rvpb-subscription-layout__main">
          <div className="rvpb-subscription-section">
            <div className="rvpb-subscription-section__label">
              <h2>Abonnements</h2>
              <p>Découvrez nos offres d’abonnement.</p>
            </div>

            <div className="rvpb-subscription-section__content rvpb-subscription-section__content--stacked">
              {SUBSCRIPTION_PLANS.map((plan) => {
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
          </div>

          <div className="rvpb-divider" />

          <div className="rvpb-subscription-section">
            <div className="rvpb-subscription-section__label">
              <h2>Informations de paiement</h2>
            </div>

            <div className="rvpb-subscription-section__content">
              <div className="rvpb-payment-card">
                <div className="rvpb-payment-card__icon">
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
                        ? 'Choisir une offre payante'
                        : paymentMethod
                          ? 'Remplacer mon moyen de paiement'
                          : 'Ajouter un moyen de paiement'}
                    </button>
                  </div>
                </div>
              </div>

              <button
                type="button"
                className="rvpb-add-row"
                onClick={onManagePaymentMethod}
                disabled={billingActionBusy}
              >
                <SvgV2Icon name="plus.svg" size={16} />
                <span>
                  {showDemoUpsell
                    ? 'Passer à une offre payante'
                    : paymentMethod
                      ? 'Remplacer le moyen de paiement'
                      : 'Ajouter un moyen de paiement'}
                </span>
              </button>
            </div>
          </div>

          <div className="rvpb-divider" />

          <div className="rvpb-subscription-section">
            <div className="rvpb-subscription-section__label">
              <h2>E-mail de contact</h2>
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
                  <strong>Envoyer sur mon e-mail de compte</strong>
                  <span>{accountEmail || 'Adresse indisponible'}</span>
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
                    <strong>Envoyer sur un e-mail alternatif</strong>
                  </span>
                </label>

                <label className="rvpb-input-wrap">
                  <span className="rvpb-input-icon">
                    <SvgV2Icon name="mail-02.svg" size={16} />
                  </span>
                  <input
                    type="email"
                    value={contactPreference.alternativeEmail}
                    placeholder="billing@votre-domaine.com"
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