import { useRef, useState } from 'react';
import { Section } from '../components/Section';
import { Checkbox } from '../components/Checkbox';
import { Slider } from '../components/Slider';
import { IconCalendar, IconClock } from '../icons';
import { IconSunrise, IconSunset } from '../icons';
import { CalendarPopover } from '@/features/itineraryPanel/components/calendar';
import type { ControlPanelHandlers, SunlightState } from '../types';

interface Props {
  state: SunlightState;
  onEnabledChange: ControlPanelHandlers['onSunlightEnabledChange'];
  onChange: ControlPanelHandlers['onSunlightStateChange'];
}

/**
 * Converts ISO YYYY-MM-DD to display DD/MM/YY.
 */
function formatDateShort(iso: string): string {
  if (!iso || iso.length < 10) return iso;
  const [y, m, d] = iso.split('-');
  return `${d}/${m}/${y.slice(2)}`;
}

export function SunlightSection({ state, onEnabledChange, onChange }: Props) {
  const [calendarOpen, setCalendarOpen] = useState(false);
  const calendarAnchorRef = useRef<HTMLDivElement>(null);

  const getMinutes = (timeStr: string) => {
    const [h, m] = timeStr.split(':').map(Number);
    return (h || 0) * 60 + (m || 0);
  };

  const handleTimeSliderChange = (val: number) => {
    const h = Math.floor(val / 60).toString().padStart(2, '0');
    const m = (val % 60).toString().padStart(2, '0');
    onChange?.({ time: `${h}:${m}` });
  };

  const timeParts = (state.time || '00:00').split(':');
  const h = timeParts[0] || '00';
  const m = timeParts[1] || '00';

  return (
    <Section
      title="Ensoleillement"
      toggle={{ checked: state.enabled, onChange: onEnabledChange }}
    >
      <div className="rvc-weather__trend-options">
        <div className="rvc-weather__trend-option">
          <Checkbox
            id="sunlight-custom-date"
            checked={state.customDateEnabled}
            onChange={(checked) => onChange?.({ customDateEnabled: checked })}
          />
          <span className="rvc-weather__trend-label">Choisir une date personnalisée</span>
          {state.customDateEnabled && (
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
      </div>
      
      <CalendarPopover
        open={calendarOpen}
        anchorRef={calendarAnchorRef}
        onClose={() => setCalendarOpen(false)}
        value={state.date}
        onSelect={(iso) => {
          onChange?.({ date: iso });
          setCalendarOpen(false);
        }}
      />

      <div className="rvc-weather__time-row" style={{ marginTop: '8px' }}>
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
            onChange={(e) => onChange?.({ time: e.target.value })}
            className="rvc-weather__native-input"
          />
        </div>
      </div>

      <div className="rvc-sunlight__sun-row">
        <div className="rvc-sunlight__sun-item">
          <IconSunrise size={16} />
          <div className="rvc-sunlight__sun-label">Lever</div>
          <div className="rvc-sunlight__sun-value">{state.sunriseTime}</div>
        </div>
        <div className="rvc-sunlight__sun-item">
          <IconSunset size={16} />
          <div className="rvc-sunlight__sun-label">Coucher</div>
          <div className="rvc-sunlight__sun-value">{state.sunsetTime}</div>
        </div>
      </div>
    </Section>
  );
}
