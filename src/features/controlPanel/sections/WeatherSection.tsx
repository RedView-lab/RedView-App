import { useEffect, useMemo, useRef, useState } from 'react';
import { ColorPalettePicker } from '../components/ColorPalettePicker';
import { ColorSwatch } from '../components/ColorSwatch';
import { Section } from '../components/Section';
import { Checkbox } from '../components/Checkbox';
import { Select } from '../components/Select';
import { Toggle } from '../components/Toggle';
import { Slider } from '../components/Slider';
import { IconCalendar, IconChevronDown, IconClock, IconEye, IconEyeOff, IconInfo } from '../icons';
import type {
  ControlPanelHandlers,
  WeatherPaletteBand,
  WeatherPaletteScaleSetting,
  WeatherLayerKey,
  WeatherRenderMode,
  WeatherState,
  WeatherTab,
} from '../types';
import { formatWeatherPaletteBandLabel, formatWeatherPaletteValue, weatherPaletteMetricSpec } from '../weatherPalette';
import {
  FORECAST_MAX_DAY_OFFSET,
  FORECAST_TIME_STEP_MINUTES,
  formatLocalDateIso,
  getForecastDateForOffset,
  getForecastMaxMinutesForDate,
  getForecastMinMinutesForDate,
  getForecastOffsetForDate,
  minutesToTime,
  timeToMinutes,
} from '@/features/weather/lib/forecastTime.ts';

interface Props {
  state: WeatherState;
  open?: boolean;
  onOpenChange?: (open: boolean) => void;
  onEnabledChange: ControlPanelHandlers['onWeatherEnabledChange'];
  onTabChange: ControlPanelHandlers['onWeatherTabChange'];
  onDateChange: ControlPanelHandlers['onWeatherDateChange'];
  onLayerToggle: ControlPanelHandlers['onWeatherLayerToggle'];
  onLayerModeChange: ControlPanelHandlers['onWeatherLayerModeChange'];
  onPaletteOpacityChange: ControlPanelHandlers['onWeatherPaletteOpacityChange'];
  onPaletteScaleSettingChange: ControlPanelHandlers['onWeatherPaletteScaleSettingChange'];
  onPaletteBandColorChange: ControlPanelHandlers['onWeatherPaletteBandColorChange'];
  onPaletteBandVisibilityToggle: ControlPanelHandlers['onWeatherPaletteBandVisibilityToggle'];
  onPaletteBandBreakpointChange: ControlPanelHandlers['onWeatherPaletteBandBreakpointChange'];
  onAddAlert: ControlPanelHandlers['onWeatherAddAlert'];
}

const TABS: { value: WeatherTab; label: string }[] = [
  { value: 'forecast', label: 'Forecast (+4j)' },
  { value: 'trends', label: 'Tendances' },
];

const TREND_LAYER_ORDER: WeatherLayerKey[] = [
  'temperature',
  'feelsLike',
  'humidity',
  'rain',
  'cloudCover',
];

const FORECAST_HIDDEN_LAYER_KEYS = new Set<WeatherLayerKey>(['wind', 'sunshine']);

const MONTH_LABELS_SHORT = ['Jan.', 'Fev.', 'Mar.', 'Avr.', 'Mai', 'Juin', 'Juil.', 'Aout', 'Sep.', 'Oct.', 'Nov.', 'Dec.'] as const;
const MONTH_LABELS_LONG = ['Janvier', 'Fevrier', 'Mars', 'Avril', 'Mai', 'Juin', 'Juillet', 'Aout', 'Septembre', 'Octobre', 'Novembre', 'Decembre'] as const;

const LAYER_LABEL: Record<WeatherLayerKey, string> = {
  temperature: 'Température (°)',
  feelsLike: 'Température ressentie (°)',
  rain: 'Pluie (mm)',
  wind: 'Vent (km/h)',
  cloudCover: 'Couverture nuageuse (%)',
  humidity: 'Humidité (%)',
  sunshine: 'Ensoleillement (min)',
};

const TEXT_GRADIENT_FILL_OPTIONS: { value: WeatherRenderMode; label: string }[] = [
  { value: 'text', label: 'Texte' },
  { value: 'gradient', label: 'Dégradé' },
  { value: 'fill', label: 'Remplissage' },
];

const GRADIENT_FILL_OPTIONS: { value: WeatherRenderMode; label: string }[] = [
  { value: 'gradient', label: 'Dégradé' },
  { value: 'fill', label: 'Remplissage' },
];

const DISABLED_ONLY_OPTION: { value: WeatherRenderMode; label: string }[] = [
  { value: '-', label: '-' },
];

const PALETTE_SCALE_OPTIONS: { value: WeatherPaletteScaleSetting; label: string }[] = [
  { value: '2 couleurs', label: '2 couleurs' },
  { value: '3 couleurs', label: '3 couleurs' },
  { value: '4 couleurs', label: '4 couleurs' },
  { value: '6 couleurs', label: '6 couleurs' },
];

const MODE_OPTIONS_BY_LAYER: Partial<Record<WeatherLayerKey, { value: WeatherRenderMode; label: string }[]>> = {
  temperature: TEXT_GRADIENT_FILL_OPTIONS,
  feelsLike: TEXT_GRADIENT_FILL_OPTIONS,
  rain: GRADIENT_FILL_OPTIONS,
  cloudCover: GRADIENT_FILL_OPTIONS,
  humidity: DISABLED_ONLY_OPTION,
};

const FRENCH_DAYS = ['Dim', 'Lun', 'Mar', 'Mer', 'Jeu', 'Ven', 'Sam'];

function getForecastDayLabels(): string[] {
  const todayIso = formatLocalDateIso(new Date());
  return Array.from({ length: FORECAST_MAX_DAY_OFFSET + 1 }, (_, offset) => {
    const dateIso = getForecastDateForOffset(offset);
    if (dateIso === todayIso) return "Aujourd'hui";
    const date = new Date(`${dateIso}T00:00:00`);
    return FRENCH_DAYS[date.getDay()] ?? FRENCH_DAYS[0];
  });
}

function getMonthIndexFromIso(iso: string): number {
  const value = new Date(`${iso}T00:00:00`);
  if (Number.isNaN(value.getTime())) return 0;
  return value.getMonth();
}

function setMonthOnIsoDate(iso: string, monthIndex: number): string {
  const base = new Date(`${iso}T00:00:00`);
  const safeDate = Number.isNaN(base.getTime()) ? new Date() : base;
  safeDate.setMonth(monthIndex, 1);
  return safeDate.toISOString().slice(0, 10);
}

function formatMonthInputValue(iso: string): string {
  const value = new Date(`${iso}T00:00:00`);
  if (Number.isNaN(value.getTime())) return '';
  const month = String(value.getMonth() + 1).padStart(2, '0');
  return `${value.getFullYear()}-${month}`;
}

function getMonthLabel(iso: string): string {
  return MONTH_LABELS_LONG[getMonthIndexFromIso(iso)] ?? MONTH_LABELS_LONG[0];
}

function getModeOptions(key: WeatherLayerKey): { value: WeatherRenderMode; label: string }[] {
  return MODE_OPTIONS_BY_LAYER[key] ?? DISABLED_ONLY_OPTION;
}

function hexLabel(color: string): string {
  return color.replace('#', '').toUpperCase();
}

function showsPalette(mode: WeatherRenderMode): mode is 'gradient' | 'fill' {
  return mode === 'gradient' || mode === 'fill';
}

function sanitizeWeatherDraft(value: string, allowDecimal: boolean): string {
  const filtered = allowDecimal
    ? value.replace(/[^\d.,-]/g, '')
    : value.replace(/[^\d-]/g, '');
  const withLeadingMinusOnly = filtered.replace(/(?!^)-/g, '');
  return allowDecimal
    ? withLeadingMinusOnly.replace(/([.,].*)[.,]/g, '$1')
    : withLeadingMinusOnly;
}

interface InlineWeatherNumericInputProps {
  layerKey: WeatherLayerKey;
  value: number;
  editable: boolean;
  onCommit: (value: number) => void;
}

function InlineWeatherNumericInput({
  layerKey,
  value,
  editable,
  onCommit,
}: InlineWeatherNumericInputProps) {
  const spec = weatherPaletteMetricSpec(layerKey);
  const decimals = spec?.decimals ?? 0;
  const minLimit = spec?.minLimit;
  const maxLimit = spec?.maxLimit;
  const unit = spec?.unit ?? '';
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState('');
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (editing && inputRef.current) {
      inputRef.current.focus();
      inputRef.current.select();
    }
  }, [editing]);

  const display = spec ? formatWeatherPaletteValue(layerKey, value) : `${value}`;
  const suffix = spec ? (unit === '°C' ? unit : ` ${unit}`) : '';

  const commit = () => {
    if (minLimit == null || maxLimit == null) {
      setEditing(false);
      return;
    }
    setEditing(false);
    const parsed = Number.parseFloat(draft.replace(',', '.'));
    if (!Number.isFinite(parsed)) return;
    const clamped = Math.max(minLimit, Math.min(maxLimit, parsed));
    if (clamped !== value) onCommit(clamped);
  };

  const handleKeyDown = (event: React.KeyboardEvent<HTMLInputElement>) => {
    if (event.key === 'Enter') {
      event.preventDefault();
      commit();
    } else if (event.key === 'Escape') {
      setDraft(display);
      setEditing(false);
    }
  };

  if (!editable || !spec) {
      return <span className="rvc-altitude__meter-value rvc-weather__threshold-number">{display}{suffix}</span>;
  }

  if (!editing) {
    return (
      <button
        type="button"
          className="rvc-altitude__meter-btn rvc-weather__threshold-number"
        onClick={() => {
          setDraft(display);
          setEditing(true);
        }}
          title={`Cliquer pour modifier la valeur ${suffix.trim()}`}
      >
          {display}{suffix}
      </button>
    );
  }

  return (
    <input
      ref={inputRef}
      type="text"
      inputMode={decimals > 0 ? 'decimal' : 'numeric'}
      className="rvc-altitude__meter-input rvc-weather__threshold-input"
      value={draft}
      onChange={(event) => {
        const next = sanitizeWeatherDraft(event.target.value, decimals > 0);
        setDraft(next);
      }}
      onBlur={commit}
      onKeyDown={handleKeyDown}
      aria-label={`Valeur ${unit}`}
    />
  );
}

function WeatherPaletteRow({
  layerKey,
  band,
  bandIndex,
  totalBands,
  onColorChange,
  onVisibilityToggle,
  onBreakpointChange,
}: {
  layerKey: WeatherLayerKey;
  band: WeatherPaletteBand;
  bandIndex: number;
  totalBands: number;
  onColorChange?: ControlPanelHandlers['onWeatherPaletteBandColorChange'];
  onVisibilityToggle?: ControlPanelHandlers['onWeatherPaletteBandVisibilityToggle'];
  onBreakpointChange?: ControlPanelHandlers['onWeatherPaletteBandBreakpointChange'];
}) {
  const spec = weatherPaletteMetricSpec(layerKey);
  if (!spec) return null;

  const isFirst = bandIndex === 0;
  const isLast = bandIndex === totalBands - 1;
  const minValue = isFirst ? spec.minLimit : band.minValue;
  const maxValue = isLast ? spec.maxLimit : band.maxValue;

  return (
    <div className={`rvc-altitude__band-row rvc-weather__band-row${band.visible ? '' : ' is-hidden'}`}>
      <button
        type="button"
        className="rvc-icon-btn rvc-icon-btn--ghost rvc-altitude__band-eye rvc-weather__band-eye"
        onClick={() => onVisibilityToggle?.(layerKey, band.id)}
        aria-label={band.visible ? 'Masquer la bande météo' : 'Afficher la bande météo'}
      >
        {band.visible ? <IconEye size={12} /> : <IconEyeOff size={12} />}
      </button>

      <div className="rvc-altitude__band-label-editable rvc-weather__band-label-editable" data-metric={layerKey}>
        <InlineWeatherNumericInput
          layerKey={layerKey}
          value={minValue}
          editable={!isFirst}
          onCommit={(value) => onBreakpointChange?.(layerKey, bandIndex, 'min', value)}
        />
        <span className="rvc-altitude__meter-sep">–</span>
        <InlineWeatherNumericInput
          layerKey={layerKey}
          value={maxValue}
          editable={!isLast}
          onCommit={(value) => onBreakpointChange?.(layerKey, bandIndex, 'max', value)}
        />
      </div>

      <ColorPalettePicker
        color={band.color}
        onChange={(color) => onColorChange?.(layerKey, band.id, color)}
        className="rvc-altitude__color-chip"
        ariaLabel={`Choisir la couleur ${formatWeatherPaletteBandLabel(layerKey, band, bandIndex, totalBands)}`}
      >
        <ColorSwatch color={band.color} size={12} />
        <span className="rvc-altitude__color-hex">{hexLabel(band.color)}</span>
        <IconChevronDown size={20} className="rvc-altitude__color-chevron" />
      </ColorPalettePicker>
    </div>
  );
}

export function WeatherSection({
  state,
  open,
  onOpenChange,
  onEnabledChange,
  onTabChange,
  onDateChange,
  onLayerToggle,
  onLayerModeChange,
  onPaletteOpacityChange,
  onPaletteScaleSettingChange,
  onPaletteBandColorChange,
  onPaletteBandVisibilityToggle,
  onPaletteBandBreakpointChange,
  onAddAlert,
}: Props) {
  const handleTimeSliderChange = (val: number) => {
    onDateChange?.({ time: minutesToTime(val) });
  };

  const timeParts = (state.time || '00:00').split(':');
  const h = timeParts[0] || '00';
  const m = timeParts[1] || '00';

  const dayLabels = getForecastDayLabels();
  const isForecast = state.tab === 'forecast';
  const forecastDay = getForecastOffsetForDate(state.date);
  const trendMonth = getMonthIndexFromIso(state.date);
  const trendMonthLabel = getMonthLabel(state.date);
  const trendMonthValue = formatMonthInputValue(state.date);
  const forecastMinMinutes = getForecastMinMinutesForDate(state.date);
  const forecastMaxMinutes = getForecastMaxMinutesForDate(state.date);
  const forecastBoundsStart = minutesToTime(forecastMinMinutes);
  const forecastBoundsEnd = minutesToTime(forecastMaxMinutes);
  const safeForecastMinutes = Math.max(forecastMinMinutes, Math.min(forecastMaxMinutes, timeToMinutes(state.time)));

  const displayedLayers = useMemo(() => {
    if (isForecast) {
      return state.layers.filter((layer) => !FORECAST_HIDDEN_LAYER_KEYS.has(layer.key));
    }

    return TREND_LAYER_ORDER.map((key) => state.layers.find((layer) => layer.key === key)).filter(
      (layer): layer is WeatherState['layers'][number] => Boolean(layer),
    );
  }, [isForecast, state.layers]);

  return (
    <Section
      title="Météo"
      toggle={{ checked: state.enabled, onChange: onEnabledChange }}
      open={open}
      onOpenChange={onOpenChange}
    >
      {/* Tabs */}
      <div className="rvc-weather__tabs">
        {TABS.map((tab) => (
          <button
            key={tab.value}
            type="button"
            className={`rvc-weather__tab${state.tab === tab.value ? ' is-active' : ''}`}
            onClick={() => onTabChange?.(tab.value)}
          >
            {tab.label}
          </button>
        ))}
      </div>

      {isForecast ? (
        <>
          {/* Discrete day slider for forecast */}
          <div className="rvc-weather__day-selector">
            <div className="rvc-weather__day-slider-wrapper">
              <Slider
                min={0}
                max={FORECAST_MAX_DAY_OFFSET}
                value={forecastDay}
                onChange={(v) => onDateChange?.({ forecastDay: v, date: getForecastDateForOffset(v) })}
                width="100%"
              />
            </div>
            <div className="rvc-weather__day-labels">
              {dayLabels.map((label, i) => (
                <button
                  key={i}
                  type="button"
                  className={`rvc-weather__day-label${forecastDay === i ? ' is-active' : ''}`}
                  onClick={() => onDateChange?.({ forecastDay: i, date: getForecastDateForOffset(i) })}
                >
                  {label}
                </button>
              ))}
            </div>
          </div>

          {/* Time row for forecast */}
          <div className="rvc-weather__time-row">
            <span className="rvc-weather__time-bound">{forecastBoundsStart}</span>
            <div style={{ flex: 1, padding: '0 4px', display: 'flex', alignItems: 'center' }}>
              <Slider
                min={forecastMinMinutes}
                max={forecastMaxMinutes}
                step={FORECAST_TIME_STEP_MINUTES}
                value={safeForecastMinutes}
                onChange={handleTimeSliderChange}
                width="100%"
              />
            </div>
            <span className="rvc-weather__time-bound">{forecastBoundsEnd}</span>
            <div className="rvc-weather__time-input">
              <IconClock size={12} />
              <div className="rvc-weather__time-display">
                <div className="rvc-weather__time-display-segment">{h}</div>
                <div className="rvc-weather__time-display-colon">:</div>
                <div className="rvc-weather__time-display-segment">{m}</div>
              </div>
              <input
                type="time"
                value={state.time}
                min={forecastBoundsStart}
                max={forecastBoundsEnd}
                step={FORECAST_TIME_STEP_MINUTES * 60}
                onChange={(e) => onDateChange?.({ time: e.target.value })}
                className="rvc-weather__native-input"
              />
            </div>
          </div>
        </>
      ) : (
        <div className="rvc-weather__month-row">
          <span className="rvc-weather__month-bound">{MONTH_LABELS_SHORT[0]}</span>
          <div className="rvc-weather__month-slider">
            <Slider
              min={0}
              max={11}
              value={trendMonth}
              onChange={(value) => onDateChange?.({ date: setMonthOnIsoDate(state.date, value), trendMode: 'date' })}
              width="100%"
            />
          </div>
          <span className="rvc-weather__month-bound">{MONTH_LABELS_SHORT[11]}</span>
          <label className="rvc-weather__month-chip">
            <IconCalendar size={12} />
            <span className="rvc-weather__month-chip-label">{trendMonthLabel}</span>
            <input
              type="month"
              value={trendMonthValue}
              onChange={(e) => {
                if (!e.target.value) return;
                const [year, month] = e.target.value.split('-');
                onDateChange?.({ date: `${year}-${month}-01`, trendMode: 'date' });
              }}
              className="rvc-weather__native-input"
            />
          </label>
        </div>
      )}

      {/* Layer list */}
      <div className="rvc-weather__layers">
        {displayedLayers.map((layer) => {
          const modeOptions = getModeOptions(layer.key);
          const selectedMode = modeOptions.some((option) => option.value === layer.mode)
            ? layer.mode
            : modeOptions[0]?.value ?? '-';
          const palette = state.palettes[layer.key];
          const paletteVisible = layer.enabled && showsPalette(layer.mode) && Boolean(palette);

          return (
            <div key={layer.key} className="rvc-weather__layer-entry">
              <div className="rvc-weather__layer-row" data-disabled={!layer.enabled}>
                <Checkbox
                  id={`weather-${layer.key}`}
                  checked={layer.enabled}
                  onChange={(v) => onLayerToggle?.(layer.key, v)}
                />
                <span className="rvc-weather__layer-label">{LAYER_LABEL[layer.key]}</span>
                <Select
                  width={104}
                  value={selectedMode}
                  options={modeOptions}
                  onChange={(v) => onLayerModeChange?.(layer.key, v)}
                  className="rvc-weather__layer-select"
                />
              </div>

              {paletteVisible && palette ? (
                <div className="rvc-weather__palette-block">
                  <div className="rvc-row rvc-row--split rvc-altitude__opacity-row">
                    <span className="rvc-row__label">Opacité</span>
                    <div className="rvc-altitude__opacity-control">
                      <div className="rvc-altitude__opacity-slider-wrap">
                        <Slider
                          value={palette.opacity}
                          onChange={(value) => onPaletteOpacityChange?.(layer.key, value)}
                          width="100%"
                        />
                      </div>
                      <span className="rvc-altitude__opacity-value">{palette.opacity} %</span>
                    </div>
                  </div>

                  <div className="rvc-row rvc-row--split">
                    <span className="rvc-row__label">Échelle</span>
                    <Select
                      width={140}
                      value={palette.scaleSetting}
                      options={PALETTE_SCALE_OPTIONS}
                      onChange={(value) => onPaletteScaleSettingChange?.(layer.key, value as WeatherPaletteScaleSetting)}
                    />
                  </div>

                  <div className="rvc-altitude__bands">
                    {palette.bands.map((band, bandIndex) => (
                      <WeatherPaletteRow
                        key={band.id}
                        layerKey={layer.key}
                        band={band}
                        bandIndex={bandIndex}
                        totalBands={palette.bands.length}
                        onColorChange={onPaletteBandColorChange}
                        onVisibilityToggle={onPaletteBandVisibilityToggle}
                        onBreakpointChange={onPaletteBandBreakpointChange}
                      />
                    ))}
                  </div>
                </div>
              ) : null}
            </div>
          );
        })}
      </div>

      {/* Add alert toggle */}
      <div className="rvc-weather__add-alert">
        <Toggle checked={false} onChange={onAddAlert} />
        <span className="rvc-weather__add-alert-text">Ajouter des alertes</span>
        <IconInfo size={16} />
      </div>
    </Section>
  );
}
