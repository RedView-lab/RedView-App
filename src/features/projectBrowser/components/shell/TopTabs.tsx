import type { ReactNode } from 'react';

import { SvgV2Icon } from '@/shared/components/SvgV2Icon';
import { useAppI18n } from '@/shared/i18n';

import type { OverlayTab } from '../../types';

type TopTabsProps = {
  activeTab: OverlayTab;
  onChange: (tab: OverlayTab) => void;
};

const TABS: Array<{
  id: OverlayTab;
  label: string;
  icon: ReactNode;
}> = [
  {
    id: 'projects',
    label: 'Projets',
    icon: <SvgV2Icon name="route.svg" size={20} />,
  },
  {
    id: 'account',
    label: 'Compte',
    icon: <SvgV2Icon name="user-circle.svg" size={20} />,
  },
  {
    id: 'subscription',
    label: 'Abonnement',
    icon: <SvgV2Icon name="credit-card-02.svg" size={20} />,
  },
  {
    id: 'settings',
    label: 'Réglages',
    icon: <SvgV2Icon name="settings-02.svg" size={20} />,
  },
];

export function TopTabs({ activeTab, onChange }: TopTabsProps) {
  const { t } = useAppI18n();

  return (
    <nav className="rvpb-top-tabs" aria-label={t('Navigation principale du menu projet')}>
      {TABS.map((tab) => (
        <button
          key={tab.id}
          type="button"
          className={`rvpb-top-tabs__item${activeTab === tab.id ? ' is-active' : ''}`}
          onClick={() => onChange(tab.id)}
        >
          {tab.icon}
          <span>{t(tab.label)}</span>
        </button>
      ))}
    </nav>
  );
}