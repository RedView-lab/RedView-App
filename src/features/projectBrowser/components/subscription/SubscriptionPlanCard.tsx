import { SvgV2Icon } from '@/shared/components/SvgV2Icon';

import { logBillingUi } from '../../lib';
import type { SubscriptionPlanId, SubscriptionPlan } from '../../types';

type SubscriptionPlanCardProps = {
  plan: SubscriptionPlan;
  selected: boolean;
  active: boolean;
  onSelect: (planId: SubscriptionPlanId) => void;
  ctaLabel?: string;
  ctaTone?: 'danger' | 'neutral';
  ctaDisabled?: boolean;
  onCtaClick?: () => void | Promise<void>;
};

export function SubscriptionPlanCard({
  plan,
  selected,
  active,
  onSelect,
  ctaLabel,
  ctaTone = 'neutral',
  ctaDisabled = false,
  onCtaClick,
}: SubscriptionPlanCardProps) {
  const hasMetadata = plan.tags.length > 0 || plan.iconBadges.length > 0;

  return (
    <article className={`rvpb-subscription-card${selected ? ' is-selected' : ''}${active ? ' is-active' : ''}${plan.id === 'demo' ? ' is-demo' : ''}`}>
      <button
        type="button"
        className="rvpb-subscription-card__select"
        onClick={() => {
          logBillingUi('select-plan-card', {
            planId: plan.id,
            selected,
            active,
          });
          onSelect(plan.id);
        }}
        aria-pressed={selected}
      >
        <div className="rvpb-subscription-card__top">
          <span className={`rvpb-radio${selected ? ' is-selected' : ''}`} aria-hidden="true" />
          <div className="rvpb-subscription-card__copy">
            <div className="rvpb-subscription-card__title-row">
              <strong>{plan.name}</strong>
              <span>{plan.priceLabel}</span>
            </div>
            {hasMetadata ? (
              <div className="rvpb-subscription-card__chips">
                {plan.tags.map((tag) => (
                  <span key={tag} className="rvpb-chip">
                    {tag}
                  </span>
                ))}
                {plan.iconBadges.map((badge) => (
                  <span key={`${plan.id}-${badge.icon}`} className={`rvpb-icon-chip is-${badge.tone}`}>
                    <SvgV2Icon name={badge.icon} size={20} />
                  </span>
                ))}
              </div>
            ) : null}
            {plan.description ? <p className="rvpb-subscription-card__description">{plan.description}</p> : null}
          </div>
        </div>
      </button>

      {ctaLabel ? (
        <div className="rvpb-subscription-card__footer">
          <button
            type="button"
            className={`rvpb-inline-cta${ctaTone === 'danger' ? ' is-danger' : ''}`}
            disabled={ctaDisabled}
            onClick={(event) => {
              event.preventDefault();
              event.stopPropagation();
              logBillingUi('subscription-cta-click', {
                planId: plan.id,
                ctaLabel,
                ctaTone,
                ctaDisabled,
                selected,
                active,
                hasHandler: Boolean(onCtaClick),
              });
              void onCtaClick?.();
            }}
          >
            {ctaLabel}
          </button>
        </div>
      ) : null}
    </article>
  );
}