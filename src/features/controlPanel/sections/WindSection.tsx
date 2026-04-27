import { useEffect, useState } from 'react';
import { ColorPalettePicker } from '../components/ColorPalettePicker';
import { Section } from '../components/Section';
import { Slider } from '../components/Slider';
import { Toggle } from '../components/Toggle';
import { IconCalendar, IconClock } from '../icons';

interface Props {
  enabled: boolean;
  open?: boolean;
  onOpenChange?: (v: boolean) => void;
  onEnabledChange?: (v: boolean) => void;
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

function formatTimeValue(totalMinutes: number): string {
  const hours = Math.floor(totalMinutes / 60);
  const minutes = totalMinutes % 60;
  return `${pad2(hours)}:${pad2(minutes)}`;
}

function minutesFromTimeString(value: string): number {
  const [hours, minutes] = value.split(':').map(Number);
  return (hours || 0) * 60 + (minutes || 0);
}

function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value));
}

function startOfDay(date: Date): Date {
  const next = new Date(date);
  next.setHours(0, 0, 0, 0);
  return next;
}

function diffDays(start: Date, end: Date): number {
  return Math.round((end.getTime() - start.getTime()) / 86400000);
}

function clampMinutesForDate(
  dateKey: string,
  minutes: number,
  minDateKey: string,
  maxDateKey: string,
  minMinutes: number,
  maxMinutes: number,
): number {
  const lowerBound = dateKey === minDateKey ? minMinutes : 0;
  const upperBound = dateKey === maxDateKey ? maxMinutes : 1439;
  return clamp(minutes, lowerBound, upperBound);
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
  enabled,
  open,
  onOpenChange,
  onEnabledChange,
}: Props) {
  const now = new Date();
  const startDate = startOfDay(now);
  const endDateTime = new Date(now.getTime() + 72 * 60 * 60 * 1000);
  const endDate = startOfDay(endDateTime);
  const startDateKey = formatDateKey(startDate);
  const endDateKey = formatDateKey(endDate);
  const maxDateOffset = diffDays(startDate, endDate);
  const nowMinutes = now.getHours() * 60 + now.getMinutes();
  const endMinutes = endDateTime.getHours() * 60 + endDateTime.getMinutes();

  const [dateOffset, setDateOffset] = useState(0);
  const [selectedDate, setSelectedDate] = useState(startDateKey);
  const [selectedMinutes, setSelectedMinutes] = useState(nowMinutes);
  const [particlesEnabled, setParticlesEnabled] = useState(true);
  const [terrainOverlayEnabled, setTerrainOverlayEnabled] = useState(true);
  const [bands, setBands] = useState<WindBand[]>(() => createWindBands());

  const isToday = selectedDate === startDateKey;
  const dateLabel = isToday ? 'Aujourd’hui' : formatDateShort(selectedDate);
  const minSelectableMinutes = selectedDate === startDateKey ? nowMinutes : 0;
  const maxSelectableMinutes = selectedDate === endDateKey ? endMinutes : 1439;
  const timeLabel = formatTimeValue(selectedMinutes);
  const [timeHours, timeMinutes] = timeLabel.split(':');

  const updateDateFromOffset = (offset: number) => {
    const nextOffset = clamp(offset, 0, maxDateOffset);
    const nextDate = new Date(startDate);
    nextDate.setDate(startDate.getDate() + nextOffset);
    const nextDateKey = formatDateKey(nextDate);
    setDateOffset(nextOffset);
    setSelectedDate(nextDateKey);
    setSelectedMinutes((current) => clampMinutesForDate(
      nextDateKey,
      current,
      startDateKey,
      endDateKey,
      nowMinutes,
      endMinutes,
    ));
  };

  const updateDateFromInput = (value: string) => {
    const parsed = new Date(`${value}T00:00:00`);
    if (Number.isNaN(parsed.getTime())) return;
    const startAtMidnight = new Date(startDate);
    startAtMidnight.setHours(0, 0, 0, 0);
    const diffMs = parsed.getTime() - startAtMidnight.getTime();
    const offset = Math.round(diffMs / 86400000);
    const clampedOffset = clamp(offset, 0, maxDateOffset);
    const nextDate = new Date(startDate);
    nextDate.setDate(startDate.getDate() + clampedOffset);
    const nextDateKey = formatDateKey(nextDate);
    setSelectedDate(nextDateKey);
    setDateOffset(clampedOffset);
    setSelectedMinutes((current) => clampMinutesForDate(
      nextDateKey,
      current,
      startDateKey,
      endDateKey,
      nowMinutes,
      endMinutes,
    ));
  };

  const updateTimeFromMinutes = (minutes: number) => {
    setSelectedMinutes(clampMinutesForDate(
      selectedDate,
      minutes,
      startDateKey,
      endDateKey,
      nowMinutes,
      endMinutes,
    ));
  };

  useEffect(() => {
    const resolvedDateKey = selectedDate < startDateKey
      ? startDateKey
      : selectedDate > endDateKey
      ? endDateKey
      : selectedDate;
    const resolvedOffset = diffDays(startDate, new Date(`${resolvedDateKey}T00:00:00`));

    if (resolvedDateKey !== selectedDate) {
      setSelectedDate(resolvedDateKey);
    }
    setDateOffset(resolvedOffset);
    setSelectedMinutes((current) => clampMinutesForDate(
      resolvedDateKey,
      current,
      startDateKey,
      endDateKey,
      nowMinutes,
      endMinutes,
    ));
  }, [selectedDate, startDateKey, endDateKey, maxDateOffset, nowMinutes, endMinutes]);

  return (
    <Section
      title="Vent"
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
          <span className="rvc-wind__bound">{formatTimeValue(minSelectableMinutes)}</span>
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
          <span className="rvc-wind__bound">{formatTimeValue(maxSelectableMinutes)}</span>
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
              step={900}
              min={formatTimeValue(minSelectableMinutes)}
              max={formatTimeValue(maxSelectableMinutes)}
              onChange={(event) => updateTimeFromMinutes(minutesFromTimeString(event.target.value))}
              aria-label="Sélectionner l'heure du vent"
            />
          </label>
        </div>

        <div className="rvc-wind__toggles">
          <WindToggleRow
            label="Particules"
            checked={particlesEnabled}
            onChange={setParticlesEnabled}
          />
          <WindToggleRow
            label="Overlay terrain"
            checked={terrainOverlayEnabled}
            onChange={setTerrainOverlayEnabled}
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
