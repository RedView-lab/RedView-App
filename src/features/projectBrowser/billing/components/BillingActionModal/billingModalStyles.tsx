import { useAppI18n } from '@/shared/i18n';
import type { AccountSelectOption } from '../../../account/components';

export type BillingPaymentMethod = 'card' | 'amazon_pay';

export const COUNTRY_FLAG_BASE_PATH = '/landing/svg';

export function findCountryOption(countryCode: string, options: readonly AccountSelectOption[]) {
  return options.find((option) => option.value === countryCode);
}

export function CountryFlag({ option }: { option?: AccountSelectOption }) {
  if (!option?.flagCode) {
    return <span className="rvpb-account-flag rvpb-account-flag--fallback" aria-hidden="true" />;
  }

  return (
    <span className="rvpb-account-flag" aria-hidden="true">
      <img
        className="rvpb-account-flag__image"
        src={`${COUNTRY_FLAG_BASE_PATH}/${option.flagCode}.svg`}
        alt=""
        loading="lazy"
      />
    </span>
  );
}

export const stripeCardElementStyle = {
  base: {
    color: '#ffffff',
    fontFamily: 'Rethink Sans, system-ui, sans-serif',
    fontSize: '16px',
    fontSmoothing: 'antialiased',
    '::placeholder': {
      color: 'rgba(255, 255, 255, 0.48)',
    },
    iconColor: 'rgba(255, 255, 255, 0.88)',
  },
  invalid: {
    color: '#ffb4b4',
    iconColor: '#ffb4b4',
  },
};

export const appearance = {
  theme: 'night' as const,
  labels: 'above' as const,
  variables: {
    colorPrimary: '#890000',
    colorBackground: '#141414',
    colorText: '#ffffff',
    colorDanger: '#ff8e8e',
    colorTextPlaceholder: '#8c8c8c',
    colorTextSecondary: '#c7c7c7',
    colorIcon: '#d1d1d1',
    colorSuccess: '#34d399',
    borderRadius: '8px',
    spacingUnit: '4px',
    fontFamily: 'Rethink Sans, system-ui, sans-serif',
  },
  rules: {
    '.AccordionItem': {
      backgroundColor: 'rgba(255,255,255,0.04)',
      border: '1px solid rgba(255,255,255,0.16)',
      boxShadow: 'none',
    },
    '.Tab': {
      backgroundColor: 'rgba(255,255,255,0.04)',
      border: '1px solid rgba(255,255,255,0.16)',
      color: '#ffffff',
      boxShadow: 'none',
      padding: '12px 16px',
    },
    '.Tab:hover': {
      color: '#ffffff',
      backgroundColor: 'rgba(255,255,255,0.04)',
    },
    '.Tab--selected': {
      backgroundColor: 'rgba(255,255,255,0.04)',
      borderColor: 'rgba(255,255,255,0.28)',
      boxShadow: 'inset 0 0 0 1px rgba(255,255,255,0.08)',
    },
    '.TabLabel': {
      color: '#ffffff',
      fontWeight: '500',
      fontSize: '14px',
    },
    '.Input': {
      backgroundColor: 'rgba(255,255,255,0.08)',
      border: '1px solid rgba(213,215,218,0.16)',
      boxShadow: '0 1px 2px rgba(10,13,18,0.05)',
    },
    '.Block': {
      backgroundColor: 'rgba(255,255,255,0.08)',
      border: '1px solid rgba(213,215,218,0.16)',
      boxShadow: '0 1px 2px rgba(10,13,18,0.05)',
    },
    '.CodeInput': {
      backgroundColor: 'rgba(255,255,255,0.08)',
      border: '1px solid rgba(213,215,218,0.16)',
      boxShadow: '0 1px 2px rgba(10,13,18,0.05)',
    },
    '.Input:focus': {
      borderColor: 'rgba(137,0,0,0.9)',
      boxShadow: '0 0 0 1px rgba(137,0,0,0.65)',
    },
    '.CodeInput:focus': {
      borderColor: 'rgba(137,0,0,0.9)',
      boxShadow: '0 0 0 1px rgba(137,0,0,0.65)',
    },
    '.Label': {
      color: '#ffffff',
      fontWeight: '600',
      fontSize: '15px',
    },
    '.Text': {
      color: 'rgba(255,255,255,0.74)',
    },
    '.Error': {
      color: '#ffb4b4',
    },
  },
};

export function CardMethodIcon() {
  return (
    <svg viewBox="0 0 24 24" aria-hidden="true" className="rvpb-billing-page__method-icon-svg">
      <rect x="3" y="5" width="18" height="14" rx="2.5" fill="none" stroke="currentColor" strokeWidth="1.8" />
      <path d="M3 10.5H21" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" />
      <path d="M7 15H12" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" />
    </svg>
  );
}

export function PaymentMethodTile({
  method,
  selected,
  onSelect,
}: {
  method: BillingPaymentMethod;
  selected: boolean;
  onSelect: (method: BillingPaymentMethod) => void;
}) {
  const { t } = useAppI18n();
  const title = method === 'card' ? t('Carte Bancaire') : t('Amazon Pay');

  return (
    <button
      type="button"
      className={`rvpb-billing-page__method-tile rvpb-billing-page__method-tile--${method.replace('_', '-')}${selected ? ' rvpb-billing-page__method-tile--selected' : ''}`}
      onClick={() => onSelect(method)}
      role="radio"
      aria-checked={selected}
    >
      <span className="rvpb-billing-page__method-radio" aria-hidden="true">
        <span className="rvpb-billing-page__method-radio-dot" />
      </span>
      <span className="rvpb-billing-page__method-title">{title}</span>
      <span
        className={`rvpb-billing-page__method-icon${method === 'amazon_pay' ? ' rvpb-billing-page__method-icon--amazon' : ''}`}
        aria-hidden="true"
      >
        {method === 'card' ? (
          <CardMethodIcon />
        ) : (
          <span className="rvpb-billing-page__amazon-pay-wordmark">pay</span>
        )}
      </span>
    </button>
  );
}

export function RedViewWordmark() {
  return (
    <div className="rvpb-billing-page__brand" aria-label="RedView">
      <img
        className="rvpb-billing-page__brand-image"
        src="/landing/icons/redview-logo.svg"
        alt="RedView"
        width={125}
        height={24}
      />
    </div>
  );
}
