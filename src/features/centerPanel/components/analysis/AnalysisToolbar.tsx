import { useEffect, useMemo, useRef, useState } from 'react';
import { IconCheck, IconChevronDown } from '../CenterPanelIcons';
import { AxisDropdown, type AxisOption } from './AxisDropdown';
import { axisOptions, axis2Options, surfaceFilterOptions } from './shared';
import type { RouteSurfaceFilter } from '@/features/itineraryPanel/types';
import { SLOPE_COLOR_CLASSES, type AxisMetricId, type AxisMode } from '../chart';
import { useToolbarFitDensity } from './useToolbarFitDensity';
import { useAppI18n } from '@/shared/i18n';

export type ToolbarFilterKey = 'pente' | 'jourNuit' | 'alertes' | 'slopeColors';

const visibleToolbarFilters: ReadonlyArray<{
  key: ToolbarFilterKey;
  label: string;
  icon?: string;
  /** Pastille dégradée de l'échelle de pente à la place d'une icône. */
  slopeSwatch?: boolean;
}> = [
  { key: 'pente', label: "Profils d'altitude" },
  { key: 'slopeColors', label: 'Pente', slopeSwatch: true },
  { key: 'jourNuit', label: 'Jour/nuit' },
  { key: 'alertes', label: 'Alertes', icon: '/svgv2/icone/search-filter-alertes.svg' },
];

/** Dégradé de l'échelle de pente du tracé (-16 % → 16 %), pour la pastille du chip « Pente ». */
const SLOPE_SWATCH_BACKGROUND = `linear-gradient(90deg, ${SLOPE_COLOR_CLASSES
  .map((entry) => entry.color)
  .join(', ')})`;

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
  filters: Record<ToolbarFilterKey, boolean>;
  onToggleFilter: (key: ToolbarFilterKey) => void;
  surfaceFilter: RouteSurfaceFilter;
  onSurfaceFilterChange: (value: RouteSurfaceFilter) => void;
  /**
   * Aide au survol par filtre : si une entrée existe pour un filtre, son chip
   * affiche ce message en pop-in au survol. Le chip reste cliquable — c'est un
   * simple indicateur de prérequis manquant, pas un état désactivé.
   */
  disabledFilters?: Partial<Record<ToolbarFilterKey, string>>;
  /**
   * Modes d'axe X désactivés avec message d'aide en pop-in (ex: Temps / Heures
   * sans heure de départ).
   */
  disabledXModes?: Partial<Record<AxisMode, string>>;
  /** Axis choices (defaults to every metric); filtered per discipline by the caller. */
  axis1Options?: AxisOption[];
  axis2Options?: AxisOption[];
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
  surfaceFilter,
  onSurfaceFilterChange,
  disabledFilters,
  disabledXModes,
  axis1Options = axisOptions,
  axis2Options: axis2OptionList = axis2Options,
}: AnalysisToolbarProps) {
  const { t } = useAppI18n();
  const [hovered, setHovered] = useState<ToolbarFilterKey | null>(null);
  const [hoveredXMode, setHoveredXMode] = useState<AxisMode | null>(null);
  const toolbarRef = useRef<HTMLDivElement | null>(null);
  useToolbarFitDensity(toolbarRef);

  /**
   * Un pop-in d'aide est affiché UNIQUEMENT au survol du chip quand un prérequis
   * est manquant. Il ne s'affiche jamais de manière permanente quand l'option est cochée.
   */
  const activeHintKey = useMemo<ToolbarFilterKey | null>(() => {
    const found = visibleToolbarFilters.find(
      ({ key }) => Boolean(disabledFilters?.[key]) && hovered === key,
    );
    return found?.key ?? null;
  }, [disabledFilters, hovered]);

  const activeHint = activeHintKey ? disabledFilters?.[activeHintKey] : undefined;

  return (
    <div ref={toolbarRef} className="rvc-center-analysis__toolbar">
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
                title={isDisabled ? undefined : label}
              >
                <span className="rvc-center-analysis__segment-text">{label}</span>
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
        options={axis1Options}
        onToggle={() => onToggleAxis('axis1')}
        onColorChange={onAxis1ColorChange}
        onSelect={onAxis1Select}
      />

      <AxisDropdown
        axisLabel="Axe 2"
        axisColor={axis2Color}
        value={axis2Value}
        isOpen={openAxis === 'axis2'}
        options={axis2OptionList}
        onToggle={() => onToggleAxis('axis2')}
        onColorChange={onAxis2ColorChange}
        onSelect={onAxis2Select}
        isDashed
      />

      <div className="rvc-center-analysis__separator" aria-hidden="true" />

      <div className="rvc-center-analysis__filters" aria-label={t('Filtres')}>
        {visibleToolbarFilters.map(({ key, label, icon, slopeSwatch }) => {
          const checked = Boolean(filters[key] ?? true);
          const hint = disabledFilters?.[key];
          const hasHint = Boolean(hint);
          const showHint = activeHintKey === key && Boolean(activeHint);

          const className = [
            'rvc-center-analysis__filter-chip',
            icon || slopeSwatch ? 'rvc-center-analysis__filter-chip--iconic' : '',
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
              <label className={className} title={hasHint ? undefined : t(label)}>
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
                  {checked ? <IconCheck size={9} /> : null}
                </span>
                {icon ? (
                  <img className="rvc-center-analysis__filter-icon" src={icon} alt="" aria-hidden="true" />
                ) : null}
                {slopeSwatch ? (
                  <span
                    className="rvc-center-analysis__slope-swatch"
                    style={{ background: SLOPE_SWATCH_BACKGROUND }}
                    aria-hidden="true"
                  />
                ) : null}
                <span className="rvc-center-analysis__filter-label">
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

        <SurfaceFilterDropdown value={surfaceFilter} onChange={onSurfaceFilterChange} />
      </div>
    </div>
  );
}

/**
 * Filtre « Surface » : restreint la trace affichée sur la carte au revêtement
 * choisi (toutes les portions = affichage normal).
 */
function SurfaceFilterDropdown({
  value,
  onChange,
}: {
  value: RouteSurfaceFilter;
  onChange: (value: RouteSurfaceFilter) => void;
}) {
  const { t } = useAppI18n();
  const [open, setOpen] = useState(false);
  const rootRef = useRef<HTMLDivElement | null>(null);
  const isActive = value !== 'all';
  const selected = surfaceFilterOptions.find((option) => option.value === value) ?? surfaceFilterOptions[0]!;

  useEffect(() => {
    if (!open) return;
    const handlePointerDown = (event: PointerEvent) => {
      if (rootRef.current?.contains(event.target as Node)) return;
      setOpen(false);
    };
    document.addEventListener('pointerdown', handlePointerDown);
    return () => document.removeEventListener('pointerdown', handlePointerDown);
  }, [open]);

  return (
    <div ref={rootRef} className="rvc-center-analysis__filter-item">
      <button
        type="button"
        className={[
          'rvc-center-analysis__filter-chip',
          'rvc-center-analysis__surface-chip',
          isActive ? 'rvc-center-analysis__surface-chip--active' : 'rvc-center-analysis__filter-chip--off',
        ].join(' ')}
        aria-haspopup="listbox"
        aria-expanded={open}
        onClick={() => setOpen((curr) => !curr)}
        title={t('Surface')}
      >
        <span className="rvc-center-analysis__filter-label">
          {isActive ? t(selected.label) : t('Surface')}
        </span>
        <IconChevronDown size={14} className="rvc-center-analysis__select-icon" />
      </button>

      {open ? (
        <div className="rv-dropdown rvc-center-analysis__dropdown rvc-center-analysis__surface-dropdown" role="listbox" aria-label={t('Surface')}>
          {surfaceFilterOptions.map((option) => {
            const isSelected = option.value === value;
            return (
              <button
                key={option.value}
                className={`rv-dropdown__item${isSelected ? ' is-selected' : ''}`}
                type="button"
                role="option"
                aria-selected={isSelected}
                onClick={() => {
                  onChange(option.value);
                  setOpen(false);
                }}
              >
                <span className="rv-dropdown__label">{t(option.label)}</span>
              </button>
            );
          })}
        </div>
      ) : null}
    </div>
  );
}
