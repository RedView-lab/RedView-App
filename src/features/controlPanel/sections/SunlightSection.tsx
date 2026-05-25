import { useRef, useState } from 'react';
import { useAppI18n } from '@/shared/i18n';
import { Section } from '../components/Section';
import { Checkbox } from '../components/Checkbox';
import { Slider } from '../components/Slider';
import { Select } from '../components/Select';
import { Toggle } from '../components/Toggle';
import { ColorPalettePicker } from '../components/ColorPalettePicker';
import { ColorSwatch } from '../components/ColorSwatch';
import { IconCalendar, IconChevronDown, IconClock, IconEye, IconEyeOff, IconSun, IconSunrise, IconSunset } from '../icons';
import { CalendarPopover } from '@/features/itineraryPanel/components/calendar';
import {
  normalizeSunlightScaleSetting,
  resampleSunlightBands,
} from '../lib/sunlightConfig';
import type {
  ControlPanelHandlers,
  SunlightState,
} from '../types';

interface Props {
  state: SunlightState;
  open?: boolean;
  onOpenChange?: (open: boolean) => void;
  mapExpanded?: boolean;
  onMapExpandedChange?: (open: boolean) => void;
  onEnabledChange: ControlPanelHandlers['onSunlightEnabledChange'];
  onChange: ControlPanelHandlers['onSunlightStateChange'];
}

type SunlightScaleOption = '4 couleurs';

const SUNLIGHT_SCALE_OPTIONS: { value: SunlightScaleOption; label: string }[] = [
  { value: '4 couleurs', label: '4 couleurs' },
];

/**
 * Converts ISO YYYY-MM-DD to display DD/MM/YY.
 */
function formatDateShort(iso: string, locale: string): string {
  const value = new Date(`${iso}T00:00:00`);
  if (Number.isNaN(value.getTime())) return iso;
  return new Intl.DateTimeFormat(locale === 'fr' ? 'fr-FR' : 'en-US', {
    day: '2-digit',
    month: '2-digit',
    year: locale === 'fr' ? '2-digit' : 'numeric',
  }).format(value);
}

function formatHexLabel(color: string): string {
  return color.replace('#', '').toUpperCase();
}

function getMinutesFromTime(timeStr: string) {
  const [hh, mm] = timeStr.split(':').map(Number);
  return (hh || 0) * 60 + (mm || 0);
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
  const { locale, t } = useAppI18n();
  const [calendarOpen, setCalendarOpen] = useState(false);
  const [timeDraftMinutes, setTimeDraftMinutes] = useState(() => getMinutesFromTime(state.time || '00:00'));
  const [isScrubbingTime, setIsScrubbingTime] = useState(false);
  const calendarAnchorRef = useRef<HTMLDivElement>(null);

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
    onChange?.({
      bands: state.bands.map((band) => (band.id === bandId ? { ...band, color } : band)),
    });
  };

  const handleBandVisibilityToggle = (bandId: string) => {
    onChange?.({
      bands: state.bands.map((band) => (band.id === bandId ? { ...band, visible: !band.visible } : band)),
    });
  };

  const handleScaleSettingChange = (value: SunlightScaleOption) => {
    const scaleSetting = normalizeSunlightScaleSetting(value);
    onChange?.({
      scaleSetting,
      bands: resampleSunlightBands(state.bands, scaleSetting),
    });
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
            <span className="rvc-sunlight__option-label">{t('Choisir une date personnalisée')}</span>
            {state.customDateEnabled && (
              <div
                ref={calendarAnchorRef}
                className="rvc-sunlight__date-input"
                onClick={() => setCalendarOpen((value) => !value)}
              >
                <IconCalendar size={12} />
                <span>{formatDateShort(state.date, locale)}</span>
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

        <div className="rvc-sunlight__sun-row">
          <div className="rvc-sunlight__sun-item">
            <IconSunrise size={13.333} className="rvc-sunlight__sun-icon" />
            <div className="rvc-sunlight__sun-label">{t('Lever')}</div>
            <div className="rvc-sunlight__sun-value">{state.sunriseTime}</div>
          </div>
          <div className="rvc-sunlight__sun-item">
            <IconSunset size={13.333} className="rvc-sunlight__sun-icon" />
            <div className="rvc-sunlight__sun-label">{t('Coucher')}</div>
            <div className="rvc-sunlight__sun-value">{state.sunsetTime}</div>
          </div>
        </div>

        {mapExpanded ? (
          <div className="rvc-sunlight__opacity-row">
            <span className="rvc-sunlight__row-label">{t('Opacité ombres')}</span>
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
              <span className="rvc-sunlight__shadow-opacity-value">{state.shadowOpacity} %</span>
            </div>
          </div>
        ) : null}

        <div className="rvc-sunlight__toggle-row">
          <Toggle
            checked={state.sunlightMapEnabled}
            onChange={(checked) => onChange?.({ sunlightMapEnabled: checked })}
            ariaLabel={t("Afficher la carte d'ensoleillement")}
          />
          <button
            type="button"
            className="rvc-sunlight__toggle-label"
            onClick={() => onMapExpandedChange?.(!mapExpanded)}
            aria-expanded={mapExpanded}
          >
            <span className="rvc-sunlight__toggle-text">{t("Afficher la carte d'ensoleillement")}</span>
          </button>
          <button
            type="button"
            className={`rvc-sunlight__toggle-chevron${mapExpanded ? ' is-open' : ''}`}
            onClick={() => onMapExpandedChange?.(!mapExpanded)}
            aria-label={mapExpanded ? t("Réduire la carte d'ensoleillement") : t("Développer la carte d'ensoleillement")}
          >
            <IconChevronDown size={16} />
          </button>
        </div>

        {mapExpanded ? (
          <div className="rvc-sunlight__map-settings">
            <div className="rvc-sunlight__opacity-row">
              <span className="rvc-sunlight__row-label">{t("Opacité carte d'ensoleillement")}</span>
              <div className="rvc-sunlight__opacity-control">
                <div className="rvc-sunlight__opacity-slider-wrap">
                  <Slider
                    min={0}
                    max={100}
                    value={state.sunlightMapOpacity}
                    onChange={(val) => onChange?.({ sunlightMapOpacity: val })}
                    onCommit={(val) => onChange?.({ sunlightMapOpacity: val })}
                    width="100%"
                  />
                </div>
                <span className="rvc-sunlight__shadow-opacity-value">{state.sunlightMapOpacity} %</span>
              </div>
            </div>

            <div className="rvc-sunlight__row rvc-sunlight__row--split">
              <span className="rvc-sunlight__row-label">{t('Échelle')}</span>
              <Select
                width="var(--rvc-panel-select-md)"
                value={state.scaleSetting}
                options={SUNLIGHT_SCALE_OPTIONS}
                  onChange={(value) => handleScaleSettingChange(value as SunlightScaleOption)}
                className="rvc-sunlight__scale-select"
              />
            </div>

            <div className="rvc-sunlight__bands">
              {state.bands.map((band) => (
                <div
                  key={band.id}
                  className={`rvc-sunlight__band-row${band.visible ? '' : ' is-hidden'}`}
                >
                  <button
                    type="button"
                    className="rvc-sunlight__band-eye"
                    onClick={() => handleBandVisibilityToggle(band.id)}
                    aria-label={band.visible ? t('Masquer la bande') : t('Afficher la bande')}
                  >
                    {band.visible ? <IconEye size={12.5} /> : <IconEyeOff size={12.5} />}
                  </button>
                  <span className="rvc-sunlight__band-label">{band.label}</span>
                  <ColorPalettePicker
                    color={band.color}
                    onChange={(color) => handleBandColorChange(band.id, color)}
                    className="rvc-sunlight__color-chip"
                    ariaLabel={t('Choisir la couleur de {{name}}', { name: band.label })}
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
            checked={state.trajectoryEnabled}
            onChange={(trajectoryEnabled) => onChange?.({ trajectoryEnabled })}
            ariaLabel={t('Afficher la trajectoire')}
          />
          <span className="rvc-sunlight__toggle-text">{t('Afficher la trajectoire')}</span>
        </div>
      </div>
    </Section>
  );
}
