import { SvgV2Icon } from '@/components/SvgV2Icon';

import type { SubscriptionPlanId, SubscriptionPlan } from './types';

type SubscriptionPlanCardProps = {
  plan: SubscriptionPlan;
  selected: boolean;
  active: boolean;
  onSelect: (planId: SubscriptionPlanId) => void;
  ctaLabel?: string;
  ctaTone?: 'danger' | 'neutral';
  ctaDisabled?: boolean;
  onCtaClick?: () => void | Promise<void>;
  ctaHelper?: string;
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
  ctaHelper,
}: SubscriptionPlanCardProps) {
  return (
    <article className={`rvpb-subscription-card${selected ? ' is-selected' : ''}${active ? ' is-active' : ''}`}>
      <button
        type="button"
        className="rvpb-subscription-card__select"
        onClick={() => onSelect(plan.id)}
        aria-pressed={selected}
      >
        <div className="rvpb-subscription-card__top">
          <span className={`rvpb-radio${selected ? ' is-selected' : ''}`} aria-hidden="true" />
          <div className="rvpb-subscription-card__copy">
            <div className="rvpb-subscription-card__title-row">
              <strong>{plan.name}</strong>
              <span>{plan.priceLabel}</span>
            </div>
            <div className="rvpb-subscription-card__chips">
              {plan.tags.map((tag) => (
                <span key={tag} className="rvpb-chip">
                  {tag}
                </span>
              ))}
              {plan.iconBadges.map((badge) => (
                <span key={`${plan.id}-${badge.icon}`} className={`rvpb-icon-chip is-${badge.tone}`}>
                  <SvgV2Icon name={badge.icon} size={14} />
                </span>
              ))}
            </div>
            <p className="rvpb-subscription-card__description">{plan.description}</p>
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
              void onCtaClick?.();
            }}
          >
            {ctaLabel}
          </button>
          {ctaHelper ? <span className="rvpb-inline-note">{ctaHelper}</span> : null}
        </div>
      ) : null}
    </article>
  );
}