import { RedViewLogo } from '@/shared/components/RedViewLogo';

export function RedViewWordmark() {
  return (
    <div className="rvpb-billing-page__brand" aria-label="RedView">
      <RedViewLogo className="rvpb-billing-page__brand-image" width={125} height={24} />
    </div>
  );
}
