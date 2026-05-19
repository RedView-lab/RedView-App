/**
 * "Filtres" section of the Feuille de route — Figma node 1694:18364.
 *
 * Renders the small "Filtres" eyebrow label followed by a wrap-grid of
 * filter chips. Each chip = checkbox + 20px kind badge + label.
 *
 * The component is fully controlled: `value` holds the four booleans, and
 * `onChange` reports a new state. Keeping it stateless lets the parent wire
 * filtering logic / persistence later without touching the UI.
 */
import { KindBadge } from './KindBadge';
import { IconStar } from '../../components/icons';
import { useAppI18n } from '@/shared/i18n';

export interface TimelineFilterState {
  etape: boolean;
  waypoint: boolean;
  poi: boolean;
  pause: boolean;
  favorite: boolean;
}

export const DEFAULT_TIMELINE_FILTER: TimelineFilterState = {
  etape: true,
  waypoint: true,
  poi: true,
  pause: true,
  favorite: true,
};

interface TimelineFiltersProps {
  value?: TimelineFilterState;
  onChange?: (next: TimelineFilterState) => void;
}

const CHIPS: Array<{
  key: keyof TimelineFilterState;
  label: string;
  badge: 'start' | 'waypoint' | 'water' | 'pause' | 'favorite';
}> = [
  { key: 'etape',    label: 'Étape',    badge: 'start' },
  { key: 'waypoint', label: 'Waypoint', badge: 'waypoint' },
  { key: 'poi',      label: 'POI',      badge: 'water' },
  { key: 'pause',    label: 'Pause',    badge: 'pause' },
  { key: 'favorite', label: 'Favoris',  badge: 'favorite' },
];

export function TimelineFilters({
  value = DEFAULT_TIMELINE_FILTER,
  onChange,
}: TimelineFiltersProps) {
  const { t } = useAppI18n();
  const toggle = (key: keyof TimelineFilterState) => {
    onChange?.({ ...value, [key]: !value[key] });
  };

  return (
    <div className="rvi-tl-filters" aria-label={t('Filtres de la feuille de route')}>
      <span className="rvi-tl-filters__label">{t('Filtres')}</span>
      <div className="rvi-tl-filters__chips">
        {CHIPS.map((chip) => {
          const active = value[chip.key];
          const badge = chip.badge === 'favorite'
            ? (
                <span className="rvi-tl-chip__favorite-badge" aria-hidden>
                  <IconStar size={12} />
                </span>
              )
            : (
                <KindBadge kind={chip.badge} size={20} />
              );

          return (
            <label
              key={chip.key}
              className={`rvi-tl-chip${active ? ' is-on' : ''}`}
            >
              <input
                type="checkbox"
                checked={active}
                onChange={() => toggle(chip.key)}
              />
              <span className="rvi-tl-chip__check" aria-hidden />
              <span className="rvi-tl-chip__label">{t(chip.label)}</span>
              <span className="rvi-tl-chip__badge">{badge}</span>
            </label>
          );
        })}
      </div>
    </div>
  );
}
