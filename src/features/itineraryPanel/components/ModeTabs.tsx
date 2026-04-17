import type { PanelMode } from '../types';
import {
  IconRoute,
  IconStopwatch,
  IconMapPin,
  IconNutrition,
} from './icons';

interface ModeTabsProps {
  active: PanelMode;
  onChange?: (mode: PanelMode) => void;
}

const TABS: { id: PanelMode; label: string; Icon: typeof IconRoute }[] = [
  { id: 'tracage', label: 'Traçage', Icon: IconRoute },
  { id: 'rythme', label: 'Rythme', Icon: IconStopwatch },
  { id: 'poi', label: 'POI', Icon: IconMapPin },
  { id: 'nutrition', label: 'Nutrition', Icon: IconNutrition },
];

export function ModeTabs({ active, onChange }: ModeTabsProps) {
  return (
    <nav className="rvi-modes" aria-label="Mode d'édition">
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
          {label}
        </button>
      ))}
    </nav>
  );
}
