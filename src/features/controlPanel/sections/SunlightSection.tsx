import { useEffect, useRef, useState } from 'react';
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
  const [timeDraftMinutes, setTimeDraftMinutes] = useState(() => getMinutesFromTime('00:00'));
  const [isScrubbingTime, setIsScrubbingTime] = useState(false);
  const calendarAnchorRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!isScrubbingTime && !state.timeScrubbing) {
      setTimeDraftMinutes(getMinutesFromTime(state.time));
    }
  }, [isScrubbingTime, state.time, state.timeScrubbing]);

  function getMinutesFromTime(timeStr: string) {
    const [hh, mm] = timeStr.split(':').map(Number);
    return (hh || 0) * 60 + (mm || 0);
  }

  const formatMinutes = (val: number) => {
    const h = Math.floor(val / 60).toString().padStart(2, '0');
    const m = (val % 60).toString().padStart(2, '0');
    return `${h}:${m}`;
  };

  const emitTimeChange = (minutes: number, scrubbing: boolean) => {
    onChange?.({
      time: formatMinutes(minutes),
      timeScrubbing: scrubbing,
    });
  };

  const handleTimeSliderChange = (val: number) => {
    setIsScrubbingTime(true);
    setTimeDraftMinutes(val);
    emitTimeChange(val, true);
  };

  const handleTimeSliderCommit = (val: number) => {
    setIsScrubbingTime(false);
    setTimeDraftMinutes(val);
    emitTimeChange(val, false);
  };

  const displayTime = isScrubbingTime ? formatMinutes(timeDraftMinutes) : (state.time || '00:00');
  const timeParts = displayTime.split(':');
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
            value={isScrubbingTime ? timeDraftMinutes : getMinutesFromTime(state.time)}
            onChange={handleTimeSliderChange}
            onCommit={handleTimeSliderCommit}
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
            value={displayTime}
            onChange={(e) => {
              const nextMinutes = getMinutesFromTime(e.target.value);
              setIsScrubbingTime(false);
              setTimeDraftMinutes(nextMinutes);
              emitTimeChange(nextMinutes, false);
            }}
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

      {/* Shadow overlay controls */}
      <div className="rvc-weather__trend-options" style={{ marginTop: '8px' }}>
        <div className="rvc-weather__trend-option">
          <Checkbox
            id="sunlight-shadow"
            checked={state.shadowEnabled}
            onChange={(checked) => onChange?.({ shadowEnabled: checked })}
          />
          <span className="rvc-weather__trend-label">Ombres sur le terrain</span>
        </div>
      </div>
      {state.shadowEnabled && (
        <div className="rvc-weather__time-row" style={{ marginTop: '4px' }}>
          <span className="rvc-weather__time-bound" style={{ fontSize: '10px' }}>0%</span>
          <div style={{ flex: 1, padding: '0 4px', display: 'flex', alignItems: 'center' }}>
            <Slider
              min={0}
              max={100}
              value={state.shadowOpacity}
              onChange={(val) => onChange?.({ shadowOpacity: val })}
              width="100%"
            />
          </div>
          <span className="rvc-weather__time-bound" style={{ fontSize: '10px' }}>100%</span>
        </div>
      )}
    </Section>
  );
}
