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

/**
 * Converts ISO YYYY-MM-DD to display DD/MM/YY.
 */
function formatDateShort(iso: string): string {
  if (!iso || iso.length < 10) return iso;
  const [y, m, d] = iso.split('-');
  return `${d}/${m}/${y.slice(2)}`;
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
    onDateChange?.({ ...state, time: `${h}:${m}` });
  };

  const [calendarOpen, setCalendarOpen] = useState(false);
  const calendarAnchorRef = useRef<HTMLDivElement>(null);

  const timeParts = (state.time || '00:00').split(':');
  const h = timeParts[0] || '00';
  const m = timeParts[1] || '00';

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

      {/* Date row */}
      <div className="rvc-weather__date-row">
        <Checkbox
          id="weather-custom-date"
          checked={state.customDateEnabled}
          onChange={(checked) => onDateChange?.({ ...state, customDateEnabled: checked })}
        />
        <span className="rvc-weather__date-label">Choisir une date personalisée</span>
        <div
          ref={calendarAnchorRef}
          className="rvc-weather__date-input"
          onClick={() => setCalendarOpen((v) => !v)}
          style={{ cursor: 'pointer' }}
        >
          <IconCalendar size={12} />
          <span>{formatDateShort(state.date)}</span>
        </div>
        <CalendarPopover
          open={calendarOpen}
          anchorRef={calendarAnchorRef}
          onClose={() => setCalendarOpen(false)}
          value={state.date}
          onSelect={(iso) => onDateChange?.({ ...state, date: iso })}
        />
      </div>

      {/* Time row */}
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
            onChange={(e) => onDateChange?.({ ...state, time: e.target.value })}
            className="rvc-weather__native-input"
          />
        </div>
      </div>

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
