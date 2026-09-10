import { useState } from 'react';

import { useAppI18n } from '@/shared/i18n';
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
  const { t } = useAppI18n();
  const [openBadgeId, setOpenBadgeId] = useState<string | null>(null);

  const isNestedInteractiveTarget = (target: EventTarget | null, currentTarget: EventTarget | null) => {
    if (!(target instanceof HTMLElement) || !(currentTarget instanceof HTMLElement)) {
      return false;
    }

    const interactiveTarget = target.closest('button, a, input, select, textarea, [role="button"]');
    return interactiveTarget !== null && interactiveTarget !== currentTarget;
  };

  const selectPlan = () => {
    logBillingUi('select-plan-card', {
      planId: plan.id,
      selected,
      active,
    });
    onSelect(plan.id);
  };

  const effectiveCtaLabel = ctaLabel ?? plan.ctaDefaultLabel ?? plan.priceLabel;

  return (
    <article
      className={`rvpb-subscription-card${selected ? ' is-selected' : ''}${active ? ' is-active' : ''}${plan.highlighted ? ' is-highlighted' : ''}${plan.id === 'demo' ? ' is-demo' : ''}${openBadgeId ? ' has-open-popover' : ''}`}
      onClick={(event) => {
        if (isNestedInteractiveTarget(event.target, event.currentTarget)) {
          return;
        }
        selectPlan();
      }}
      onKeyDown={(event) => {
        if (isNestedInteractiveTarget(event.target, event.currentTarget) || (event.key !== 'Enter' && event.key !== ' ')) {
          return;
        }
        event.preventDefault();
        selectPlan();
      }}
      aria-pressed={selected}
      role="button"
      tabIndex={0}
    >
      {plan.highlighted ? (
        <div className="rvpb-subscription-card__badge-corner">
          <span>{t('Recommandé')}</span>
        </div>
      ) : null}

      <div className="rvpb-subscription-card__header">
        <div className="rvpb-subscription-card__header-info">
          <div className="rvpb-subscription-card__title-row">
            <h3>{t(plan.name)}</h3>
          </div>
          <div className="rvpb-subscription-card__price-line">
            <span className="rvpb-subscription-card__price">
              {plan.pricePrefix ? t(plan.pricePrefix) : ''}
              {t(plan.priceLabel)}
            </span>
            {plan.priceSuffix ? (
              <span className="rvpb-subscription-card__suffix">{t(plan.priceSuffix)}</span>
            ) : null}
          </div>
        </div>

        {plan.iconSrc ? (
          <div className="rvpb-subscription-card__icon-wrap">
            <img
              src={plan.iconSrc}
              alt={plan.iconAlt ? t(plan.iconAlt) : t(plan.name)}
              className="rvpb-subscription-card__icon-img"
              width={54}
              height={54}
              loading="lazy"
            />
          </div>
        ) : null}
      </div>

      <div className="rvpb-subscription-card__divider" />

      {plan.bullets && plan.bullets.length > 0 ? (
        <ul className="rvpb-subscription-card__bullets">
          {plan.bullets.map((bullet, idx) => (
            <li key={idx} className="rvpb-subscription-card__bullet-item">
              <span className="rvpb-subscription-card__bullet-icon" aria-hidden="true">
                <svg width="15" height="15" viewBox="0 0 16 16" fill="none" xmlns="http://www.w3.org/2000/svg">
                  <circle cx="8" cy="8" r="7" stroke="currentColor" strokeOpacity="0.45" strokeWidth="1.2" />
                  <path d="M5.2 8.2L7.2 10.2L11 6" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" />
                </svg>
              </span>
              <span className="rvpb-subscription-card__bullet-text">{t(bullet)}</span>
            </li>
          ))}
        </ul>
      ) : null}

      {/* Legacy icon badges if any */}
      {plan.iconBadges && plan.iconBadges.length > 0 ? (
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

      {effectiveCtaLabel ? (
        <div className="rvpb-subscription-card__footer">
          <button
            type="button"
            className={`rvpb-subscription-card__cta${plan.highlighted ? ' is-highlighted' : ''}${ctaTone === 'danger' ? ' is-danger' : ''}${active ? ' is-active-plan' : ''}`}
            disabled={ctaDisabled || (active && plan.id === 'demo')}
            onClick={(event) => {
              event.preventDefault();
              event.stopPropagation();
              if (active && plan.id === 'demo') return;
              logBillingUi('subscription-cta-click', {
                planId: plan.id,
                ctaLabel: effectiveCtaLabel,
                ctaTone,
                ctaDisabled,
                selected,
                active,
                hasHandler: Boolean(onCtaClick),
              });
              void onCtaClick?.();
            }}
          >
            {t(effectiveCtaLabel)}
          </button>
        </div>
      ) : null}
    </article>
  );
}