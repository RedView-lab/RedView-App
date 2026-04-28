import { SvgV2Icon } from '@/components/SvgV2Icon';

import {
  buildSubscriptionHeadline,
  hasPaidSubscription,
  isDemoPlan,
  resolveActivePlanId,
  statusLabel,
  SUBSCRIPTION_PLANS,
} from './subscription';
import { formatShortDate } from './utils';
import { SubscriptionPlanCard } from './SubscriptionPlanCard';
import type {
  BillingContactPreference,
  SubscriptionPlanId,
  SubscriptionState,
} from './types';

type SubscriptionPanelProps = {
  subscriptionState: SubscriptionState;
  selectedPlanId: SubscriptionPlanId;
  setSelectedPlanId: (planId: SubscriptionPlanId) => void;
  contactPreference: BillingContactPreference;
  setContactPreference: React.Dispatch<React.SetStateAction<BillingContactPreference>>;
  accountEmail: string;
  openSubscriptionPage: () => void;
};

export function SubscriptionPanel({
  subscriptionState,
  selectedPlanId,
  setSelectedPlanId,
  contactPreference,
  setContactPreference,
  accountEmail,
  openSubscriptionPage,
}: SubscriptionPanelProps) {
  const selectedPlan =
    SUBSCRIPTION_PLANS.find((plan) => plan.id === selectedPlanId) ?? SUBSCRIPTION_PLANS[2];
  const activePlanId = resolveActivePlanId(subscriptionState.snapshot);

  return (
    <section className="rvpb-subscription-panel" aria-label="Gestion de l’abonnement">
      {subscriptionState.error ? (
        <div className="rvpb-error" role="alert">
          {subscriptionState.error}
        </div>
      ) : null}

      <div className="rvpb-subscription-section">
        <div className="rvpb-subscription-section__label">
          <h2>Abonnement actuel</h2>
          <p>
            {subscriptionState.isLoading
              ? 'Chargement de votre état d’abonnement…'
              : buildSubscriptionHeadline(subscriptionState.snapshot)}
          </p>
        </div>

        <div className="rvpb-subscription-section__content rvpb-subscription-section__content--stacked">
          {SUBSCRIPTION_PLANS.map((plan) => {
            const isActivePlan =
              hasPaidSubscription(subscriptionState.snapshot) && activePlanId === plan.id;
            const isSelectedPlan = selectedPlan.id === plan.id;

            return (
              <SubscriptionPlanCard
                key={plan.id}
                plan={plan}
                selected={isSelectedPlan}
                active={Boolean(isActivePlan)}
                onSelect={setSelectedPlanId}
                ctaLabel={
                  isActivePlan
                    ? subscriptionState.snapshot?.cancelAtPeriodEnd
                      ? 'Gérer'
                      : 'Interrompre'
                    : isSelectedPlan
                      ? 'Choisir sur RedView Web'
                      : undefined
                }
                ctaTone={isActivePlan ? 'danger' : 'neutral'}
                onCtaClick={openSubscriptionPage}
                ctaHelper={
                  isActivePlan
                    ? subscriptionState.snapshot?.cancelAtPeriodEnd
                      ? `Fin prévue le ${formatShortDate(subscriptionState.snapshot.currentPeriodEnd)}.`
                      : `Statut ${statusLabel(subscriptionState.snapshot).toLowerCase()}.`
                    : isSelectedPlan
                      ? 'Le changement de plan se fait depuis la page d’abonnement RedView Web.'
                      : undefined
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
              <strong>
                {isDemoPlan(subscriptionState.snapshot)
                  ? 'Plan Demo sans paiement'
                  : 'Facturation gérée dans Stripe'}
              </strong>
              <span>
                {isDemoPlan(subscriptionState.snapshot)
                  ? 'Le plan Demo ne requiert aucun paiement. Ajoutez un moyen de paiement uniquement lorsque vous passez à une offre payante.'
                  : 'Ouvrez le portail sécurisé pour ajouter ou modifier votre moyen de paiement.'}
              </span>
              <div className="rvpb-link-row">
                <button type="button" className="rvpb-text-link" onClick={openSubscriptionPage}>
                  {isDemoPlan(subscriptionState.snapshot)
                    ? 'Choisir une offre payante'
                    : 'Ouvrir la page d’abonnement'}
                </button>
              </div>
            </div>
          </div>

          <button type="button" className="rvpb-add-row" onClick={openSubscriptionPage}>
            <SvgV2Icon name="plus.svg" size={16} />
            <span>
              {isDemoPlan(subscriptionState.snapshot)
                ? 'Passer à une offre payante'
                : 'Ajouter ou modifier un moyen de paiement'}
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
    </section>
  );
}