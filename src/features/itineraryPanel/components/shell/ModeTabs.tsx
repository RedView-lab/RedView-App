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
   * À true, tout le menu des modes est inerte : aucun onglet sélectionné, chaque
   * onglet désactivé et les réglages dessous repliés. Utilisé sur un tout
   * nouveau projet qui n'a pas encore d'itinéraire — il n'y a rien à éditer.
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
