import type { ReactNode } from 'react';

import {
  IconMapPin,
  IconRoute,
  IconStopwatch,
} from '@/features/itineraryPanel/components/icons';
import { SvgV2Icon } from '@/components/SvgV2Icon';

import type { OverlayTab } from './types';

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
    id: 'demo',
    label: 'Demo',
    icon: <SvgV2Icon name="layers-three-02.svg" size={16} />,
  },
  {
    id: 'projects',
    label: 'Projets',
    icon: <IconRoute size={13.333} />,
  },
  {
    id: 'account',
    label: 'Compte',
    icon: <IconStopwatch size={16} />,
  },
  {
    id: 'subscription',
    label: 'Abonnement',
    icon: <SvgV2Icon name="user-circle.svg" size={16} />,
  },
  {
    id: 'settings',
    label: 'Réglages',
    icon: <IconMapPin size={16} />,
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