import { useMemo, useRef, useState } from 'react';
import { useAppI18n } from '@/shared/i18n';
import { Section } from '@/features/controlPanel/components/Section';
import { Slider } from '@/features/controlPanel/components/Slider';
import { Select } from '@/features/controlPanel/components/Select';
import { IconCalendar, IconClock, IconSunrise, IconSunset } from '@/features/controlPanel/icons';
import { CalendarPopover } from '@/features/itineraryPanel/components/calendar';
import { CLOUD_PRESET_IDS, CLOUD_PRESETS } from './lib/cloudPresets';
import { formatClockMinutes, parseClockMinutes, photoTimePresets } from './lib/photoTime';
import type { CloudPresetId, PhotoCaptureStatus, PhotoModeState } from './types';
import './styles.css';

function formatDateShort(iso: string, locale: string): string {
  const value = new Date(`${iso}T00:00:00`);
  if (Number.isNaN(value.getTime())) return iso;
  return new Intl.DateTimeFormat(locale === 'fr' ? 'fr-FR' : 'en-US', {
    day: '2-digit',
    month: '2-digit',
    year: locale === 'fr' ? '2-digit' : 'numeric',
  }).format(value);
}

interface SliderRowProps {
  label: string;
  value: number;
  min: number;
  max: number;
  step?: number;
  display: string;
  disabled?: boolean;
  onChange: (value: number) => void;
}

function SliderRow({ label, value, min, max, step = 1, display, disabled, onChange }: SliderRowProps) {
  const { t } = useAppI18n();
  return (
    <div className="rvc-row rvc-row--split rvc-slopes__opacity-row">
      <span className="rvc-row__label">{t(label)}</span>
      <div className="rvc-slopes__opacity-control">
        <div className="rvc-slopes__opacity-slider-wrap">
          <Slider min={min} max={max} step={step} value={value} onChange={onChange} disabled={disabled} width="100%" />
        </div>
        <span className="rvc-slopes__opacity-value">{display}</span>
      </div>
    </div>
  );
}

export interface PhotoModeSectionProps {
  available: boolean;
  state: PhotoModeState;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onEnabledChange: (enabled: boolean) => void;
  onChange: (changes: Partial<PhotoModeState>) => void;
  sunriseTime: string;
  sunsetTime: string;
  /** Automatic cloud base (m) and the bounds of its offset. */
  cloudBase: { autoAltitudeM: number; minOffsetM: number; maxOffsetM: number };
  capture: PhotoCaptureStatus;
  onCapture: () => void;
}

export function PhotoModeSection({
  available,
  state,
  open,
  onOpenChange,
  onEnabledChange,
  onChange,
  sunriseTime,
  sunsetTime,
  cloudBase,
  capture,
  onCapture,
}: PhotoModeSectionProps) {
  const { locale, t } = useAppI18n();
  const [calendarOpen, setCalendarOpen] = useState(false);
  const calendarAnchorRef = useRef<HTMLDivElement>(null);
  const presets = useMemo(() => photoTimePresets(sunriseTime, sunsetTime), [sunriseTime, sunsetTime]);
  const cloudOptions = useMemo(
    () => CLOUD_PRESET_IDS.map((id) => ({ value: id, label: CLOUD_PRESETS[id].label })),
    [],
  );
  const minutes = parseClockMinutes(state.time);
  const noClouds = state.clouds === 'clear';
  const baseAltitude = Math.round(cloudBase.autoAltitudeM + state.cloudBaseOffsetM);
  const ev = state.exposureEv;

  return (
    <Section
      title="Mode photo"
      icon={<CameraGlyph />}
      toggle={{ checked: available && state.enabled, onChange: onEnabledChange, disabled: !available }}
      open={open}
      onOpenChange={onOpenChange}
    >
      {!available ? (
        <p className="rv-photo__note">{t('Disponible uniquement avec le moteur WebGPU.')}</p>
      ) : (
        <div className="rv-photo">
          <div className="rvc-row rvc-row--split">
            <span className="rvc-row__label">{t('Date')}</span>
            <div ref={calendarAnchorRef} className="rvc-sunlight__date-input" onClick={() => setCalendarOpen((value) => !value)}>
              <IconCalendar size={12} />
              <span>{formatDateShort(state.date, locale)}</span>
            </div>
          </div>
          <CalendarPopover
            open={calendarOpen}
            anchorRef={calendarAnchorRef}
            onClose={() => setCalendarOpen(false)}
            value={state.date}
            onSelect={(iso) => {
              onChange({ date: iso });
              setCalendarOpen(false);
            }}
          />

          <div className="rvc-sunlight__time-row">
            <span className="rvc-sunlight__time-bound">00:00</span>
            <div className="rvc-sunlight__slider-shell">
              <Slider min={0} max={1439} value={minutes} onChange={(value) => onChange({ time: formatClockMinutes(value) })} width="100%" />
            </div>
            <span className="rvc-sunlight__time-bound">23:59</span>
            <div className="rvc-sunlight__time-input rvc-sunlight__time-badge">
              <IconClock size={12} />
              <span>{state.time}</span>
              <input
                type="time"
                value={state.time}
                onChange={(e) => {
                  if (e.target.value) onChange({ time: e.target.value });
                }}
                className="rvc-sunlight__native-input"
                aria-label={t('Heure de la prise de vue')}
              />
            </div>
          </div>

          <div className="rv-photo__presets">
            {presets.map((preset) => (
              <button key={preset.label} type="button" className="rv-photo__chip" title={preset.time} onClick={() => onChange({ time: preset.time })}>
                {t(preset.label)}
              </button>
            ))}
          </div>

          <div className="rvc-sunlight__sun-row">
            <div className="rvc-sunlight__sun-item">
              <IconSunrise size={13.333} className="rvc-sunlight__sun-icon" />
              <div className="rvc-sunlight__sun-label">{t('Lever')}</div>
              <div className="rvc-sunlight__sun-value">{sunriseTime}</div>
            </div>
            <div className="rvc-sunlight__sun-item">
              <IconSunset size={13.333} className="rvc-sunlight__sun-icon" />
              <div className="rvc-sunlight__sun-label">{t('Coucher')}</div>
              <div className="rvc-sunlight__sun-value">{sunsetTime}</div>
            </div>
          </div>

          <div className="rv-photo__divider" />

          <div className="rvc-row rvc-row--split">
            <span className="rvc-row__label">{t('Nuages')}</span>
            <Select<CloudPresetId>
              width="var(--rvc-panel-select-md)"
              value={state.clouds}
              options={cloudOptions}
              onChange={(clouds) => onChange({ clouds, coverage: CLOUD_PRESETS[clouds].coverage })}
            />
          </div>
          <SliderRow
            label="Couverture"
            value={state.coverage}
            min={0}
            max={100}
            display={`${Math.round(state.coverage)} %`}
            disabled={noClouds}
            onChange={(coverage) => onChange({ coverage })}
          />
          <SliderRow
            label="Altitude des nuages"
            value={state.cloudBaseOffsetM}
            min={cloudBase.minOffsetM}
            max={cloudBase.maxOffsetM}
            step={50}
            display={`${baseAltitude.toLocaleString(locale === 'fr' ? 'fr-FR' : 'en-US')} m`}
            disabled={noClouds}
            onChange={(cloudBaseOffsetM) => onChange({ cloudBaseOffsetM })}
          />

          <div className="rv-photo__divider" />

          <SliderRow
            label="Brume"
            value={state.haze}
            min={0}
            max={100}
            display={`${Math.round(state.haze)} %`}
            onChange={(haze) => onChange({ haze })}
          />
          <SliderRow
            label="Exposition"
            value={Math.round(ev * 10)}
            min={-30}
            max={30}
            display={`${ev > 0 ? '+' : ''}${ev.toFixed(1)} EV`}
            onChange={(tenths) => onChange({ exposureEv: tenths / 10 })}
          />

          <button
            type="button"
            className={`rvc-btn-primary rv-photo__capture${capture.busy ? ' is-busy' : ''}`}
            disabled={!state.enabled || capture.busy}
            onClick={onCapture}
          >
            {capture.busy
              ? t('Préparation… {{done}}/{{total}}', { done: capture.done, total: capture.total })
              : t('Prendre la photo')}
          </button>
          {capture.error ? <p className="rv-photo__note" role="alert">{t('Capture impossible : {{message}}', { message: capture.error })}</p> : null}
          <p className="rv-photo__hint">{t('I : masquer l’interface')}</p>
        </div>
      )}
    </Section>
  );
}

function CameraGlyph() {
  return (
    <svg width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.333" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
      <path d="M2 5.5C2 4.95 2.45 4.5 3 4.5H4.8L5.9 3H10.1L11.2 4.5H13C13.55 4.5 14 4.95 14 5.5V12C14 12.55 13.55 13 13 13H3C2.45 13 2 12.55 2 12V5.5Z" />
      <circle cx="8" cy="8.6" r="2.4" />
    </svg>
  );
}
