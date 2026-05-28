/**
 * Sticky header of the Feuille-de-route / Timeline panel.
 *
 * Left:  view switcher (Feuille de route / Timeline) — segmented control.
 * Right: settings, split "add" button, fullscreen toggle.
 */
import type { MouseEventHandler } from 'react';
import { useAppI18n } from '@/shared/i18n';
import { IconMaximize } from '@/features/mapViewportControls/components/MapViewportControlIcons';
import {
  IconChevronDown,
  IconClockFastForward,
  IconLayoutGrid,
  IconPlusCircleFilled,
  IconSettings04,
} from '../../components/icons';
import type { TimelineView } from '../../types';

interface TimelineHeaderProps {
  view: TimelineView;
  onChangeView?: (v: TimelineView) => void;
  onOpenSettings?: () => void;
  settingsActive?: boolean;
  fullscreenActive?: boolean;
  onToggleFullscreen?: () => void;
  onAdd?: MouseEventHandler<HTMLButtonElement>;
  onOpenKindMenu?: MouseEventHandler<HTMLButtonElement>;
}

export function TimelineHeader({
  view,
  onChangeView,
  onOpenSettings,
  settingsActive,
  fullscreenActive,
  onToggleFullscreen,
  onAdd,
  onOpenKindMenu,
}: TimelineHeaderProps) {
  const { t } = useAppI18n();
  const openKindMenu = onOpenKindMenu ?? onAdd;

  return (
    <div className="rvi-tl-head">
      <div className="rvi-tl-tabs" role="tablist" aria-label={t('Vue de la feuille de route')}>
        <button
          type="button"
          role="tab"
          aria-selected={view === 'sheet'}
          className={`rvi-tl-tabs__btn${view === 'sheet' ? ' is-active' : ''}`}
          onClick={() => onChangeView?.('sheet')}
        >
          <span className="rvi-tl-tabs__label">{t('Feuille de route')}</span>
          <IconLayoutGrid size={12} />
        </button>
        <button
          type="button"
          role="tab"
          aria-selected={view === 'timeline'}
          className={`rvi-tl-tabs__btn${view === 'timeline' ? ' is-active' : ''}`}
          onClick={() => onChangeView?.('timeline')}
        >
          <span className="rvi-tl-tabs__label">{t('Timeline')}</span>
          <IconClockFastForward size={12} />
        </button>
      </div>

      <div className="rvi-tl-head__actions">
        <button
          type="button"
          className={`rvi-tl-tool${settingsActive ? ' is-active' : ''}`}
          onClick={onOpenSettings}
          aria-label={t('Paramètres de la feuille de route')}
          aria-pressed={settingsActive}
        >
          <IconSettings04 size={16} />
        </button>

        <span className="rvi-tl-add-split">
          <button
            type="button"
            className="rvi-tl-add-split__main"
            onClick={openKindMenu}
            aria-label={t('Ajouter un élément')}
          >
            <IconPlusCircleFilled size={16} />
          </button>
          <button
            type="button"
            className="rvi-tl-add-split__chevron"
            onClick={openKindMenu}
            aria-label={t("Choisir le type d'élément à ajouter")}
          >
            <IconChevronDown size={14} />
          </button>
        </span>

        <button
          type="button"
          className={`rvi-tl-tool${fullscreenActive ? ' is-active' : ''}`}
          onClick={onToggleFullscreen}
          aria-label={fullscreenActive ? t('Quitter le plein écran') : t('Ouvrir en plein écran')}
          aria-pressed={fullscreenActive}
        >
          <IconMaximize size={16} />
        </button>
      </div>
    </div>
  );
}
