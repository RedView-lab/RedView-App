/**
 * Section « Tableau » de la feuille de route — nœud Figma 855:22688.
 *
 * Affiche une seule barre de contrôles horizontale :
 *   Points de passages automatiques  [10 km ▾]   ⊕ Ajouter des colonnes ▾
 *
 * Comme les filtres au-dessus, le composant est entièrement contrôlé. Les
 * valeurs vivent dans le parent (ou dans ItineraryPanelContainer une fois
 * branché) pour pouvoir persister les préférences de l'utilisateur avec le
 * reste de l'état du projet.
 */
import { useState, type MouseEvent } from 'react';
import { IconChevronDown, IconPlusCircle } from '../../components/icons';
import { useAppI18n } from '@/shared/i18n';
import type { SportDiscipline } from '@/shared/lib/discipline';
import { resolveTimelineColumns, type TimelineColumnId } from './TimelineColumns';
import { TimelineColumnsMenu } from './TimelineColumnsMenu.tsx';
import { DEFAULT_TIMELINE_TABLE_SETTINGS, type TimelineTableSettingsState } from './timelineTableSettingsState';

interface TimelineTableSettingsProps {
  /** Trail / course : libellés d'allure, pas de colonnes de puissance. */
  discipline?: SportDiscipline;
  value?: TimelineTableSettingsState;
  onChange?: (next: TimelineTableSettingsState) => void;
}

export function TimelineTableSettings({
  discipline = 'bike',
  value = DEFAULT_TIMELINE_TABLE_SETTINGS,
  onChange,
}: TimelineTableSettingsProps) {
  const { t } = useAppI18n();
  const [triggerEl, setTriggerEl] = useState<HTMLButtonElement | null>(null);
  const [menuOpen, setMenuOpen] = useState(false);

  const setField = <K extends keyof TimelineTableSettingsState>(
    key: K,
    next: TimelineTableSettingsState[K],
  ) => {
    onChange?.({ ...value, [key]: next });
  };

  const handleToggleColumn = (id: TimelineColumnId, on: boolean) => {
    const nextColumns: Record<TimelineColumnId, boolean> = {
      ...value.columns,
      [id]: on,
    };
    // Si l'utilisateur a masqué la colonne en cours de tri, abandonner le tri.
    let nextSort = value.sort;
    if (!on && value.sort?.columnId === id) nextSort = null;
    onChange?.({ ...value, columns: nextColumns, sort: nextSort });
  };

  const handleOpenMenu = (event: MouseEvent<HTMLButtonElement>) => {
    event.preventDefault();
    setMenuOpen((cur) => !cur);
  };

  return (
    <div className="rvi-tl-table" aria-label="Tableau">
      <div className="rvi-tl-table__bar">
        <div className={`rvi-tl-table__auto${value.distanceBetweenWaypoints ? ' is-on' : ''}`}>
          <span className="rvi-tl-table__auto-label">
            <span className="rvi-tl-table__auto-label--full">{t('Points de passage automatiques')}</span>
            <span className="rvi-tl-table__auto-label--short">{t('Passages auto.')}</span>
          </span>
          <span className="rvi-tl-table__auto-value">
            <button
              type="button"
              className="rvi-tl-table__auto-value-btn"
              onClick={() => setField('distanceBetweenWaypoints', !value.distanceBetweenWaypoints)}
              aria-pressed={value.distanceBetweenWaypoints}
              aria-label={t('Distance entre waypoints : {{value}} km', { value: value.distanceKm })}
            >
              <span>{value.distanceKm} km</span>
              <IconChevronDown size={14} />
            </button>
          </span>
        </div>

        <button
          ref={setTriggerEl}
          type="button"
          className="rvi-tl-table__columns"
          onClick={handleOpenMenu}
          aria-haspopup="menu"
          aria-expanded={menuOpen}
        >
          <IconPlusCircle size={15} />
          <span className="rvi-tl-table__columns-label--full">{t('Ajouter des colonnes')}</span>
          <span className="rvi-tl-table__columns-label--short">{t('Colonnes')}</span>
          <IconChevronDown size={14} />
        </button>
      </div>

      <TimelineColumnsMenu
        anchorEl={triggerEl}
        open={menuOpen}
        columns={resolveTimelineColumns(discipline)}
        visibility={value.columns}
        onToggle={handleToggleColumn}
        onClose={() => setMenuOpen(false)}
      />
    </div>
  );
}
