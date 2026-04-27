import { useEffect, useState } from 'react';
import { ColorPalettePicker } from '../components/ColorPalettePicker';
import { Section } from '../components/Section';
import { Select } from '../components/Select';
import { Slider } from '../components/Slider';
import {
  IconCalendar,
  IconChevronDown,
  IconClock,
  IconEye,
  IconEyeOff,
} from '../icons';

interface Props {
  enabled: boolean;
  loading: boolean;
  progress: number;
  detail: string | null;
  error: string | null;
  pointCount: number;
  lastUpdate: number | null;
  source: string | null;
  open?: boolean;
  onOpenChange?: (v: boolean) => void;
  onEnabledChange?: (v: boolean) => void;
}

type WindDisplayMode = 'arrows' | 'particles' | 'heatmap';
type WindScaleMode = '4 couleurs' | '6 couleurs' | '8 couleurs';

interface WindBand {
  id: string;
  minKmh: number;
  maxKmh: number | null;
  color: string;
  visible: boolean;
}

const DISPLAY_MODE_OPTIONS: { value: WindDisplayMode; label: string }[] = [
  { value: 'arrows', label: 'Flèches' },
  { value: 'particles', label: 'Particules' },
  { value: 'heatmap', label: 'Couche' },
];

const SCALE_OPTIONS: { value: WindScaleMode; label: string }[] = [
  { value: '4 couleurs', label: '4 couleurs' },
  { value: '6 couleurs', label: '6 couleurs' },
  { value: '8 couleurs', label: '8 couleurs' },
];

const WIND_SCALE_PRESETS: Record<WindScaleMode, { colors: string[]; breakpoints: number[] }> = {
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
};

const MAX_WIND_KMH = 160;

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

function formatSourceLabel(source: string | null): string | null {
  if (source === 'self-hosted-vps') return 'VPS';
  if (source === 'public-api') return 'Open-Meteo public';
  if (source === 'direct') return 'Endpoint direct';
  if (source === 'unknown') return 'Proxy';
  return null;
}

function createWindBands(scaleMode: WindScaleMode): WindBand[] {
  const preset = WIND_SCALE_PRESETS[scaleMode];
  const stops = [0, ...preset.breakpoints];

  return preset.colors.map((color, index) => ({
    id: `${scaleMode}-band-${index}`,
    minKmh: stops[index] ?? 0,
    maxKmh: preset.breakpoints[index] ?? null,
    color,
    visible: true,
  }));
}

function formatWindBandLabel(minKmh: number, maxKmh: number | null): string {
  if (maxKmh == null) return `> ${minKmh} km/h`;
  return `${minKmh} - ${maxKmh} km/h`;
}

function clampWindBoundary(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, Math.round(value)));
}

function InlineWindValue({
  value,
  editable,
  onCommit,
  ariaLabel,
}: {
  value: number;
  editable: boolean;
  onCommit: (value: number) => void;
  ariaLabel: string;
}) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(String(value));

  useEffect(() => {
    if (!editing) setDraft(String(value));
  }, [editing, value]);

  const commit = () => {
    setEditing(false);
    const parsed = Number.parseInt(draft, 10);
    if (!Number.isFinite(parsed)) return;
    onCommit(parsed);
  };

  if (!editable) {
    return <span className="rvc-altitude__meter-value rvc-wind__threshold-number">{value} km/h</span>;
  }

  if (!editing) {
    return (
      <button
        type="button"
        className="rvc-altitude__meter-btn rvc-wind__threshold-number"
        onClick={() => setEditing(true)}
        title="Cliquer pour modifier le seuil"
      >
        {value} km/h
      </button>
    );
  }

  return (
    <input
      type="text"
      inputMode="numeric"
      className="rvc-altitude__meter-input rvc-wind__threshold-input"
      value={draft}
      onChange={(event) => setDraft(event.target.value.replace(/[^\d]/g, ''))}
      onBlur={commit}
      onKeyDown={(event) => {
        if (event.key === 'Enter') {
          event.preventDefault();
          commit();
        }
        if (event.key === 'Escape') {
          setDraft(String(value));
          setEditing(false);
        }
      }}
      aria-label={ariaLabel}
    />
  );
}

function WindBandRow({
  band,
  index,
  totalBands,
  enabled,
  onThresholdChange,
  onToggleVisibility,
  onColorChange,
}: {
  band: WindBand;
  index: number;
  totalBands: number;
  enabled: boolean;
  onThresholdChange: (index: number, field: 'min' | 'max', value: number) => void;
  onToggleVisibility: () => void;
  onColorChange: (color: string) => void;
}) {
  const isFirst = index === 0;
  const isLast = index === totalBands - 1;

  return (
    <div className="rvc-wind__band-row" data-disabled={!enabled}>
      <button
        type="button"
        className="rvc-icon-btn rvc-icon-btn--ghost rvc-wind__band-eye"
        onClick={onToggleVisibility}
        aria-label={band.visible ? 'Masquer le seuil' : 'Afficher le seuil'}
      >
        {band.visible ? <IconEye size={12} /> : <IconEyeOff size={12} />}
      </button>

      <div className="rvc-altitude__band-label-editable rvc-wind__band-threshold-editable">
        {!isLast ? (
          <>
            <InlineWindValue
              value={band.minKmh}
              editable={!isFirst}
              onCommit={(value) => onThresholdChange(index, 'min', value)}
              ariaLabel="Seuil minimal du vent"
            />
            <span className="rvc-altitude__meter-sep">–</span>
            <InlineWindValue
              value={band.maxKmh ?? MAX_WIND_KMH}
              editable={true}
              onCommit={(value) => onThresholdChange(index, 'max', value)}
              ariaLabel="Seuil maximal du vent"
            />
          </>
        ) : (
          <div className="rvc-wind__band-threshold rvc-wind__band-threshold-tail">
            <span>&gt;</span>
            <InlineWindValue
              value={band.minKmh}
              editable={true}
              onCommit={(value) => onThresholdChange(index, 'min', value)}
              ariaLabel="Seuil minimal du dernier palier de vent"
            />
          </div>
        )}
      </div>

      <ColorPalettePicker
        color={band.color}
        onChange={onColorChange}
        className="rvc-wind__color-chip"
        ariaLabel={`Choisir la couleur du seuil ${formatWindBandLabel(band.minKmh, band.maxKmh)}`}
      >
        <span
          className="rvc-wind__color-swatch"
          style={{ backgroundColor: band.color }}
          aria-hidden
        />
        <span className="rvc-wind__color-value">{band.color.replace('#', '').toUpperCase()}</span>
        <IconChevronDown size={20} className="rvc-wind__color-chevron" aria-hidden />
      </ColorPalettePicker>
    </div>
  );
}

export function WindSection({
  enabled,
  loading,
  progress,
  detail,
  error,
  pointCount,
  lastUpdate,
  source,
  open,
  onOpenChange,
  onEnabledChange,
}: Props) {
  const today = new Date();
  const startDate = new Date(today);
  startDate.setDate(today.getDate() - 2);
  const endDate = new Date(today);
  endDate.setDate(today.getDate() + 2);

  const [dateOffset, setDateOffset] = useState(2);
  const [selectedDate, setSelectedDate] = useState(formatDateKey(today));
  const [selectedMinutes, setSelectedMinutes] = useState(9 * 60 + 30);
  const [displayMode, setDisplayMode] = useState<WindDisplayMode>('arrows');
  const [scaleMode, setScaleMode] = useState<WindScaleMode>('4 couleurs');
  const [bands, setBands] = useState<WindBand[]>(() => createWindBands('4 couleurs'));

  const isToday = selectedDate === formatDateKey(today);
  const dateLabel = isToday ? 'Aujourd’hui' : formatDateShort(selectedDate);
  const timeLabel = formatTimeValue(selectedMinutes);
  const [timeHours, timeMinutes] = timeLabel.split(':');
  const sourceLabel = formatSourceLabel(source);
  const updatedLabel = lastUpdate
    ? new Date(lastUpdate).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
    : null;
  const statusText = error
    ? error
    : detail ?? (enabled && pointCount > 0 ? 'Champ de vent prêt' : null);

  const updateDateFromOffset = (offset: number) => {
    const nextOffset = clamp(offset, 0, 4);
    const nextDate = new Date(startDate);
    nextDate.setDate(startDate.getDate() + nextOffset);
    setDateOffset(nextOffset);
    setSelectedDate(formatDateKey(nextDate));
  };

  const updateDateFromInput = (value: string) => {
    const parsed = new Date(`${value}T00:00:00`);
    if (Number.isNaN(parsed.getTime())) return;
    const startAtMidnight = new Date(startDate);
    startAtMidnight.setHours(0, 0, 0, 0);
    const diffMs = parsed.getTime() - startAtMidnight.getTime();
    const offset = Math.round(diffMs / 86400000);
    setSelectedDate(value);
    setDateOffset(clamp(offset, 0, 4));
  };

  const updateTimeFromMinutes = (minutes: number) => {
    setSelectedMinutes(clamp(minutes, 0, 1439));
  };

  useEffect(() => {
    setBands(createWindBands(scaleMode));
  }, [scaleMode]);

  const updateBandThreshold = (index: number, field: 'min' | 'max', value: number) => {
    setBands((current) => {
      const next = current.map((band) => ({ ...band }));
      const band = next[index];
      if (!band) return current;

      if (field === 'max') {
        const upperBound = index >= next.length - 2
          ? MAX_WIND_KMH
          : (next[index + 1].maxKmh ?? MAX_WIND_KMH) - 1;
        const nextValue = clampWindBoundary(value, band.minKmh + 1, upperBound);
        band.maxKmh = nextValue;
        if (next[index + 1]) next[index + 1].minKmh = nextValue;
        return next;
      }

      if (index === 0) return current;
      const previousBand = next[index - 1];
      const upperBound = (band.maxKmh ?? MAX_WIND_KMH) - 1;
      const lowerBound = (previousBand.minKmh ?? 0) + 1;
      const nextValue = clampWindBoundary(value, lowerBound, upperBound);
      band.minKmh = nextValue;
      previousBand.maxKmh = nextValue;
      return next;
    });
  };

  return (
    <Section
      title="Vent"
      toggle={{ checked: enabled, onChange: onEnabledChange }}
      open={open}
      onOpenChange={onOpenChange}
    >
      <div className="rvc-wind" aria-hidden={!enabled} data-disabled={!enabled}>
        {enabled && (statusText || loading || pointCount > 0 || sourceLabel || updatedLabel) ? (
          <div className={`rvc-wind__status${error ? ' is-error' : ''}`}>
            <div className="rvc-wind__status-head">
              <span className="rvc-wind__status-text">{statusText ?? 'Vent activé'}</span>
              {loading ? (
                <span className="rvc-wind__status-value">{Math.round(progress)}%</span>
              ) : pointCount > 0 ? (
                <span className="rvc-wind__status-value">{pointCount} pts</span>
              ) : null}
            </div>
            {loading ? (
              <div className="rvc-wind__status-bar" aria-hidden="true">
                <span className="rvc-wind__status-bar-fill" style={{ width: `${Math.max(6, progress)}%` }} />
              </div>
            ) : null}
            {sourceLabel || updatedLabel ? (
              <div className="rvc-wind__status-meta">
                {sourceLabel ? `Source ${sourceLabel}` : 'Source inconnue'}
                {updatedLabel ? ` · MAJ ${updatedLabel}` : ''}
              </div>
            ) : null}
          </div>
        ) : null}

        <div className="rvc-wind__slider-row">
          <span className="rvc-wind__bound">{formatDateShort(formatDateKey(startDate))}</span>
          <Slider
            width="100%"
            min={0}
            max={4}
            value={dateOffset}
            onChange={updateDateFromOffset}
            onCommit={updateDateFromOffset}
          />
          <span className="rvc-wind__bound">{formatDateShort(formatDateKey(endDate))}</span>
          <label className="rvc-wind__picker-chip rvc-wind__picker-chip--date">
            <IconCalendar size={12} className="rvc-wind__picker-icon" aria-hidden />
            <span className="rvc-wind__picker-value">{dateLabel}</span>
            <input
              className="rvc-wind__picker-input"
              type="date"
              value={selectedDate}
              min={formatDateKey(startDate)}
              max={formatDateKey(endDate)}
              onChange={(event) => updateDateFromInput(event.target.value)}
              aria-label="Sélectionner la date du vent"
            />
          </label>
        </div>

        <div className="rvc-wind__slider-row">
          <span className="rvc-wind__bound">00:00</span>
          <Slider
            width="100%"
            min={0}
            max={1439}
            value={selectedMinutes}
            onChange={updateTimeFromMinutes}
            onCommit={updateTimeFromMinutes}
          />
          <span className="rvc-wind__bound">23:59</span>
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
              onChange={(event) => updateTimeFromMinutes(minutesFromTimeString(event.target.value))}
              aria-label="Sélectionner l'heure du vent"
            />
          </label>
        </div>

        <div className="rvc-wind__field-row">
          <span className="rvc-wind__field-label">Mode d’affichage</span>
          <Select
            className="rvc-wind__select rvc-wind__select--outlined"
            width="var(--rvc-panel-select-sm)"
            value={displayMode}
            options={DISPLAY_MODE_OPTIONS}
            onChange={setDisplayMode}
          />
        </div>

        <div className="rvc-wind__field-row">
          <span className="rvc-wind__field-label rvc-wind__field-label--semibold">Échelle</span>
          <Select
            className="rvc-wind__select rvc-wind__select--solid"
            width="var(--rvc-panel-select-md)"
            value={scaleMode}
            options={SCALE_OPTIONS}
            onChange={setScaleMode}
          />
        </div>

        <div className="rvc-wind__bands">
          {bands.map((band, index) => (
            <WindBandRow
              key={band.id}
              band={band}
              index={index}
              totalBands={bands.length}
              enabled={enabled}
              onThresholdChange={updateBandThreshold}
              onToggleVisibility={() => {
                setBands((current) => current.map((entry) => (
                  entry.id === band.id ? { ...entry, visible: !entry.visible } : entry
                )));
              }}
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
