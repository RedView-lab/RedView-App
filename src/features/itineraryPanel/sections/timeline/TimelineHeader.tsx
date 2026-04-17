/**
 * Sticky header of the Feuille-de-route / Timeline panel.
 *
 * Left:  view switcher (Feuille de route / Timeline) — segmented control.
 * Right: search, settings, split "add" button (plus + chevron).
 */
import {
  IconChevronDown,
  IconClockFastForward,
  IconLayoutGrid,
  IconPlusCircle,
  IconSearch,
  IconSettingsSliders,
} from '../../components/icons';
import type { TimelineView } from '../../types';

interface TimelineHeaderProps {
  view: TimelineView;
  onChangeView?: (v: TimelineView) => void;
  onSearch?: () => void;
  onOpenSettings?: () => void;
  onAdd?: () => void;
  onOpenKindMenu?: () => void;
}

export function TimelineHeader({
  view,
  onChangeView,
  onSearch,
  onOpenSettings,
  onAdd,
  onOpenKindMenu,
}: TimelineHeaderProps) {
  return (
    <div className="rvi-tl-head">
      <div className="rvi-tl-tabs" role="tablist" aria-label="Vue de la feuille de route">
        <button
          type="button"
          role="tab"
          aria-selected={view === 'sheet'}
          className={`rvi-tl-tabs__btn${view === 'sheet' ? ' is-active' : ''}`}
          onClick={() => onChangeView?.('sheet')}
        >
          <span className="rvi-tl-tabs__label">Feuille de route</span>
          <IconLayoutGrid size={12} />
        </button>
        <button
          type="button"
          role="tab"
          aria-selected={view === 'timeline'}
          className={`rvi-tl-tabs__btn${view === 'timeline' ? ' is-active' : ''}`}
          onClick={() => onChangeView?.('timeline')}
        >
          <span className="rvi-tl-tabs__label">Timeline</span>
          <IconClockFastForward size={12} />
        </button>
      </div>

      <button
        type="button"
        className="rvi-tl-tool"
        onClick={onSearch}
        aria-label="Rechercher"
      >
        <IconSearch size={14} />
      </button>
      <button
        type="button"
        className="rvi-tl-tool"
        onClick={onOpenSettings}
        aria-label="Paramètres de la feuille de route"
      >
        <IconSettingsSliders size={14} />
      </button>

      <span className="rvi-tl-add-split">
        <button
          type="button"
          className="rvi-tl-add-split__main"
          onClick={onAdd}
          aria-label="Ajouter un élément"
        >
          <IconPlusCircle size={16} />
        </button>
        <button
          type="button"
          className="rvi-tl-add-split__chevron"
          onClick={onOpenKindMenu}
          aria-label="Choisir le type d'élément à ajouter"
        >
          <IconChevronDown size={14} />
        </button>
      </span>
    </div>
  );
}
