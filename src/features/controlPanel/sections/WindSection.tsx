import { useState } from 'react';
import { FORECAST_MAX_DAY_OFFSET, getForecastDateForOffset, getForecastMaxMinutesForDate, getForecastMinMinutesForDate, getForecastOffsetForDate, getForecastBaseDate, minutesToTime, timeToMinutes } from '@/features/weather/lib/forecastTime';
import { snapWindMinutes } from '@/features/weather/lib/windSelection';
import type { WindPanelState } from '../types';
import { ColorPalettePicker } from '../components/ColorPalettePicker';
import { Section } from '../components/Section';
import { Slider } from '../components/Slider';
import { Toggle } from '../components/Toggle';
import { IconCalendar, IconClock, IconWind } from '../icons';

interface Props {
  state: WindPanelState;
  open?: boolean;
  onOpenChange?: (v: boolean) => void;
  onEnabledChange?: (v: boolean) => void;
  onDateChange?: (changes: Partial<Pick<WindPanelState, 'date' | 'time' | 'forecastDay' | 'particlesEnabled' | 'terrainOverlayEnabled'>>) => void;
}

interface WindBand {
  id: string;
  minKmh: number;
  color: string;
}

const WIND_SCALE_PRESETS = {
  '4 couleurs': {
    colors: ['#2DBF8C', '#FFD800', '#FF8D00', '#FF0D0D'],
    breakpoints: [15, 30, 50],
  },
  '6 couleurs': {
    colors: ['#2DBF8C', '#8AD64A', '#FFD800', '#FFB000', '#FF7A00', '#FF0D0D'],
    breakpoints: [10, 20, 30, 45, 60],
  },
  '8 couleurs': {
    colors: ['#2DBF8C', '#5BCF68', '#9EDD43', '#FFD800', '#FFB000', '#FF8D00', '#FF5A00', '#FF0D0D'],
    breakpoints: [5, 10, 20, 30, 40, 55, 70],
  },
} as const;

function pad2(value: number): string {
  return String(value).padStart(2, '0');
}

function formatDateKey(date: Date): string {
  const year = date.getFullYear();
  const month = pad2(date.getMonth() + 1);
  const day = pad2(date.getDate());
  return `${year}-${month}-${day}`;
}

function formatDateShort(value: string): string {
  const [year, month, day] = value.split('-').map(Number);
  if (!year || !month || !day) return value;
  return `${pad2(day)}.${pad2(month)}`;
}

function minutesFromTimeString(value: string): number {
  const [hours, minutes] = value.split(':').map(Number);
  return (hours || 0) * 60 + (minutes || 0);
}

function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value));
}

function createWindBands(): WindBand[] {
  const preset = WIND_SCALE_PRESETS['4 couleurs'];
  const stops = [0, ...preset.breakpoints];

  return preset.colors.map((color, index) => ({
    id: `wind-band-${index}`,
    minKmh: stops[index] ?? 0,
    color,
  }));
}

function formatWindBandLabel(minKmh: number): string {
  return `${minKmh} km/h`;
}

function WindBandRow({
  band,
  enabled,
  onColorChange,
}: {
  band: WindBand;
  enabled: boolean;
  onColorChange: (color: string) => void;
}) {
  return (
    <div className="rvc-wind__band-row" data-disabled={!enabled}>
      <span className="rvc-wind__band-threshold">{formatWindBandLabel(band.minKmh)}</span>

      <ColorPalettePicker
        color={band.color}
        onChange={onColorChange}
        className="rvc-wind__color-chip"
        ariaLabel={`Choisir la couleur du seuil ${formatWindBandLabel(band.minKmh)}`}
      >
        <span
          className="rvc-wind__color-swatch"
          style={{ backgroundColor: band.color }}
          aria-hidden
        />
        <span className="rvc-wind__color-value">{band.color.replace('#', '').toUpperCase()}</span>
      </ColorPalettePicker>
    </div>
  );
}

function WindToggleRow({
  label,
  checked,
  onChange,
}: {
  label: string;
  checked: boolean;
  onChange: (checked: boolean) => void;
}) {
  return (
    <div className="rvc-wind__toggle-row">
      <span className="rvc-wind__toggle-label">{label}</span>
      <Toggle checked={checked} onChange={onChange} ariaLabel={label} />
    </div>
  );
}

export function WindSection({
  state,
  open,
  onOpenChange,
  onEnabledChange,
  onDateChange,
}: Props) {
  const now = new Date();
  const startDateKey = formatDateKey(getForecastBaseDate(now));
  const endDateKey = getForecastDateForOffset(FORECAST_MAX_DAY_OFFSET, now);
  const maxDateOffset = FORECAST_MAX_DAY_OFFSET;

  const [bands, setBands] = useState<WindBand[]>(() => createWindBands());

  const enabled = state.enabled;
  const particlesEnabled = state.particlesEnabled;
  const terrainOverlayEnabled = state.terrainOverlayEnabled;
  const dateOffset = getForecastOffsetForDate(state.date, now);
  const selectedDate = state.date;
  const selectedMinutes = timeToMinutes(state.time);
  const isToday = selectedDate === startDateKey;
  const dateLabel = isToday ? 'Aujourd’hui' : formatDateShort(selectedDate);
  const minSelectableMinutes = getForecastMinMinutesForDate(selectedDate, now);
  const maxSelectableMinutes = getForecastMaxMinutesForDate(selectedDate);
  const timeLabel = minutesToTime(selectedMinutes);
  const [timeHours, timeMinutes] = timeLabel.split(':');

  const updateDateFromOffset = (offset: number) => {
    const nextOffset = clamp(offset, 0, maxDateOffset);
    onDateChange?.({
      date: getForecastDateForOffset(nextOffset, now),
      forecastDay: nextOffset,
    });
  };

  const updateDateFromInput = (value: string) => {
    if (!value) return;
    onDateChange?.({
      date: value,
      forecastDay: getForecastOffsetForDate(value, now),
    });
  };

  const updateTimeFromMinutes = (minutes: number) => {
    onDateChange?.({
      time: minutesToTime(snapWindMinutes(clamp(minutes, minSelectableMinutes, maxSelectableMinutes))),
    });
  };

  return (
    <Section
      title="Vent"
      icon={<IconWind size={16} />}
      toggle={{ checked: enabled, onChange: onEnabledChange }}
      open={open}
      onOpenChange={onOpenChange}
    >
      <div className="rvc-wind" aria-hidden={!enabled} data-disabled={!enabled}>
        <div className="rvc-wind__slider-row">
          <span className="rvc-wind__bound">{formatDateShort(startDateKey)}</span>
          <Slider
            width="100%"
            min={0}
            max={maxDateOffset}
            value={dateOffset}
            onChange={updateDateFromOffset}
            onCommit={updateDateFromOffset}
            handleSize={22}
            trackHeight={10}
          />
          <span className="rvc-wind__bound">{formatDateShort(endDateKey)}</span>
          <label className="rvc-wind__picker-chip rvc-wind__picker-chip--date">
            <IconCalendar size={12} className="rvc-wind__picker-icon" aria-hidden />
            <span className="rvc-wind__picker-value">{dateLabel}</span>
            <input
              className="rvc-wind__picker-input"
              type="date"
              value={selectedDate}
              min={startDateKey}
              max={endDateKey}
              onChange={(event) => updateDateFromInput(event.target.value)}
              aria-label="Sélectionner la date du vent"
            />
          </label>
        </div>

        <div className="rvc-wind__slider-row">
          <span className="rvc-wind__bound">{minutesToTime(minSelectableMinutes)}</span>
          <Slider
            width="100%"
            min={minSelectableMinutes}
            max={maxSelectableMinutes}
            value={selectedMinutes}
            onChange={updateTimeFromMinutes}
            onCommit={updateTimeFromMinutes}
            handleSize={22}
            trackHeight={10}
          />
          <span className="rvc-wind__bound">{minutesToTime(maxSelectableMinutes)}</span>
          <label className="rvc-wind__picker-chip rvc-wind__picker-chip--time">
            <IconClock size={12} className="rvc-wind__picker-icon" aria-hidden />
            <span className="rvc-wind__time-display" aria-hidden>
              <span className="rvc-wind__time-segment">{timeHours}</span>
              <span className="rvc-wind__time-colon">:</span>
              <span className="rvc-wind__time-segment">{timeMinutes}</span>
            </span>
            <input
              className="rvc-wind__picker-input"
              type="time"
              value={timeLabel}
              step={3600}
              min={minutesToTime(minSelectableMinutes)}
              max={minutesToTime(maxSelectableMinutes)}
              onChange={(event) => updateTimeFromMinutes(minutesFromTimeString(event.target.value))}
              aria-label="Sélectionner l'heure du vent"
            />
          </label>
        </div>

        <div className="rvc-wind__toggles">
          <WindToggleRow
            label="Particules"
            checked={particlesEnabled}
            onChange={(checked) => onDateChange?.({ particlesEnabled: checked })}
          />
          <WindToggleRow
            label="Overlay terrain"
            checked={terrainOverlayEnabled}
            onChange={(checked) => onDateChange?.({ terrainOverlayEnabled: checked })}
          />
        </div>

        <span className="rvc-wind__scale-label">Échelle</span>

        <div className="rvc-wind__bands">
          {bands.map((band) => (
            <WindBandRow
              key={band.id}
              band={band}
              enabled={enabled}
              onColorChange={(color) => {
                setBands((current) => current.map((entry) => (
                  entry.id === band.id ? { ...entry, color } : entry
                )));
              }}
            />
          ))}
        </div>
      </div>
    </Section>
  );
}
