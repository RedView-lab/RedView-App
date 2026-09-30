import { IconMinus, IconPlus } from '../../components/icons';
import { useAppI18n } from '@/shared/i18n';
import { TimelineFilterBar } from './TimelineFilterBar';
import type { TimelineFilterState } from './TimelineFilters';
import { TimelineSelect, type TimelineSelectOption } from './TimelineSelect';

interface TimelineEditPanelProps {
  filters: TimelineFilterState;
  /** True quand la timeline a ses propres filtres au lieu des filtres globaux. */
  isFiltersOverridden: boolean;
  markerStepKm: number;
  zoomLevel: number;
  onChangeFilters: (next: TimelineFilterState) => void;
  onResetFilters?: () => void;
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
const ZOOM_MIN = 0.4;
const ZOOM_MAX = 2.5;
const ZOOM_STEP = 0.25;

function clampZoom(value: number): number {
  return Math.min(ZOOM_MAX, Math.max(ZOOM_MIN, Number(value.toFixed(2))));
}

export function TimelineEditPanel({
  filters,
  isFiltersOverridden,
  markerStepKm,
  zoomLevel,
  onChangeFilters,
  onResetFilters,
  onChangeMarkerStepKm,
  onChangeZoomLevel,
}: TimelineEditPanelProps) {
  const { t } = useAppI18n();

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

      <TimelineFilterBar
        filters={filters}
        isOverridden={isFiltersOverridden}
        onChangeFilters={onChangeFilters}
        onResetToGlobal={onResetFilters}
        title={t('Filtres de la timeline')}
        ariaLabel={t('Filtres de la timeline')}
      />

      <div className="rvi-tl-edit__divider" aria-hidden />
    </section>
  );
}