import { useState } from 'react';

import { SvgV2Icon } from '@/shared/components/SvgV2Icon';
import { useAppI18n } from '@/shared/i18n';

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
  const { t } = useAppI18n();
  const [openBadgeId, setOpenBadgeId] = useState<string | null>(null);
  const hasMetadata = plan.tags.length > 0 || plan.iconBadges.length > 0;

  const isInteractiveTarget = (target: EventTarget | null) =>
    target instanceof HTMLElement &&
    Boolean(target.closest('button, a, input, select, textarea, [role="button"]'));

  const selectPlan = () => {
    logBillingUi('select-plan-card', {
      planId: plan.id,
      selected,
      active,
    });
    onSelect(plan.id);
  };

  return (
    <article
      className={`rvpb-subscription-card${selected ? ' is-selected' : ''}${active ? ' is-active' : ''}${plan.id === 'demo' ? ' is-demo' : ''}${openBadgeId ? ' has-open-popover' : ''}`}
      onClick={(event) => {
        if (isInteractiveTarget(event.target)) {
          return;
        }
        selectPlan();
      }}
      onKeyDown={(event) => {
        if (isInteractiveTarget(event.target) || (event.key !== 'Enter' && event.key !== ' ')) {
          return;
        }
        event.preventDefault();
        selectPlan();
      }}
      aria-pressed={selected}
      role="button"
      tabIndex={0}
    >
      <div className="rvpb-subscription-card__select">
        <div className="rvpb-subscription-card__top">
          <span className={`rvpb-radio${selected ? ' is-selected' : ''}`} aria-hidden="true" />
          <div className="rvpb-subscription-card__copy">
            <div className="rvpb-subscription-card__title-row">
              <strong>{t(plan.name)}</strong>
              <span>{t(plan.priceLabel)}</span>
            </div>
            {plan.description ? <p className="rvpb-subscription-card__description">{t(plan.description)}</p> : null}
          </div>
        </div>
      </div>

      {hasMetadata ? (
        <div className="rvpb-subscription-card__chips">
          {plan.tags.map((tag) => (
            <span key={tag} className="rvpb-chip">
              {t(tag)}
            </span>
          ))}
          {plan.iconBadges.map((badge) => {
            const isOpen = openBadgeId === badge.id;

            return (
              <span
                key={`${plan.id}-${badge.id}`}
                className={`rvpb-icon-chip-wrap is-${badge.tone}${isOpen ? ' is-open' : ''}`}
                onMouseEnter={() => setOpenBadgeId(badge.id)}
                onMouseLeave={() => setOpenBadgeId((current) => (current === badge.id ? null : current))}
              >
                <button
                  type="button"
                  className={`rvpb-icon-chip is-${badge.tone}`}
                  aria-label={t(badge.label)}
                  aria-expanded={isOpen}
                  onClick={(event) => {
                    event.preventDefault();
                    event.stopPropagation();
                    selectPlan();
                    setOpenBadgeId((current) => (current === badge.id ? null : badge.id));
                  }}
                  onFocus={() => setOpenBadgeId(badge.id)}
                  onBlur={(event) => {
                    if (event.currentTarget.parentElement?.contains(event.relatedTarget as Node | null)) {
                      return;
                    }
                    setOpenBadgeId((current) => (current === badge.id ? null : current));
                  }}
                >
                  <SvgV2Icon name={badge.icon} size={20} />
                </button>

                <span className="rvpb-feature-popover" role="tooltip" aria-hidden={!isOpen}>
                  {badge.featureItems.map((item) => (
                    <span key={`${badge.id}-${item.label}`} className="rvpb-feature-popover__item">
                      <SvgV2Icon name={item.icon} size={20} />
                      <span>{t(item.label)}</span>
                    </span>
                  ))}
                </span>
              </span>
            );
          })}
        </div>
      ) : null}

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
            {t(ctaLabel)}
          </button>
        </div>
      ) : null}
    </article>
  );
}