import type { ReactNode } from 'react';

import { SvgV2Icon } from '@/shared/components/SvgV2Icon';

import type { OverlayTab } from '../types';

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
    icon: <SvgV2Icon name="route.svg" size={16} />,
  },
  {
    id: 'account',
    label: 'Compte',
    icon: <SvgV2Icon name="user-circle.svg" size={16} />,
  },
  {
    id: 'subscription',
    label: 'Abonnement',
    icon: <SvgV2Icon name="credit-card-02.svg" size={16} />,
  },
  {
    id: 'settings',
    label: 'Réglages',
    icon: <SvgV2Icon name="settings-01.svg" size={16} />,
  },
];

export function TopTabs({ activeTab, onChange }: TopTabsProps) {
  return (
    <nav className="rvpb-top-tabs" aria-label="Navigation principale du menu projet">
      {TABS.map((tab) => (
        <button
          key={tab.id}
          type="button"
          className={`rvpb-top-tabs__item${activeTab === tab.id ? ' is-active' : ''}`}
          onClick={() => onChange(tab.id)}
        >
          {tab.icon}
          <span>{tab.label}</span>
        </button>
      ))}
    </nav>
  );
}