import {
  IconCheck,
  IconMinus,
  IconPlus,
  IconStar,
} from '../../components/icons';
import { useAppI18n } from '@/shared/i18n';
import { KindBadge } from './KindBadge';
import type { TimelineFilterState } from './TimelineFilters';
import { TimelineSelect, type TimelineSelectOption } from './TimelineSelect';

interface TimelineEditPanelProps {
  filters: TimelineFilterState;
  markerStepKm: number;
  zoomLevel: number;
  onChangeFilters?: (next: TimelineFilterState) => void;
  onChangeMarkerStepKm?: (next: number) => void;
  onChangeZoomLevel?: (next: number) => void;
}

const MARKER_STEP_OPTIONS: readonly TimelineSelectOption<number>[] = [
  { value: 10, label: '10km' },
  { value: 25, label: '25km' },
  { value: 50, label: '50km' },
  { value: 100, label: '100km' },
];
const SCALE_OPTIONS: readonly TimelineSelectOption<string>[] = [
  { value: 'Date', label: 'Date' },
];
const ZOOM_MIN = 0.75;
const ZOOM_MAX = 1.5;
const ZOOM_STEP = 0.25;

const FILTER_CHIPS: Array<{
  key: keyof TimelineFilterState;
  label: string;
  renderIcon: () => React.ReactNode;
}> = [
  {
    key: 'etape',
    label: 'Étape',
    renderIcon: () => <KindBadge kind="start" size={20} />,
  },
  {
    key: 'waypoint',
    label: 'Waypoint',
    renderIcon: () => <KindBadge kind="waypoint" size={20} />,
  },
  {
    key: 'poi',
    label: 'POI',
    renderIcon: () => <KindBadge kind="water" size={20} />,
  },
  {
    key: 'pause',
    label: 'Pause',
    renderIcon: () => <KindBadge kind="pause" size={20} />,
  },
  {
    key: 'favorite',
    label: 'Favoris',
    renderIcon: () => (
      <span className="rvi-tl-edit__favorite-icon" aria-hidden>
        <IconStar size={12} />
      </span>
    ),
  },
];

function clampZoom(value: number): number {
  return Math.min(ZOOM_MAX, Math.max(ZOOM_MIN, Number(value.toFixed(2))));
}

export function TimelineEditPanel({
  filters,
  markerStepKm,
  zoomLevel,
  onChangeFilters,
  onChangeMarkerStepKm,
  onChangeZoomLevel,
}: TimelineEditPanelProps) {
  const { t } = useAppI18n();
  const toggleFilter = (key: keyof TimelineFilterState) => {
    onChangeFilters?.({ ...filters, [key]: !filters[key] });
  };

  return (
    <section className="rvi-tl-edit" aria-label={t('Paramètres de la timeline')}>
      <div className="rvi-tl-edit__controls">
        <div className="rvi-tl-edit__field">
          <span className="rvi-tl-edit__field-label">{t('Échelle')}</span>
          <TimelineSelect
            value="Date"
            options={SCALE_OPTIONS}
            ariaLabel={t('Échelle de la timeline')}
          />
        </div>

        <div className="rvi-tl-edit__field">
          <span className="rvi-tl-edit__field-label">{t('Repère')}</span>
          <TimelineSelect
            value={markerStepKm}
            options={MARKER_STEP_OPTIONS}
            onChange={onChangeMarkerStepKm}
            ariaLabel={t('Repère kilométrique')}
          />
        </div>

        <div className="rvi-tl-edit__zoom" aria-label={t('Zoom de la timeline')}>
          <span className="rvi-tl-edit__field-label">{t('Zoom')}</span>
          <div className="rvi-tl-edit__zoom-actions">
            <button
              type="button"
              className="rvi-tl-edit__zoom-btn"
              onClick={() => onChangeZoomLevel?.(clampZoom(zoomLevel - ZOOM_STEP))}
              disabled={zoomLevel <= ZOOM_MIN}
              aria-label={t('Réduire le zoom')}
            >
              <IconMinus size={14} />
            </button>
            <button
              type="button"
              className="rvi-tl-edit__zoom-btn"
              onClick={() => onChangeZoomLevel?.(clampZoom(zoomLevel + ZOOM_STEP))}
              disabled={zoomLevel >= ZOOM_MAX}
              aria-label={t('Augmenter le zoom')}
            >
              <IconPlus size={14} />
            </button>
          </div>
        </div>
      </div>

      <div className="rvi-tl-edit__chips" role="group" aria-label={t('Filtres de la timeline')}>
        {FILTER_CHIPS.map((chip) => {
          const active = filters[chip.key];
          return (
            <button
              key={chip.key}
              type="button"
              className={`rvi-tl-edit__chip${active ? ' is-on' : ''}`}
              aria-pressed={active}
              onClick={() => toggleFilter(chip.key)}
            >
              <span className="rvi-tl-edit__chip-check" aria-hidden>
                {active ? <IconCheck size={10} /> : null}
              </span>
              <span className="rvi-tl-edit__chip-label">{t(chip.label)}</span>
              <span className="rvi-tl-edit__chip-icon" aria-hidden>
                {chip.renderIcon()}
              </span>
            </button>
          );
        })}
      </div>

      <div className="rvi-tl-edit__divider" aria-hidden />
    </section>
  );
}