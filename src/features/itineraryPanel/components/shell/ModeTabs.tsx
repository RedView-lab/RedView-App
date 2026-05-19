import type { ComponentType } from 'react';
import { useAppI18n } from '@/shared/i18n';
import type { PanelMode } from '../../types';
import {
  IconRoute,
  IconStopwatch,
  IconMapPin,
} from '../icons';

interface ModeTabsProps {
  active: PanelMode;
  onChange?: (mode: PanelMode) => void;
}

const TABS: { id: PanelMode; label: string; Icon: ComponentType<{ size?: number }> }[] = [
  { id: 'tracage', label: 'Traçage', Icon: IconRoute },
  { id: 'rythme', label: 'Rythme', Icon: IconStopwatch },
  { id: 'poi', label: 'POI', Icon: IconMapPin },
];

export function ModeTabs({ active, onChange }: ModeTabsProps) {
  const { t } = useAppI18n();

  return (
    <nav className="rvi-modes" aria-label={t("Mode d'édition")}>
      {TABS.map(({ id, label, Icon }) => (
        <button
          key={id}
          type="button"
          className={`rvi-mode${active === id ? ' is-active' : ''}`}
          onClick={() => onChange?.(id)}
        >
          <span className="rvi-mode__icon">
            <Icon size={16} />
          </span>
          {t(label)}
        </button>
      ))}
    </nav>
  );
}
