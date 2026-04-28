import type { ReactNode } from 'react';

type AccountSectionProps = {
  title: string;
  children: ReactNode;
};

export function AccountSection({ title, children }: AccountSectionProps) {
  return (
    <section className="rvpb-subscription-section rvpb-account-section">
      <div className="rvpb-subscription-section__label">
        <h2>{title}</h2>
      </div>

      <div className="rvpb-subscription-section__content rvpb-account-section__content">{children}</div>
    </section>
  );
}