import { RedViewLogo } from '@/shared/components/RedViewLogo';

export type BillingPaymentMethod = 'card' | 'paypal';

export const COUNTRY_FLAG_BASE_PATH = '/flags';

export function CardMethodIcon() {
  return (
    <svg viewBox="0 0 24 24" aria-hidden="true" className="rvpb-billing-page__method-icon-svg">
      <rect x="3" y="5" width="18" height="14" rx="2.5" fill="none" stroke="currentColor" strokeWidth="1.8" />
      <path d="M3 10.5H21" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" />
      <path d="M7 15H12" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" />
    </svg>
  );
}

export function PayPalMethodIcon() {
  return (
    <svg viewBox="0 0 24 24" width="22" height="22" fill="none" aria-hidden="true">
      <path
        fillRule="evenodd"
        clipRule="evenodd"
        d="M5 2.5h6.5c2.6 0 4.6 1.3 4.2 3.8-.4 2.4-2.4 3.8-4.9 3.8H8.8l-.8 5.2H5L7.3 2.5zm2.5 5h3.2c1.3 0 2.3-.6 2.5-1.8.3-1.2-.6-1.9-1.9-1.9H7.6L7.5 7.5z"
        fill="#003087"
      />
      <path
        fillRule="evenodd"
        clipRule="evenodd"
        d="M7.8 6.2h6.5c2.6 0 4.6 1.3 4.2 3.8-.4 2.4-2.4 3.8-4.9 3.8h-2L10.8 19H7.8l2.3-12.8zm2.5 5h3.2c1.3 0 2.3-.6 2.5-1.8.3-1.2-.6-1.9-1.9-1.9h-2.2l-.7 3.7z"
        fill="#0079C1"
      />
    </svg>
  );
}

export function RedViewWordmark() {
  return (
    <div className="rvpb-billing-page__brand" aria-label="RedView">
      <RedViewLogo className="rvpb-billing-page__brand-image" width={125} height={24} />
    </div>
  );
}
