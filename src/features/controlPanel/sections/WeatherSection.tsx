import { Section } from '../components/Section';
import { Checkbox } from '../components/Checkbox';
import { Select } from '../components/Select';
import { IconCalendar, IconClock, IconEye, IconPlusCircle } from '../icons';
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
  onRangeChange: ControlPanelHandlers['onWeatherRangeChange'];
  onLayerToggle: ControlPanelHandlers['onWeatherLayerToggle'];
  onLayerModeChange: ControlPanelHandlers['onWeatherLayerModeChange'];
  onLayerOpacityChange: ControlPanelHandlers['onWeatherLayerOpacityChange'];
  onAddAlert: ControlPanelHandlers['onWeatherAddAlert'];
}

const TABS: { value: WeatherTab; label: string }[] = [
  { value: 'forecast', label: 'Prochains jours' },
  { value: 'trends', label: 'Tendances' },
];

const LAYER_LABEL: Record<WeatherLayerKey, string> = {
  temperature: 'Température',
  weather: 'Météo',
  wind: 'Vent',
};

const MODE_OPTIONS: { value: WeatherRenderMode; label: string }[] = [
  { value: 'gradient', label: 'Dégradé' },
  { value: 'slope', label: 'Pente' },
  { value: 'arrows', label: 'Flèches' },
];

/**
 * Converts ISO YYYY-MM-DD to display DD/MM/YY.
 * (Matches the compact format shown in the Figma design: "22/04/26".)
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
  onRangeChange,
  onLayerToggle,
  onLayerModeChange,
  onLayerOpacityChange,
  onAddAlert,
}: Props) {
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

      {/* Date / time range — two columns */}
      <div className="rvc-weather__range">
        <div className="rvc-weather__range-col">
          <div className="rvc-weather__range-row">
            <span className="rvc-weather__range-label">Départ :</span>
            <div className="rvc-weather__input rvc-weather__input--date">
              <IconCalendar size={12} />
              <input
                type="date"
                value={state.startDate}
                onChange={(e) =>
                  onRangeChange?.({
                    startDate: e.target.value,
                    startTime: state.startTime,
                    endDate: state.endDate,
                    endTime: state.endTime,
                  })
                }
                className="rvc-weather__native-input"
              />
              <span>{formatDateShort(state.startDate)}</span>
            </div>
          </div>
          <div className="rvc-weather__range-row">
            <span className="rvc-weather__range-label">Heure :</span>
            <div className="rvc-weather__input">
              <IconClock size={12} />
              <input
                type="time"
                value={state.startTime}
                onChange={(e) =>
                  onRangeChange?.({
                    startDate: state.startDate,
                    startTime: e.target.value,
                    endDate: state.endDate,
                    endTime: state.endTime,
                  })
                }
                className="rvc-weather__native-input"
              />
              <span>{state.startTime}</span>
            </div>
          </div>
        </div>
        <div className="rvc-weather__range-col">
          <div className="rvc-weather__range-row">
            <span className="rvc-weather__range-label">Fin :</span>
            <div className="rvc-weather__input rvc-weather__input--date">
              <IconCalendar size={12} />
              <input
                type="date"
                value={state.endDate}
                onChange={(e) =>
                  onRangeChange?.({
                    startDate: state.startDate,
                    startTime: state.startTime,
                    endDate: e.target.value,
                    endTime: state.endTime,
                  })
                }
                className="rvc-weather__native-input"
              />
              <span>{formatDateShort(state.endDate)}</span>
            </div>
          </div>
          <div className="rvc-weather__range-row">
            <span className="rvc-weather__range-label">Heure :</span>
            <div className="rvc-weather__input">
              <IconClock size={12} />
              <input
                type="time"
                value={state.endTime}
                onChange={(e) =>
                  onRangeChange?.({
                    startDate: state.startDate,
                    startTime: state.startTime,
                    endDate: state.endDate,
                    endTime: e.target.value,
                  })
                }
                className="rvc-weather__native-input"
              />
              <span>{state.endTime}</span>
            </div>
          </div>
        </div>
      </div>

      {/* Layer list */}
      <div className="rvc-weather__layers">
        {state.layers.map((layer) => (
          <div key={layer.key} className="rvc-weather__layer-row">
            <Checkbox
              id={`weather-${layer.key}`}
              checked={layer.enabled}
              onChange={(v) => onLayerToggle?.(layer.key, v)}
            />
            <span className="rvc-weather__layer-label">{LAYER_LABEL[layer.key]}</span>
            <Select
              width={80}
              value={layer.mode}
              options={MODE_OPTIONS}
              onChange={(v) => onLayerModeChange?.(layer.key, v)}
            />
            <button
              type="button"
              className="rvc-weather__layer-opacity"
              aria-label="Opacité"
            >
              <IconEye size={10} />
              <span>{layer.opacity} %</span>
              <input
                type="range"
                min={0}
                max={100}
                value={layer.opacity}
                onChange={(e) => onLayerOpacityChange?.(layer.key, Number(e.target.value))}
                className="rvc-routes__opacity-range"
              />
            </button>
          </div>
        ))}
      </div>

      <button type="button" className="rvc-btn-ghost" onClick={onAddAlert}>
        <IconPlusCircle size={12} />
        <span>Ajouter des alertes sur l’itinéraire</span>
      </button>
    </Section>
  );
}
