import { useRef, useState } from 'react';
import { CheckboxField } from '../components/PanelCheckbox';
import { ToggleRow } from '../components/PanelToggle';
import { PauseIntervalList } from '../components/PauseIntervalList';
import { PoiPauseGrid } from '../components/PoiPauseGrid';
import { Collapse } from '../components/Collapse';
import { CalendarPopover } from '../components/calendar';
import {
  IconCalendar,
  IconClock,
  IconUpload,
  IconInfo,
  IconPlus,
  IconRepeat,
} from '../components/icons';
import type { PauseIntervalRow, RhythmState } from '../types';

interface RythmeSectionProps {
  rhythm: RhythmState;
  onChange?: <K extends keyof RhythmState>(key: K, value: RhythmState[K]) => void;
  onUploadFit?: () => void;
  onCalculate?: () => void;
}

function ChipInput({
  value,
  placeholder,
  onChange,
  ariaLabel,
}: {
  value: string;
  placeholder?: string;
  onChange?: (v: string) => void;
  ariaLabel?: string;
}) {
  return (
    <div className="rvi-chip-input">
      <input
        className="rvi-chip-input__native"
        value={value}
        onChange={(e) => onChange?.(e.target.value)}
        placeholder={placeholder}
        aria-label={ariaLabel}
      />
    </div>
  );
}

export function RythmeSection({
  rhythm,
  onChange,
  onUploadFit,
  onCalculate,
}: RythmeSectionProps) {
  const dateChipRef = useRef<HTMLButtonElement | null>(null);
  const [calendarOpen, setCalendarOpen] = useState(false);

  return (
    <div className="rvi-params">
      <div className="rvi-divider" />

      {/* Départ / Heure */}
      <div className="rvi-row">
        <div className="rvi-lfield">
          <span className="rvi-lfield__label">Départ :</span>
          <button
            type="button"
            ref={dateChipRef}
            className="rvi-datechip"
            onClick={() => setCalendarOpen((v) => !v)}
            aria-haspopup="dialog"
            aria-expanded={calendarOpen}
            aria-label="Date de départ"
          >
            <span className="rvi-datechip__icon">
              <IconCalendar size={12} />
            </span>
            <span>
              {rhythm.startDate ? formatDateFr(rhythm.startDate) : '--/--/--'}
            </span>
          </button>
          <CalendarPopover
            open={calendarOpen}
            anchorRef={dateChipRef}
            onClose={() => setCalendarOpen(false)}
            value={rhythm.startDate}
            onSelect={(iso) => onChange?.('startDate', iso)}
          />
        </div>
        <div className="rvi-lfield">
          <span className="rvi-lfield__label">Heure :</span>
          <label className="rvi-datechip">
            <span className="rvi-datechip__icon">
              <IconClock size={12} />
            </span>
            <span>{rhythm.startTime ?? '--:--'}</span>
            <input
              type="time"
              className="rvi-datechip__native"
              value={rhythm.startTime ?? ''}
              onChange={(e) => onChange?.('startTime', e.target.value || null)}
              aria-label="Heure de départ"
            />
          </label>
        </div>
      </div>

      {/* Activités passées + FTP */}
      <div className="rvi-row">
        <CheckboxField
          checked={rhythm.usePastActivities}
          onToggle={(v) => onChange?.('usePastActivities', v)}
          label="Activités passées"
          trailing={
            <button
              type="button"
              className="rvi-uploadchip"
              onClick={onUploadFit}
              aria-label="Uploader un fichier .fit"
            >
              <span className="rvi-uploadchip__icon">
                <IconUpload size={8} />
              </span>
              <span className="rvi-uploadchip__text">Upload .fit</span>
            </button>
          }
        />
        <CheckboxField
          checked={rhythm.ftp !== null}
          onToggle={(v) => onChange?.('ftp', v ? rhythm.ftp ?? 300 : null)}
          label="FTP :"
          trailing={
            <ChipInput
              value={rhythm.ftp !== null ? String(rhythm.ftp) : ''}
              placeholder="300"
              onChange={(v) => {
                const n = parseInt(v, 10);
                onChange?.('ftp', Number.isFinite(n) ? n : null);
              }}
              ariaLabel="FTP"
            />
          }
        />
      </div>

      {/* Poids + Pneus */}
      <div className="rvi-row">
        <CheckboxField
          checked={rhythm.systemWeightKg !== null}
          onToggle={(v) =>
            onChange?.('systemWeightKg', v ? rhythm.systemWeightKg ?? 95 : null)
          }
          label="Poids système :"
          trailing={
            <ChipInput
              value={rhythm.systemWeightKg !== null ? `${rhythm.systemWeightKg} kg` : ''}
              placeholder="95 kg"
              onChange={(v) => {
                const n = parseInt(v, 10);
                onChange?.('systemWeightKg', Number.isFinite(n) ? n : null);
              }}
              ariaLabel="Poids système"
            />
          }
        />
        <CheckboxField
          checked={rhythm.tiresMm !== null}
          onToggle={(v) => onChange?.('tiresMm', v ? rhythm.tiresMm ?? 35 : null)}
          label="Pneus :"
          trailing={
            <ChipInput
              value={rhythm.tiresMm !== null ? `${rhythm.tiresMm}mm` : ''}
              placeholder="35mm"
              onChange={(v) => {
                const n = parseInt(v, 10);
                onChange?.('tiresMm', Number.isFinite(n) ? n : null);
              }}
              ariaLabel="Pneus"
            />
          }
        />
      </div>

      {/* Météo + Surfaces */}
      <div className="rvi-row">
        <CheckboxField
          checked={rhythm.useWeather}
          onToggle={(v) => onChange?.('useWeather', v)}
          label="Météo"
          trailing={
            <ChipInput
              value={`${rhythm.weatherWeight}%`}
              placeholder="100%"
              onChange={(v) => {
                const n = parseInt(v, 10);
                if (Number.isFinite(n)) onChange?.('weatherWeight', n);
              }}
              ariaLabel="Poids météo"
            />
          }
        />
        <CheckboxField
          checked={rhythm.useSurfaces}
          onToggle={(v) => onChange?.('useSurfaces', v)}
          label="Surfaces"
          trailing={
            <ChipInput
              value={`${rhythm.surfacesWeight}%`}
              placeholder="100%"
              onChange={(v) => {
                const n = parseInt(v, 10);
                if (Number.isFinite(n)) onChange?.('surfacesWeight', n);
              }}
              ariaLabel="Poids surfaces"
            />
          }
        />
      </div>

      <div className="rvi-divider" />

      <ToggleRow
        checked={rhythm.pauseAtFavoritePois}
        onChange={(v) => onChange?.('pauseAtFavoritePois', v)}
        label="Ajouter des pauses à chaque POI favori"
        trailing={<IconInfo size={14} />}
      />

      <Collapse open={rhythm.pauseAtFavoritePois}>
        <PoiPauseGrid
          durations={rhythm.poiPauseDurations}
          onChange={(next) => onChange?.('poiPauseDurations', next)}
        />
      </Collapse>

      <div className="rvi-divider" />

      <ToggleRow
        checked={rhythm.pauseEveryIntervalEnabled}
        onChange={(v) => {
          onChange?.('pauseEveryIntervalEnabled', v);
          // First time we turn it on with no rows yet → seed one row.
          if (v && rhythm.pauseIntervals.length === 0) {
            onChange?.('pauseIntervals', [createPauseRow(1)]);
          }
        }}
        label="Ajouter des pauses par interval"
        trailing={
          <button
            type="button"
            className="rvi-iconbtn"
            aria-label="Ajouter une pause"
            onClick={(e) => {
              e.stopPropagation();
              if (!rhythm.pauseEveryIntervalEnabled) {
                onChange?.('pauseEveryIntervalEnabled', true);
              }
              const next = [
                ...rhythm.pauseIntervals,
                createPauseRow(rhythm.pauseIntervals.length + 1),
              ];
              onChange?.('pauseIntervals', next);
            }}
          >
            <IconPlus size={14} />
          </button>
        }
      />

      <Collapse
        open={rhythm.pauseEveryIntervalEnabled && rhythm.pauseIntervals.length > 0}
      >
        <PauseIntervalList
          rows={rhythm.pauseIntervals}
          onChange={(next) => onChange?.('pauseIntervals', relabel(next))}
        />
      </Collapse>

      <div className="rvi-divider" />

      <button
        type="button"
        className="rvi-redbtn rvi-redbtn--full"
        onClick={onCalculate}
      >
        <IconRepeat size={16} />
        <span>Calculer</span>
      </button>
    </div>
  );
}

function formatDateFr(iso: string): string {
  const d = new Date(iso + 'T00:00:00');
  if (Number.isNaN(d.getTime())) return iso;
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${pad(d.getDate())}/${pad(d.getMonth() + 1)}/${String(d.getFullYear()).slice(2)}`;
}

/** Default new pause row: 5 min duration every hour. */
function createPauseRow(index: number): PauseIntervalRow {
  return {
    id: `pause-${Date.now()}-${index}`,
    label: `Pause ${index}`,
    durationMin: 5,
    intervalMin: 60,
  };
}

/** Re-numbers rows after add/remove so labels stay sequential. */
function relabel(rows: PauseIntervalRow[]): PauseIntervalRow[] {
  return rows.map((r, i) => ({ ...r, label: `Pause ${i + 1}` }));
}
