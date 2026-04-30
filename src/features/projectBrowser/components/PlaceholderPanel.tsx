import { SvgV2Icon } from '@/shared/components/SvgV2Icon';

import { LANDING_URL } from '../lib/subscription';

type PlaceholderPanelProps = {
  title: string;
  description: string;
};

export function PlaceholderPanel({ title, description }: PlaceholderPanelProps) {
  return (
    <section className="rvpb-panel-placeholder" aria-label={title}>
      <div>
        <div className="rvpb-panel-placeholder__icon">
          <SvgV2Icon name="settings-04.svg" size={20} />
        </div>
        <h2>{title}</h2>
        <p>{description}</p>
        <a href={`${LANDING_URL}/pricing`} className="rvpb-panel-placeholder__link">
          Ouvrir RedView Web
        </a>
      </div>
    </section>
  );
}