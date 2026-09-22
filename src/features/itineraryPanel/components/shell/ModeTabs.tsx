import type { ComponentType } from 'react';
import { useAppI18n } from '@/shared/i18n';
import type { PanelMode } from '../../types';
import {
  IconRoute,
  IconStopwatch,
  IconMapPin,
} from '../icons';

type VisiblePanelMode = Exclude<PanelMode, 'nutrition'>;

interface ModeTabsProps {
  active: VisiblePanelMode;
  collapsed?: boolean;
  controlsId?: string;
  onChange?: (mode: VisiblePanelMode) => void;
  /**
   * When true the whole mode menu is inert: no tab is selected, every tab is
   * disabled and the settings below are collapsed. Used on a brand-new project
   * that has no itinerary yet — there is nothing to edit.
   */
  disabled?: boolean;
}

const TABS: { id: VisiblePanelMode; label: string; Icon: ComponentType<{ size?: number }> }[] = [
  { id: 'tracage', label: 'Traçage', Icon: IconRoute },
  { id: 'rythme', label: 'Rythme', Icon: IconStopwatch },
  { id: 'poi', label: 'POI', Icon: IconMapPin },
];

export function ModeTabs({
  active,
  collapsed = false,
  controlsId,
  onChange,
  disabled = false,
}: ModeTabsProps) {
  const { t } = useAppI18n();

  return (
    <nav className="rvi-modes" aria-label={t("Mode d'édition")}>
      {TABS.map(({ id, label, Icon }) => {
        const isActive = !disabled && active === id;
        const isExpanded = isActive && !collapsed;
        return (
          <button
            key={id}
            type="button"
            className={`rvi-mode${isActive ? ' is-active' : ''}${isActive && collapsed ? ' is-collapsed' : ''}`}
            onClick={() => onChange?.(id)}
            disabled={disabled}
            aria-expanded={isExpanded}
            aria-controls={controlsId}
            title={isActive ? (isExpanded ? t('Cliquer pour replier les réglages') : t('Cliquer pour rouvrir les réglages')) : undefined}
          >
            <span className="rvi-mode__icon">
              <Icon size={16} />
            </span>
            {t(label)}
          </button>
        );
      })}
    </nav>
  );
}
