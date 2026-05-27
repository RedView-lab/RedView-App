import { useRef, useState } from 'react';
import { Slider } from '@/features/controlPanel/components/Slider';
import { readDocumentAppLocale, translateAppText, useAppI18n } from '@/shared/i18n';
import { ActionButtonStack, CheckboxField, PanelSelect, ToggleRow } from '../components/controls';
import { Collapse } from '../components/shell';
import { PauseIntervalList, PoiPauseGrid } from './rythme/components';
import { CalendarPopover } from '../components/calendar';
import {
  IconCalendar,
  IconClock,
  IconUpload,
  IconInfo,
  IconPlus,
} from '../components/icons';
import type { PauseIntervalRow, RhythmGender, RhythmState } from '../types';

interface RythmeSectionProps {
  rhythm: RhythmState;
  onChange?: <K extends keyof RhythmState>(key: K, value: RhythmState[K]) => void;
  onUploadFit?: () => void;
  uploadFitLabel?: string;
  onCalculate?: () => void;
  onCancelCalculate?: () => void;
  calculateLabel?: string;
  calculateDisabled?: boolean;
  resultLabel?: string | null;
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

function TimeChipInput({
  displayTime,
  onChange,
  ariaLabel,
}: {
  displayTime: string;
  onChange?: (value: string | null) => void;
  ariaLabel: string;
}) {
  const [hours = '--', minutes = '--'] = displayTime.split(':');

  return (
    <div className="rvi-time-input">
      <span className="rvi-time-input__icon" aria-hidden="true">
        <IconClock size={12} />
      </span>
      <div className="rvi-time-input__display" aria-hidden="true">
        <div className="rvi-time-input__segment">{hours}</div>
        <span className="rvi-time-input__colon">
          :
        </span>
        <div className="rvi-time-input__segment">{minutes}</div>
      </div>
      <input
        type="time"
        value={displayTime}
        onChange={(event) => onChange?.(event.target.value || null)}
        className="rvi-time-input__native"
        aria-label={ariaLabel}
      />
    </div>
  );
}

const GENDER_OPTIONS: ReadonlyArray<{ value: RhythmGender; label: string }> = [
  { value: 'default', label: 'Défaut' },
  { value: 'male', label: 'Homme' },
  { value: 'female', label: 'Femme' },
];

export function RythmeSection({
  rhythm,
  onChange,
  onUploadFit,
  uploadFitLabel,
  onCalculate,
  onCancelCalculate,
  calculateLabel,
  calculateDisabled,
  resultLabel = null,
}: RythmeSectionProps) {
  const { locale, t } = useAppI18n();
  const dateChipRef = useRef<HTMLButtonElement | null>(null);
  const [calendarOpen, setCalendarOpen] = useState(false);
  const [timeDraftMinutes, setTimeDraftMinutes] = useState(() => getMinutesFromTime(rhythm.startTime || '00:00'));
  const [isScrubbingTime, setIsScrubbingTime] = useState(false);

  const displayTime = isScrubbingTime
    ? formatMinutes(timeDraftMinutes)
    : (rhythm.startTime || '00:00');

  const handleTimeSliderChange = (nextMinutes: number) => {
    setIsScrubbingTime(true);
    setTimeDraftMinutes(nextMinutes);
    onChange?.('startTime', formatMinutes(nextMinutes));
  };

  const handleTimeSliderCommit = (nextMinutes: number) => {
    setIsScrubbingTime(false);
    setTimeDraftMinutes(nextMinutes);
    onChange?.('startTime', formatMinutes(nextMinutes));
  };

  return (
    <div className="rvi-params">
      <div className="rvi-divider" />

      {/* Départ / Heure */}
      <div className="rvi-row">
        <div className="rvi-lfield">
          <span className="rvi-lfield__label">{t('Départ :')}</span>
          <button
            type="button"
            ref={dateChipRef}
            className="rvi-datechip"
            onClick={() => setCalendarOpen((v) => !v)}
            aria-haspopup="dialog"
            aria-expanded={calendarOpen}
            aria-label={t('Date de départ')}
          >
            <span className="rvi-datechip__icon">
              <IconCalendar size={12} />
            </span>
            <span>
              {rhythm.startDate ? formatDateForLocale(rhythm.startDate, locale) : '--/--/--'}
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
          <span className="rvi-lfield__label">{t('Heure :')}</span>
          <TimeChipInput
            displayTime={displayTime}
            ariaLabel={t('Heure de départ')}
            onChange={(nextValue) => {
              setIsScrubbingTime(false);
              setTimeDraftMinutes(getMinutesFromTime(nextValue || '00:00'));
              onChange?.('startTime', nextValue);
            }}
          />
        </div>
      </div>

      <div className="rvi-time-row">
        <span className="rvi-time-row__bound">00:00</span>
        <div className="rvi-time-row__slider-shell">
          <Slider
            min={0}
            max={1439}
            value={isScrubbingTime ? timeDraftMinutes : getMinutesFromTime(rhythm.startTime || '00:00')}
            onChange={handleTimeSliderChange}
            onCommit={handleTimeSliderCommit}
            width="100%"
          />
        </div>
        <span className="rvi-time-row__bound">23:59</span>
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
              aria-label={t('Uploader un fichier .fit')}
            >
              <span className="rvi-uploadchip__icon">
                <IconUpload size={8} />
              </span>
              <span className="rvi-uploadchip__text">{uploadFitLabel ?? t('Upload .fit')}</span>
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
              ariaLabel={t('FTP')}
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
              ariaLabel={t('Poids système')}
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
              ariaLabel={t('Pneus')}
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
              value={rhythm.useWeather ? `${rhythm.weatherWeight}%` : ''}
              placeholder={`${rhythm.weatherWeight}%`}
              onChange={(v) => {
                const n = parseInt(v, 10);
                if (Number.isFinite(n)) onChange?.('weatherWeight', n);
              }}
              ariaLabel={t('Poids météo')}
            />
          }
        />
        <CheckboxField
          checked={rhythm.useSurfaces}
          onToggle={(v) => onChange?.('useSurfaces', v)}
          label="Surfaces"
          trailing={
            <ChipInput
              value={rhythm.useSurfaces ? `${rhythm.surfacesWeight}%` : ''}
              placeholder={`${rhythm.surfacesWeight}%`}
              onChange={(v) => {
                const n = parseInt(v, 10);
                if (Number.isFinite(n)) onChange?.('surfacesWeight', n);
              }}
              ariaLabel={t('Poids surfaces')}
            />
          }
        />
      </div>

      <div className="rvi-row">
        <div className="rvi-lfield">
          <span className="rvi-lfield__label">{t('Sexe :')}</span>
          <PanelSelect<RhythmGender>
            value={rhythm.gender ?? 'default'}
            onChange={(value) => onChange?.('gender', value)}
            ariaLabel={t('Sexe pour la prédiction')}
            options={GENDER_OPTIONS}
          />
        </div>
      </div>

      <div className="rvi-divider" />

      <ToggleRow
        checked={rhythm.pauseAtFavoritePois}
        onChange={(v) => onChange?.('pauseAtFavoritePois', v)}
        label="Ajouter des pauses à chaque POI favori"
        trailing={<IconInfo size={14} />}
        trailingTight
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
            aria-label={t('Ajouter une pause')}
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

      <ActionButtonStack
        primaryLabel={t('Calculer')}
        onPrimaryClick={onCalculate}
        loadingLabel={calculateDisabled ? (calculateLabel ?? t('Calculer')) : null}
        onLoadingClick={onCancelCalculate}
        resultLabel={resultLabel}
      />
    </div>
  );
}

function formatDateForLocale(iso: string, locale: 'fr' | 'en'): string {
  const d = new Date(iso + 'T00:00:00');
  if (Number.isNaN(d.getTime())) return iso;
  return new Intl.DateTimeFormat(locale === 'fr' ? 'fr-FR' : 'en-US', {
    day: '2-digit',
    month: '2-digit',
    year: '2-digit',
  }).format(d);
}

function getMinutesFromTime(timeStr: string): number {
  const [hh, mm] = timeStr.split(':').map(Number);
  return (hh || 0) * 60 + (mm || 0);
}

function formatMinutes(value: number): string {
  const h = Math.floor(value / 60).toString().padStart(2, '0');
  const m = (value % 60).toString().padStart(2, '0');
  return `${h}:${m}`;
}

/** Default new pause row: 5 min duration every hour. */
function createPauseRow(index: number): PauseIntervalRow {
  return {
    id: `pause-${Date.now()}-${index}`,
    label: `${translateAppText('Pause', undefined, readDocumentAppLocale())} ${index}`,
    durationMin: 5,
    intervalMin: 60,
  };
}

/** Re-numbers rows after add/remove so labels stay sequential. */
function relabel(rows: PauseIntervalRow[]): PauseIntervalRow[] {
  const pauseLabel = translateAppText('Pause', undefined, readDocumentAppLocale());
  return rows.map((r, i) => ({ ...r, label: `${pauseLabel} ${i + 1}` }));
}
