import { useEffect, useRef, useState } from 'react';
import { Section } from '../components/Section';
import { Checkbox } from '../components/Checkbox';
import { Slider } from '../components/Slider';
import { Select } from '../components/Select';
import { Toggle } from '../components/Toggle';
import { ColorPalettePicker } from '../components/ColorPalettePicker';
import { ColorSwatch } from '../components/ColorSwatch';
import { IconCalendar, IconChevronDown, IconClock, IconEye, IconEyeOff, IconSun, IconSunrise, IconSunset } from '../icons';
import { CalendarPopover } from '@/features/itineraryPanel/components/calendar';
import type { ControlPanelHandlers, SunlightState } from '../types';

interface Props {
  state: SunlightState;
  open?: boolean;
  onOpenChange?: (open: boolean) => void;
  mapExpanded?: boolean;
  onMapExpandedChange?: (open: boolean) => void;
  onEnabledChange: ControlPanelHandlers['onSunlightEnabledChange'];
  onChange: ControlPanelHandlers['onSunlightStateChange'];
}

type SunlightScaleSetting = '4 couleurs';

interface SunlightBand {
  id: string;
  label: string;
  color: string;
  visible: boolean;
}

const SUNLIGHT_SCALE_OPTIONS: { value: SunlightScaleSetting; label: string }[] = [
  { value: '4 couleurs', label: '4 couleurs' },
];

const DEFAULT_SUNLIGHT_BANDS: SunlightBand[] = [
  { id: '0-1', label: '0 - 1h', color: '#2DBF8C', visible: true },
  { id: '1-2', label: '1h - 2h', color: '#FFD800', visible: true },
  { id: '2-3', label: '2h - 3h', color: '#FF7200', visible: true },
  { id: '3-4', label: '3h - 4h', color: '#E50C0C', visible: true },
];

/**
 * Converts ISO YYYY-MM-DD to display DD/MM/YY.
 */
function formatDateShort(iso: string): string {
  if (!iso || iso.length < 10) return iso;
  const [y, m, d] = iso.split('-');
  return `${d}/${m}/${y.slice(2)}`;
}

function formatHexLabel(color: string): string {
  return color.replace('#', '').toUpperCase();
}

export function SunlightSection({
  state,
  open,
  onOpenChange,
  mapExpanded = true,
  onMapExpandedChange,
  onEnabledChange,
  onChange,
}: Props) {
  const [calendarOpen, setCalendarOpen] = useState(false);
  const [timeDraftMinutes, setTimeDraftMinutes] = useState(() => getMinutesFromTime('00:00'));
  const [isScrubbingTime, setIsScrubbingTime] = useState(false);
  const [scaleSetting, setScaleSetting] = useState<SunlightScaleSetting>('4 couleurs');
  const [sunlightBands, setSunlightBands] = useState<SunlightBand[]>(DEFAULT_SUNLIGHT_BANDS);
  const [trajectoryEnabled, setTrajectoryEnabled] = useState(true);
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

  const handleBandColorChange = (bandId: string, color: string) => {
    setSunlightBands((prev) => prev.map((band) => (band.id === bandId ? { ...band, color } : band)));
  };

  const handleBandVisibilityToggle = (bandId: string) => {
    setSunlightBands((prev) => prev.map((band) => (band.id === bandId ? { ...band, visible: !band.visible } : band)));
  };

  return (
    <Section
      title="Ensoleillement"
      icon={<IconSun size={16} />}
      toggle={{ checked: state.enabled, onChange: onEnabledChange }}
      open={open}
      onOpenChange={onOpenChange}
    >
      <div className="rvc-sunlight">
        <div className="rvc-sunlight__option-row">
          <div className="rvc-sunlight__option-main">
            <Checkbox
              id="sunlight-custom-date"
              checked={state.customDateEnabled}
              onChange={(checked) => onChange?.({ customDateEnabled: checked })}
            />
            <span className="rvc-sunlight__option-label">Choisir une date personnalisée</span>
            {state.customDateEnabled && (
              <div
                ref={calendarAnchorRef}
                className="rvc-sunlight__date-input"
                onClick={() => setCalendarOpen((value) => !value)}
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

        <div className="rvc-sunlight__time-row">
          <span className="rvc-sunlight__time-bound">00:00</span>
          <div className="rvc-sunlight__slider-shell">
            <Slider
              min={0}
              max={1439}
              value={isScrubbingTime ? timeDraftMinutes : getMinutesFromTime(state.time)}
              onChange={handleTimeSliderChange}
              onCommit={handleTimeSliderCommit}
              width="100%"
            />
          </div>
          <span className="rvc-sunlight__time-bound">23:59</span>
          <div className="rvc-sunlight__time-input">
            <IconClock size={12} />
            <div className="rvc-sunlight__time-display">
              <div className="rvc-sunlight__time-display-segment">{h}</div>
              <div className="rvc-sunlight__time-display-colon">:</div>
              <div className="rvc-sunlight__time-display-segment">{m}</div>
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
              className="rvc-sunlight__native-input"
            />
          </div>
        </div>

        {state.shadowEnabled ? (
          <div className="rvc-sunlight__opacity-row">
            <span className="rvc-sunlight__row-label">Opacité des ombres</span>
            <div className="rvc-sunlight__opacity-control">
              <div className="rvc-sunlight__opacity-slider-wrap">
                <Slider
                  min={0}
                  max={100}
                  value={state.shadowOpacity}
                  onChange={(val) => onChange?.({ shadowOpacity: val })}
                  onCommit={(val) => onChange?.({ shadowOpacity: val })}
                  width="100%"
                />
              </div>
              <span className="rvc-sunlight__shadow-opacity-value">{state.shadowOpacity}%</span>
            </div>
          </div>
        ) : null}

        <div className="rvc-sunlight__sun-row">
          <div className="rvc-sunlight__sun-item">
            <IconSunrise size={16} className="rvc-sunlight__sun-icon" />
            <div className="rvc-sunlight__sun-label">Lever</div>
            <div className="rvc-sunlight__sun-value">{state.sunriseTime}</div>
          </div>
          <div className="rvc-sunlight__sun-item">
            <IconSunset size={16} className="rvc-sunlight__sun-icon" />
            <div className="rvc-sunlight__sun-label">Coucher</div>
            <div className="rvc-sunlight__sun-value">{state.sunsetTime}</div>
          </div>
        </div>

        <div className="rvc-sunlight__toggle-row">
          <Toggle
            checked={state.shadowEnabled}
            onChange={(checked) => onChange?.({ shadowEnabled: checked })}
            ariaLabel="Afficher la carte d'ensoleillement"
          />
          <button
            type="button"
            className="rvc-sunlight__toggle-label"
            onClick={() => onMapExpandedChange?.(!mapExpanded)}
            aria-expanded={mapExpanded}
          >
            <span className="rvc-sunlight__toggle-text">Afficher la carte d’ensoleillement</span>
          </button>
          <button
            type="button"
            className={`rvc-sunlight__toggle-chevron${mapExpanded ? ' is-open' : ''}`}
            onClick={() => onMapExpandedChange?.(!mapExpanded)}
            aria-label={mapExpanded ? 'Réduire la carte d’ensoleillement' : 'Développer la carte d’ensoleillement'}
          >
            <IconChevronDown size={16} />
          </button>
        </div>

        {state.shadowEnabled && mapExpanded ? (
          <div className="rvc-sunlight__map-settings">
            <div className="rvc-sunlight__row rvc-sunlight__row--split">
              <span className="rvc-sunlight__row-label">Échelle</span>
              <Select
                width="var(--rvc-panel-select-md)"
                value={scaleSetting}
                options={SUNLIGHT_SCALE_OPTIONS}
                onChange={(value) => setScaleSetting(value as SunlightScaleSetting)}
                className="rvc-sunlight__scale-select"
              />
            </div>

            <div className="rvc-sunlight__bands">
              {sunlightBands.map((band) => (
                <div
                  key={band.id}
                  className={`rvc-sunlight__band-row${band.visible ? '' : ' is-hidden'}`}
                >
                  <button
                    type="button"
                    className="rvc-sunlight__band-eye"
                    onClick={() => handleBandVisibilityToggle(band.id)}
                    aria-label={band.visible ? `Masquer ${band.label}` : `Afficher ${band.label}`}
                  >
                    {band.visible ? <IconEye size={12.5} /> : <IconEyeOff size={12.5} />}
                  </button>
                  <span className="rvc-sunlight__band-label">{band.label}</span>
                  <ColorPalettePicker
                    color={band.color}
                    onChange={(color) => handleBandColorChange(band.id, color)}
                    className="rvc-sunlight__color-chip"
                    ariaLabel={`Choisir la couleur pour ${band.label}`}
                  >
                    <ColorSwatch color={band.color} size={12} />
                    <span className="rvc-sunlight__color-hex">{formatHexLabel(band.color)}</span>
                    <IconChevronDown size={20} className="rvc-sunlight__color-chevron" />
                  </ColorPalettePicker>
                </div>
              ))}
            </div>
          </div>
        ) : null}

        <div className="rvc-sunlight__toggle-row rvc-sunlight__toggle-row--compact">
          <Toggle
            checked={trajectoryEnabled}
            onChange={setTrajectoryEnabled}
            ariaLabel="Afficher la trajectoire"
          />
          <span className="rvc-sunlight__toggle-text">Afficher la trajectoire</span>
        </div>
      </div>
    </Section>
  );
}
