import { useRef, useState } from 'react';
import { Section } from '../components/Section';
import { Checkbox } from '../components/Checkbox';
import { Select } from '../components/Select';
import { Toggle } from '../components/Toggle';
import { Slider } from '../components/Slider';
import { IconCalendar, IconClock, IconInfo } from '../icons';
import { CalendarPopover } from '@/features/itineraryPanel/components/calendar';
import type {
  ControlPanelHandlers,
  WeatherLayerKey,
  WeatherRenderMode,
  WeatherState,
  WeatherTab,
} from '../types';

interface Props {
  state: WeatherState;
  onEnabledChange: ControlPanelHandlers['onWeatherEnabledChange'];
  onTabChange: ControlPanelHandlers['onWeatherTabChange'];
  onDateChange: ControlPanelHandlers['onWeatherDateChange'];
  onLayerToggle: ControlPanelHandlers['onWeatherLayerToggle'];
  onLayerModeChange: ControlPanelHandlers['onWeatherLayerModeChange'];
  onAddAlert: ControlPanelHandlers['onWeatherAddAlert'];
}

const TABS: { value: WeatherTab; label: string }[] = [
  { value: 'forecast', label: 'Prochains jours' },
  { value: 'trends', label: 'Tendances' },
];

const LAYER_LABEL: Record<WeatherLayerKey, string> = {
  temperature: 'Température (°)',
  feelsLike: 'Température ressentie (°)',
  rain: 'Pluie (mm)',
  wind: 'Vent (km/h)',
  cloudCover: 'Couverture nuageuse (%)',
  humidity: 'Humidité (%)',
  sunshine: 'Ensoleillement (min)',
};

const MODE_OPTIONS: { value: WeatherRenderMode; label: string }[] = [
  { value: 'texte', label: 'Texte' },
  { value: 'gradient', label: 'Dégradé' },
  { value: 'arrows', label: 'Flèches' },
  { value: '-', label: '-' },
];

const FRENCH_DAYS = ['Dim', 'Lun', 'Mar', 'Mer', 'Jeu', 'Ven', 'Sam'];

function getForecastDayLabels(): string[] {
  const now = new Date();
  return [
    "Aujourd'hui",
    FRENCH_DAYS[(now.getDay() + 1) % 7],
    FRENCH_DAYS[(now.getDay() + 2) % 7],
  ];
}

/**
 * Converts ISO YYYY-MM-DD to display DD/MM/YY.
 */
function formatDateShort(iso: string): string {
  if (!iso || iso.length < 10) return iso;
  const [y, m, d] = iso.split('-');
  return `${d}/${m}/${y.slice(2)}`;
}

function getMonday(iso: string): string {
  const d = new Date(iso + 'T00:00:00');
  const day = d.getDay();
  const diff = d.getDate() - day + (day === 0 ? -6 : 1);
  d.setDate(diff);
  return d.toISOString().slice(0, 10);
}

function getSunday(mondayIso: string): string {
  const d = new Date(mondayIso + 'T00:00:00');
  d.setDate(d.getDate() + 6);
  return d.toISOString().slice(0, 10);
}

function formatWeekRange(iso: string): string {
  const monday = getMonday(iso);
  const sunday = getSunday(monday);
  return `${formatDateShort(monday)} - ${formatDateShort(sunday)}`;
}

export function WeatherSection({
  state,
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

  const [calendarOpen, setCalendarOpen] = useState(false);
  const calendarAnchorRef = useRef<HTMLDivElement>(null);

  const timeParts = (state.time || '00:00').split(':');
  const h = timeParts[0] || '00';
  const m = timeParts[1] || '00';

  const dayLabels = getForecastDayLabels();
  const isForecast = state.tab === 'forecast';
  const trendMode = state.trendMode ?? 'date';
  const forecastDay = state.forecastDay ?? 0;

  return (
    <Section
      title="Météo"
      toggle={{ checked: state.enabled, onChange: onEnabledChange }}
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
        <>
          {/* Trends: date or week selection */}
          <div className="rvc-weather__trend-options">
            <div className="rvc-weather__trend-option">
              <Checkbox
                id="weather-trend-date"
                checked={trendMode === 'date'}
                onChange={() => {
                  setCalendarOpen(false);
                  onDateChange?.({ trendMode: 'date' });
                }}
              />
              <span className="rvc-weather__trend-label">Choisir une date personnalisée</span>
              {trendMode === 'date' && (
                <div
                  ref={calendarAnchorRef}
                  className="rvc-weather__date-input"
                  onClick={() => setCalendarOpen((v) => !v)}
                  style={{ cursor: 'pointer' }}
                >
                  <IconCalendar size={12} />
                  <span>{formatDateShort(state.date)}</span>
                </div>
              )}
            </div>
            <div className="rvc-weather__trend-option">
              <Checkbox
                id="weather-trend-week"
                checked={trendMode === 'week'}
                onChange={() => {
                  setCalendarOpen(false);
                  onDateChange?.({ trendMode: 'week' });
                }}
              />
              <span className="rvc-weather__trend-label">Choisir une semaine personnalisée</span>
              {trendMode === 'week' && (
                <div
                  ref={calendarAnchorRef}
                  className="rvc-weather__date-input"
                  onClick={() => setCalendarOpen((v) => !v)}
                  style={{ cursor: 'pointer' }}
                >
                  <IconCalendar size={12} />
                  <span>{formatWeekRange(state.date)}</span>
                </div>
              )}
            </div>
          </div>
          <CalendarPopover
            open={calendarOpen}
            anchorRef={calendarAnchorRef}
            onClose={() => setCalendarOpen(false)}
            value={state.date}
            onSelect={(iso) => {
              const finalDate = trendMode === 'week' ? getMonday(iso) : iso;
              onDateChange?.({ date: finalDate });
              setCalendarOpen(false);
            }}
          />
        </>
      )}

      {/* Layer list */}
      <div className="rvc-weather__layers">
        {state.layers.map((layer) => (
          <div key={layer.key} className="rvc-weather__layer-row" data-disabled={!layer.enabled}>
            <Checkbox
              id={`weather-${layer.key}`}
              checked={layer.enabled}
              onChange={(v) => onLayerToggle?.(layer.key, v)}
            />
            <span className="rvc-weather__layer-label">{LAYER_LABEL[layer.key]}</span>
            <Select
              width={104}
              value={layer.mode}
              options={MODE_OPTIONS}
              onChange={(v) => onLayerModeChange?.(layer.key, v)}
            />
          </div>
        ))}
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
