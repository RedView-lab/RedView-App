import { PanelSelect } from './PanelSelect';
import {
  IconCornerUpLeft,
  IconCornerUpRight,
  IconSave,
  IconChevronDown,
} from './icons';
import type { RouteProfile } from '../types';

interface ProfileBarProps {
  profiles: RouteProfile[];
  activeProfileId: string;
  onChange?: (id: string) => void;
  onUndo?: () => void;
  onRedo?: () => void;
  canUndo?: boolean;
  canRedo?: boolean;
  onSave?: () => void;
  onOpenExpert?: () => void;
  expertActive?: boolean;
}

export function ProfileBar({
  profiles,
  activeProfileId,
  onChange,
  onUndo,
  onRedo,
  canUndo,
  canRedo,
  onSave,
  onOpenExpert,
  expertActive,
}: ProfileBarProps) {
  return (
    <div className="rvi-profile">
      <div className="rvi-profile__select">
        <PanelSelect
          wide
          value={activeProfileId}
          options={profiles.map((p) => ({ value: p.id, label: p.name }))}
          onChange={onChange}
          ariaLabel="Profil de routage"
        />
      </div>
      {onOpenExpert ? (
        <button
          type="button"
          className={`rvi-expert-pillbtn${expertActive ? ' is-active' : ''}`}
          onClick={onOpenExpert}
          title="Mode Expert — personnaliser tous les paramètres BRouter"
        >
          {expertActive ? '★ Expert' : 'Expert'}
        </button>
      ) : null}
      <button
        type="button"
        className="rvi-ghostbtn"
        onClick={onUndo}
        aria-label="Annuler"
        aria-disabled={!canUndo}
      >
        <IconCornerUpLeft size={16} />
      </button>
      <button
        type="button"
        className="rvi-ghostbtn"
        onClick={onRedo}
        aria-label="Rétablir"
        aria-disabled={!canRedo}
      >
        <IconCornerUpRight size={16} />
      </button>
      <button
        type="button"
        className="rvi-redbtn"
        onClick={onSave}
        aria-label="Enregistrer le profil"
      >
        <IconSave size={16} />
        <IconChevronDown size={14} />
      </button>
    </div>
  );
}
