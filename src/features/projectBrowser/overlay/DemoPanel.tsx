import { SvgV2Icon } from '@/components/SvgV2Icon';

import { buildSubscriptionHeadline, isDemoPlan } from './subscription';
import type { SubscriptionState } from './types';

type DemoPanelProps = {
  subscriptionState: SubscriptionState;
  openSubscriptionPage: () => void;
};

export function DemoPanel({ subscriptionState, openSubscriptionPage }: DemoPanelProps) {
  const onDemo = isDemoPlan(subscriptionState.snapshot);

  return (
    <section className="rvpb-subscription-panel" aria-label="Présentation du plan Demo">
      {subscriptionState.error ? (
        <div className="rvpb-error" role="alert">
          {subscriptionState.error}
        </div>
      ) : null}

      <div className="rvpb-subscription-section">
        <div className="rvpb-subscription-section__label">
          <h2>Mode Demo</h2>
          <p>
            {subscriptionState.isLoading
              ? 'Chargement de votre accès Demo…'
              : buildSubscriptionHeadline(subscriptionState.snapshot)}
          </p>
        </div>

        <div className="rvpb-subscription-section__content rvpb-subscription-section__content--stacked">
          <div className="rvpb-payment-card">
            <div className="rvpb-payment-card__icon">
              <SvgV2Icon name="layers-three-02.svg" size={18} />
            </div>
            <div className="rvpb-payment-card__copy">
              <strong>
                {onDemo ? 'Accès Demo activé sur ce compte' : 'Compte déjà sur une offre payante'}
              </strong>
              <span>
                {onDemo
                  ? 'Vous pouvez ouvrir vos projets, préparer vos sorties et conserver un point d’entrée simple avant de passer sur Explorer ou Pro.'
                  : 'Votre compte n’est plus limité au mode Demo. Utilisez cet onglet comme vue d’ensemble rapide de votre accès actuel.'}
              </span>
            </div>
          </div>

          <div className="rvpb-payment-card">
            <div className="rvpb-payment-card__icon">
              <SvgV2Icon name="marker-pin-04.svg" size={18} />
            </div>
            <div className="rvpb-payment-card__copy">
              <strong>Basculer sur RedView Web pour upgrader</strong>
              <span>
                Le changement d’offre reste centralisé sur le web. Cet overlay sert désormais de point d’entrée clair entre Demo, projets et abonnement.
              </span>
              <div className="rvpb-link-row">
                <button type="button" className="rvpb-text-link" onClick={openSubscriptionPage}>
                  Ouvrir les offres RedView
                </button>
              </div>
            </div>
          </div>
        </div>
      </div>

      <div className="rvpb-divider" />

      <div className="rvpb-subscription-section">
        <div className="rvpb-subscription-section__label">
          <h2>Inclus dans Demo</h2>
          <p>Un résumé rapide des usages déjà disponibles sans facturation.</p>
        </div>

        <div className="rvpb-subscription-section__content rvpb-subscription-section__content--stacked">
          <div className="rvpb-payment-card">
            <div className="rvpb-payment-card__icon">
              <SvgV2Icon name="folder.svg" size={18} />
            </div>
            <div className="rvpb-payment-card__copy">
              <strong>Gestion des projets</strong>
              <span>Créer, renommer, supprimer et rouvrir vos projets depuis le tableau de bord.</span>
            </div>
          </div>

          <div className="rvpb-payment-card">
            <div className="rvpb-payment-card__icon">
              <SvgV2Icon name="mail-02.svg" size={18} />
            </div>
            <div className="rvpb-payment-card__copy">
              <strong>Compte prêt pour la suite</strong>
              <span>Vos préférences de contact sont déjà prêtes pour un passage ultérieur à une offre payante.</span>
            </div>
          </div>
        </div>
      </div>
    </section>
  );
}