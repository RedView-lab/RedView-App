import { useMemo } from 'react';
import { Section } from '../components/Section';
import { Checkbox } from '../components/Checkbox';
import { Select } from '../components/Select';
import { Toggle } from '../components/Toggle';
import { Slider } from '../components/Slider';
import { IconCalendar, IconClock, IconInfo } from '../icons';
import type {
  ControlPanelHandlers,
  WeatherLayerKey,
  WeatherRenderMode,
  WeatherState,
  WeatherTab,
} from '../types';

interface Props {
  state: WeatherState;
  open?: boolean;
  onOpenChange?: (open: boolean) => void;
  onEnabledChange: ControlPanelHandlers['onWeatherEnabledChange'];
  onTabChange: ControlPanelHandlers['onWeatherTabChange'];
  onDateChange: ControlPanelHandlers['onWeatherDateChange'];
  onLayerToggle: ControlPanelHandlers['onWeatherLayerToggle'];
  onLayerModeChange: ControlPanelHandlers['onWeatherLayerModeChange'];
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

const MODE_OPTIONS_BY_LAYER: Partial<Record<WeatherLayerKey, { value: WeatherRenderMode; label: string }[]>> = {
  temperature: TEXT_GRADIENT_FILL_OPTIONS,
  feelsLike: TEXT_GRADIENT_FILL_OPTIONS,
  rain: GRADIENT_FILL_OPTIONS,
  cloudCover: GRADIENT_FILL_OPTIONS,
  humidity: DISABLED_ONLY_OPTION,
};

const FRENCH_DAYS = ['Dim', 'Lun', 'Mar', 'Mer', 'Jeu', 'Ven', 'Sam'];

function getForecastDayLabels(): string[] {
  const now = new Date();
  return [
    "Aujourd'hui",
    FRENCH_DAYS[(now.getDay() + 1) % 7],
    FRENCH_DAYS[(now.getDay() + 2) % 7],
  ];
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

export function WeatherSection({
  state,
  open,
  onOpenChange,
  onEnabledChange,
  onTabChange,
  onDateChange,
  onLayerToggle,
  onLayerModeChange,
  onAddAlert,
}: Props) {
  const getMinutes = (timeStr: string) => {
    const [h, m] = timeStr.split(':').map(Number);
    return (h || 0) * 60 + (m || 0);
  };

  const handleTimeSliderChange = (val: number) => {
    const h = Math.floor(val / 60).toString().padStart(2, '0');
    const m = (val % 60).toString().padStart(2, '0');
    onDateChange?.({ time: `${h}:${m}` });
  };

  const timeParts = (state.time || '00:00').split(':');
  const h = timeParts[0] || '00';
  const m = timeParts[1] || '00';

  const dayLabels = getForecastDayLabels();
  const isForecast = state.tab === 'forecast';
  const forecastDay = state.forecastDay ?? 0;
  const trendMonth = getMonthIndexFromIso(state.date);
  const trendMonthLabel = getMonthLabel(state.date);
  const trendMonthValue = formatMonthInputValue(state.date);

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
                max={2}
                value={forecastDay}
                onChange={(v) => onDateChange?.({ forecastDay: v })}
                width="100%"
              />
            </div>
            <div className="rvc-weather__day-labels">
              {dayLabels.map((label, i) => (
                <button
                  key={i}
                  type="button"
                  className={`rvc-weather__day-label${forecastDay === i ? ' is-active' : ''}`}
                  onClick={() => onDateChange?.({ forecastDay: i })}
                >
                  {label}
                </button>
              ))}
            </div>
          </div>

          {/* Time row for forecast */}
          <div className="rvc-weather__time-row">
            <span className="rvc-weather__time-bound">00:00</span>
            <div style={{ flex: 1, padding: '0 4px', display: 'flex', alignItems: 'center' }}>
              <Slider
                min={0}
                max={1439}
                value={getMinutes(state.time)}
                onChange={handleTimeSliderChange}
                width="100%"
              />
            </div>
            <span className="rvc-weather__time-bound">23:59</span>
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

          return (
            <div key={layer.key} className="rvc-weather__layer-row" data-disabled={!layer.enabled}>
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
