import { useMemo, useState } from 'react';
import { IconCheck } from '../CenterPanelIcons';
import { AxisDropdown } from './AxisDropdown';
import { axisOptions, axis2Options } from './shared';
import type { AxisMetricId, AxisMode } from '../chart';
import { useAppI18n } from '@/shared/i18n';

type ToolbarFilterKey = 'pente' | 'jourNuit';

const visibleToolbarFilters: ReadonlyArray<{ key: ToolbarFilterKey; label: string }> = [
  { key: 'pente', label: "Profils d'altitude" },
  { key: 'jourNuit', label: 'Jour/nuit' },
];

interface AnalysisToolbarProps {
  xMode: AxisMode;
  onXModeChange: (mode: AxisMode) => void;
  openAxis: 'axis1' | 'axis2' | null;
  onToggleAxis: (axis: 'axis1' | 'axis2') => void;
  axis1Value: AxisMetricId;
  axis2Value: AxisMetricId | null;
  axis1Color: string;
  axis2Color: string;
  onAxis1Select: (value: string) => void;
  onAxis2Select: (value: string) => void;
  onAxis1ColorChange: (color: string) => void;
  onAxis2ColorChange: (color: string) => void;
  filters: { pente: boolean; jourNuit: boolean };
  onToggleFilter: (key: ToolbarFilterKey) => void;
  /**
   * Aide au survol par filtre : si une entrée existe pour un filtre, son chip
   * affiche ce message en pop-in au survol. Le chip reste cliquable — c'est un
   * simple indicateur de prérequis manquant, pas un état désactivé.
   */
  disabledFilters?: Partial<Record<ToolbarFilterKey, string>>;
  /**
   * Filtres dont le prérequis manque ET qui sont actuellement activés : leur
   * chip affiche le pop-in en continu, sans survol, tant que l'utilisateur ne
   * les désactive pas. Renversé par le parent (voir CenterPanelAnalysis).
   */
  pinnedFilters?: Partial<Record<ToolbarFilterKey, string>>;
  /**
   * Modes d'axe X désactivés avec message d'aide en pop-in (ex: Temps / Heures
   * sans heure de départ).
   */
  disabledXModes?: Partial<Record<AxisMode, string>>;
}

export function AnalysisToolbar({
  xMode,
  onXModeChange,
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
  disabledFilters,
  pinnedFilters,
  disabledXModes,
}: AnalysisToolbarProps) {
  const { t } = useAppI18n();
  const [hovered, setHovered] = useState<ToolbarFilterKey | null>(null);
  const [hoveredXMode, setHoveredXMode] = useState<AxisMode | null>(null);

  /**
   * Un pop-in est affiché quand le filtre correspondant a un prérequis manquant
   * ET qu'il est soit survolé, soit activé. Ce second cas le rend persistant :
   * pas besoin de survoler pour voir le message.
   */
  const activeHintKey = useMemo<ToolbarFilterKey | null>(() => {
    const found = visibleToolbarFilters.find(
      ({ key }) =>
        disabledFilters?.[key] && (hovered === key || (pinnedFilters?.[key] && filters[key])),
    );
    return found?.key ?? null;
  }, [disabledFilters, filters, hovered, pinnedFilters]);

  const activeHint = activeHintKey
    ? disabledFilters?.[activeHintKey] ?? pinnedFilters?.[activeHintKey]
    : undefined;

  return (
    <div className="rvc-center-analysis__toolbar">
      <div className="rvc-center-analysis__label">{t('Analyse')}</div>

      <div className="rvc-center-analysis__segmented" role="tablist" aria-label={t("Mode d'analyse")}>
        {(
          [
            { mode: 'distance' as const, label: t('Distance') },
            { mode: 'temps' as const, label: t('Temps') },
            { mode: 'heure' as const, label: t('Heures') },
          ] as const
        ).map(({ mode, label }) => {
          const isActive = xMode === mode;
          const hint = disabledXModes?.[mode];
          const isDisabled = Boolean(hint);
          const showHint = isDisabled && hoveredXMode === mode;

          return (
            <div
              key={mode}
              className={[
                'rvc-center-analysis__segment-item',
                isDisabled ? 'rvc-center-analysis__segment-item--disabled' : '',
              ]
                .filter(Boolean)
                .join(' ')}
              onMouseEnter={() => {
                if (isDisabled) setHoveredXMode(mode);
              }}
              onMouseLeave={() => {
                setHoveredXMode((curr) => (curr === mode ? null : curr));
              }}
            >
              <button
                className={[
                  'rvc-center-analysis__segment',
                  isActive ? 'rvc-center-analysis__segment--active' : '',
                  isDisabled ? 'rvc-center-analysis__segment--disabled' : '',
                ]
                  .filter(Boolean)
                  .join(' ')}
                type="button"
                disabled={isDisabled}
                onClick={() => {
                  if (!isDisabled) onXModeChange(mode);
                }}
                aria-label={label}
                aria-describedby={showHint ? `rvc-analysis-xmode-hint-${mode}` : undefined}
              >
                {label}
              </button>

              {showHint && hint ? (
                <div
                  id={`rvc-analysis-xmode-hint-${mode}`}
                  className="rvc-center-analysis__tooltip"
                  role="tooltip"
                >
                  {hint}
                </div>
              ) : null}
            </div>
          );
        })}
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
        options={axis2Options}
        onToggle={() => onToggleAxis('axis2')}
        onColorChange={onAxis2ColorChange}
        onSelect={onAxis2Select}
        isDashed
      />

      <div className="rvc-center-analysis__separator" aria-hidden="true" />

      <div className="rvc-center-analysis__filters" aria-label={t('Filtres')}>
        {visibleToolbarFilters.map(({ key, label }) => {
          const checked = filters[key];
          const hint = disabledFilters?.[key];
          const hasHint = Boolean(hint);
          const showHint = activeHintKey === key && Boolean(activeHint);

          const className = [
            'rvc-center-analysis__filter-chip',
            checked ? '' : 'rvc-center-analysis__filter-chip--off',
            hasHint ? 'rvc-center-analysis__filter-chip--hint' : '',
          ]
            .filter(Boolean)
            .join(' ');

          return (
            <div
              key={key}
              className="rvc-center-analysis__filter-item"
              onMouseEnter={() => {
                if (hasHint) setHovered(key);
              }}
              onMouseLeave={() => {
                setHovered((curr) => (curr === key ? null : curr));
              }}
            >
              <label className={className}>
                {/*
                  Volontairement PAS de `disabled` : le chip doit rester coché/
                  décochable même sans ses prérequis. Sinon le filtre (actif par
                  défaut) deviendrait impossible à désactiver.
                */}
                <input
                  type="checkbox"
                  className="rvc-center-analysis__filter-input"
                  checked={checked}
                  onChange={() => onToggleFilter(key)}
                  aria-label={t(label)}
                  aria-describedby={
                    showHint ? `rvc-analysis-filter-hint-${key}` : undefined
                  }
                />
                <span className="rvc-center-analysis__checkbox" aria-hidden="true">
                  {checked ? <IconCheck size={10} /> : null}
                </span>
                <span className="rvc-center-analysis__filter-label" title={t(label)}>
                  {t(label)}
                </span>
              </label>

              {showHint && activeHint ? (
                <div
                  id={`rvc-analysis-filter-hint-${key}`}
                  className="rvc-center-analysis__tooltip"
                  role="tooltip"
                >
                  {activeHint}
                </div>
              ) : null}
            </div>
          );
        })}
      </div>
    </div>
  );
}
