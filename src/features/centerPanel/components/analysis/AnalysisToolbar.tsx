import { IconCheck, IconMinus, IconPlus } from '../CenterPanelIcons';
import { AxisDropdown } from './AxisDropdown';
import { axisOptions, filterDefs, type FilterKey } from './shared';
import type { AxisMetricId, AxisMode } from '../chart';
import { useAppI18n } from '@/shared/i18n';

interface AnalysisToolbarProps {
  xMode: AxisMode;
  onXModeChange: (mode: AxisMode) => void;
  detailZoom: number;
  onZoomIn: () => void;
  onZoomOut: () => void;
  openAxis: 'axis1' | 'axis2' | null;
  onToggleAxis: (axis: 'axis1' | 'axis2') => void;
  axis1Value: AxisMetricId;
  axis2Value: AxisMetricId;
  axis1Color: string;
  axis2Color: string;
  onAxis1Select: (value: string) => void;
  onAxis2Select: (value: string) => void;
  onAxis1ColorChange: (color: string) => void;
  onAxis2ColorChange: (color: string) => void;
  filters: Record<FilterKey, boolean>;
  onToggleFilter: (key: FilterKey) => void;
}

export function AnalysisToolbar({
  xMode,
  onXModeChange,
  detailZoom,
  onZoomIn,
  onZoomOut,
  openAxis,
  onToggleAxis,
  axis1Value,
  axis2Value,
  axis1Color,
  axis2Color,
  onAxis1Select,
  onAxis2Select,
  onAxis1ColorChange,
  onAxis2ColorChange,
  filters,
  onToggleFilter,
}: AnalysisToolbarProps) {
  const { t } = useAppI18n();

  return (
    <div className="rvc-center-analysis__toolbar">
      <div className="rvc-center-analysis__label">{t('Analyse')}</div>

      <div className="rvc-center-analysis__segmented" role="tablist" aria-label={t("Mode d'analyse")}>
        <button
          className={
            xMode === 'distance'
              ? 'rvc-center-analysis__segment rvc-center-analysis__segment--active'
              : 'rvc-center-analysis__segment'
          }
          type="button"
          onClick={() => onXModeChange('distance')}
        >
          {t('Distance')}
        </button>
        <button
          className={
            xMode === 'temps'
              ? 'rvc-center-analysis__segment rvc-center-analysis__segment--active'
              : 'rvc-center-analysis__segment'
          }
          type="button"
          onClick={() => onXModeChange('temps')}
        >
          {t('Temps')}
        </button>
        <button
          className={
            xMode === 'heure'
              ? 'rvc-center-analysis__segment rvc-center-analysis__segment--active'
              : 'rvc-center-analysis__segment'
          }
          type="button"
          onClick={() => onXModeChange('heure')}
        >
          {t('Heures')}
        </button>
      </div>

      <div className="rvc-center-analysis__detail">
        <span className="rvc-center-analysis__minor-label">{t('Détail')}</span>
        <div className="rvc-center-analysis__detail-buttons" role="group" aria-label={t('Zoom du graphique')}>
          <button
            type="button"
            className="rvc-center-analysis__detail-button"
            onClick={onZoomOut}
            disabled={detailZoom <= 0.001}
            aria-label={t('Dézoomer le graphique')}
          >
            <IconMinus size={16} aria-hidden="true" />
          </button>
          <button
            type="button"
            className="rvc-center-analysis__detail-button"
            onClick={onZoomIn}
            disabled={detailZoom >= 0.999}
            aria-label={t('Zoomer le graphique')}
          >
            <IconPlus size={16} aria-hidden="true" />
          </button>
        </div>
      </div>

      <AxisDropdown
        axisLabel="Axe 1"
        axisColor={axis1Color}
        value={axis1Value}
        isOpen={openAxis === 'axis1'}
        options={axisOptions}
        onToggle={() => onToggleAxis('axis1')}
        onColorChange={onAxis1ColorChange}
        onSelect={onAxis1Select}
      />

      <AxisDropdown
        axisLabel="Axe 2"
        axisColor={axis2Color}
        value={axis2Value}
        isOpen={openAxis === 'axis2'}
        options={axisOptions}
        onToggle={() => onToggleAxis('axis2')}
        onColorChange={onAxis2ColorChange}
        onSelect={onAxis2Select}
      />

      <div className="rvc-center-analysis__separator" aria-hidden="true" />

      <div className="rvc-center-analysis__filters" aria-label={t('Filtres')}>
        {filterDefs.map(({ key, label }) => {
          const checked = filters[key];
          return (
            <label
              key={key}
              className={
                checked
                  ? 'rvc-center-analysis__filter-chip'
                  : 'rvc-center-analysis__filter-chip rvc-center-analysis__filter-chip--off'
              }
            >
              <input
                type="checkbox"
                className="rvc-center-analysis__filter-input"
                checked={checked}
                onChange={() => onToggleFilter(key)}
                aria-label={t(label)}
              />
              <span className="rvc-center-analysis__checkbox" aria-hidden="true">
                {checked ? <IconCheck size={10} /> : null}
              </span>
              <span className="rvc-center-analysis__filter-label" title={t(label)}>
                {t(label)}
              </span>
            </label>
          );
        })}
      </div>
    </div>
  );
}
