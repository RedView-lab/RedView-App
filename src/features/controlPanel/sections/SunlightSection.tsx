import { useCallback, useEffect, useRef, useState } from 'react';
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
  formatDurationShort,
  normalizeSunlightScaleSetting,
  parseDurationInput,
  resampleSunlightBands,
  SUPPORTED_SUNLIGHT_SCALE_SETTINGS,
  updateSunlightBandBreakpoint,
} from '../lib/sunlightConfig';
import type {
  ControlPanelHandlers,
  SunlightScaleSetting,
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

const SUNLIGHT_SCALE_OPTIONS = SUPPORTED_SUNLIGHT_SCALE_SETTINGS.map((setting) => ({
  value: setting,
  label: setting,
}));

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

// ── Inline editable duration input component ─────────────────────────

interface InlineDurationInputProps {
  valueMinutes: number;
  editable: boolean;
  onCommit: (minutes: number) => void;
  className?: string;
}

function InlineDurationInput({
  valueMinutes,
  editable,
  onCommit,
  className,
}: InlineDurationInputProps) {
  const { t } = useAppI18n();
  const [editing, setEditing] = useState(false);
  const display = formatDurationShort(valueMinutes);
  const [draft, setDraft] = useState(display);
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (!editing) {
      setDraft(formatDurationShort(valueMinutes));
    }
  }, [valueMinutes, editing]);

  useEffect(() => {
    if (editing && inputRef.current) {
      inputRef.current.focus();
      inputRef.current.select();
    }
  }, [editing]);

  const commit = useCallback(() => {
    setEditing(false);
    const parsed = parseDurationInput(draft);
    if (parsed === null || Number.isNaN(parsed)) {
      setDraft(display);
      return;
    }
    if (parsed !== valueMinutes) {
      onCommit(parsed);
    }
  }, [draft, valueMinutes, onCommit, display]);

  const handleKeyDown = useCallback(
    (e: React.KeyboardEvent) => {
      if (e.key === 'Enter') {
        e.preventDefault();
        commit();
      } else if (e.key === 'Escape') {
        setDraft(display);
        setEditing(false);
      }
    },
    [commit, display],
  );

  if (!editable) {
    return (
      <span className={`rvc-sunlight__duration-value ${className ?? ''}`}>
        {display}
      </span>
    );
  }

  if (!editing) {
    return (
      <button
        type="button"
        className={`rvc-sunlight__duration-btn ${className ?? ''}`}
        onClick={(e) => {
          e.stopPropagation();
          setDraft(display);
          setEditing(true);
        }}
        title={t("Cliquer pour modifier la durée d'ensoleillement")}
      >
        {display}
      </button>
    );
  }

  return (
    <input
      ref={inputRef}
      type="text"
      className={`rvc-sunlight__duration-input ${className ?? ''}`}
      value={draft}
      onChange={(e) => setDraft(e.target.value)}
      onBlur={commit}
      onKeyDown={handleKeyDown}
      onClick={(e) => e.stopPropagation()}
      maxLength={8}
      aria-label={t("Durée d'ensoleillement")}
    />
  );
}


// ── Main SunlightSection Component ───────────────────────────────────

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

  const handleBreakpointChange = (bandIndex: number, field: 'min' | 'max', valueMinutes: number) => {
    const updated = updateSunlightBandBreakpoint(state.bands, bandIndex, field, valueMinutes);
    onChange?.({ bands: updated });
  };

  const handleScaleSettingChange = (value: SunlightScaleSetting) => {
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
          <div className="rvc-sunlight__time-input rvc-sunlight__time-badge">
            <IconClock size={12} />
            <span>{displayTime}</span>
            <input
              type="time"
              value={displayTime}
              onChange={(e) => {
                if (e.target.value) {
                  onChange?.({ time: e.target.value });
                }
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

        <div className="rvc-sunlight__toggle-row">
          <button
            type="button"
            className="rvc-sunlight__toggle-label"
            onClick={() => onMapExpandedChange?.(!mapExpanded)}
            aria-expanded={mapExpanded}
          >
            <span className="rvc-sunlight__toggle-text">{t("Afficher la carte d'ensoleillement")}</span>
          </button>
          <div className="rvc-sunlight__toggle-actions">
            <Toggle
              checked={state.sunlightMapEnabled}
              onChange={(checked) => onChange?.({ sunlightMapEnabled: checked })}
              ariaLabel={t("Afficher la carte d'ensoleillement")}
            />
            <button
              type="button"
              className={`rvc-sunlight__toggle-chevron${mapExpanded ? ' is-open' : ''}`}
              onClick={() => onMapExpandedChange?.(!mapExpanded)}
              aria-label={mapExpanded ? t("Réduire la carte d'ensoleillement") : t("Développer la carte d'ensoleillement")}
            >
              <IconChevronDown size={16} />
            </button>
          </div>
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
                onChange={(value) => handleScaleSettingChange(value as SunlightScaleSetting)}
                className="rvc-sunlight__scale-select"
              />
            </div>

            <div className="rvc-sunlight__bands">
              {state.bands.map((band, index) => {
                const isFirst = index === 0;
                const minMinutes = band.minMinutes ?? 0;
                const maxMinutes = band.maxMinutes ?? 240;

                return (
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

                    <div className="rvc-sunlight__band-label-editable">
                      <InlineDurationInput
                        valueMinutes={minMinutes}
                        editable={!isFirst}
                        onCommit={(mins) => handleBreakpointChange(index, 'min', mins)}
                      />
                      <span className="rvc-sunlight__duration-sep">–</span>
                      <InlineDurationInput
                        valueMinutes={maxMinutes}
                        editable={true}
                        onCommit={(mins) => handleBreakpointChange(index, 'max', mins)}
                      />
                    </div>

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
                );
              })}
            </div>
          </div>
        ) : null}

        <div className="rvc-sunlight__toggle-row rvc-sunlight__toggle-row--compact">
          <span className="rvc-sunlight__toggle-text">{t('Afficher la trajectoire')}</span>
          <div className="rvc-sunlight__toggle-actions">
            <Toggle
              checked={state.trajectoryEnabled}
              onChange={(trajectoryEnabled) => onChange?.({ trajectoryEnabled })}
              ariaLabel={t('Afficher la trajectoire')}
            />
            <span className="rvc-sunlight__toggle-chevron-spacer" aria-hidden="true" />
          </div>
        </div>
      </div>
    </Section>
  );
}
