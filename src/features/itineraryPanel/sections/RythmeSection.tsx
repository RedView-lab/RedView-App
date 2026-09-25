import { useEffect, useRef, useState, useMemo } from 'react';
import { readDocumentAppLocale, translateAppText, useAppI18n } from '@/shared/i18n';
import { ActionButtonStack, ToggleRow } from '../components/controls';
import { PortalDropdown } from '../components/controls/PortalDropdown';
import { Collapse } from '../components/shell';
import { PauseIntervalList, PoiPauseGrid } from './rythme/components';
import { CalendarPopover } from '../components/calendar';
import { IconInfo, IconPlus } from '../components/icons';
import { IconFigmaCheck } from '../components/iconsFigma';
import type { PauseIntervalRow, RhythmState } from '../types';

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

const PRACTICE_LEVELS = [
  { id: 'debutant', label: 'Débutant' },
  { id: 'intermediaire', label: 'Intermédiaire' },
  { id: 'avance', label: 'Avancé' },
  { id: 'expert', label: 'Expert' },
] as const;

const TIRE_OPTIONS = [28, 30, 32, 35, 38, 40, 45, 50];

function CalendarIcon({ size = 10 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 20 20" fill="none" style={{ flexShrink: 0 }}>
      <path
        d="M17.5 8.33366H2.5M13.3333 1.66699V5.00033M6.66667 1.66699V5.00033M6.5 18.3337H13.5C14.9001 18.3337 15.6002 18.3337 16.135 18.0612C16.6054 17.8215 16.9878 17.439 17.2275 16.9686C17.5 16.4339 17.5 15.7338 17.5 14.3337V7.33366C17.5 5.93353 17.5 5.23346 17.2275 4.69868C16.9878 4.22828 16.6054 3.84583 16.135 3.60614C15.6002 3.33366 14.9001 3.33366 13.5 3.33366H6.5C5.09987 3.33366 4.3998 3.33366 3.86502 3.60614C3.39462 3.84583 3.01217 4.22828 2.77248 4.69868C2.5 5.23346 2.5 5.93353 2.5 7.33366V14.3337C2.5 15.7338 2.5 16.4339 2.77248 16.9686C3.01217 17.439 3.39462 17.8215 3.86502 18.0612C4.3998 18.3337 5.09987 18.3337 6.5 18.3337Z"
        stroke="currentColor"
        strokeWidth="1.66667"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}

function ClockIcon({ size = 12 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" style={{ flexShrink: 0 }}>
      <path
        d="M12 6V12L16 14M22 12C22 17.5228 17.5228 22 12 22C6.47715 22 2 17.5228 2 12C2 6.47715 6.47715 2 12 2C17.5228 2 22 6.47715 22 12Z"
        stroke="currentColor"
        strokeWidth="2"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}

function ChevronSelectorVerticalIcon({ size = 20 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" style={{ flexShrink: 0, opacity: 0.85 }}>
      <path
        d="M7 15L12 20L17 15M7 9L12 4L17 9"
        stroke="currentColor"
        strokeWidth="2"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}

function UploadFitIcon({ size = 14 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 36 36" fill="none" style={{ flexShrink: 0 }}>
      <path
        d="M27 18V22.2C27 23.8802 27 24.7202 26.673 25.362C26.3854 25.9265 25.9265 26.3854 25.362 26.673C24.7202 27 23.8802 27 22.2 27H13.8C12.1198 27 11.2798 27 10.638 26.673C10.0735 26.3854 9.6146 25.9265 9.32698 25.362C9 24.7202 9 23.8802 9 22.2V18M14 13L18 9L22 13M18 9V21"
        stroke="currentColor"
        strokeWidth="2.5"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}

function parseTimeDigits(timeStr: string | null | undefined): [string, string, string, string] {
  if (!timeStr) return ['0', '9', '3', '0'];
  const [h = '09', m = '30'] = timeStr.split(':');
  const hPad = h.padStart(2, '0');
  const mPad = m.padStart(2, '0');
  return [hPad[0] || '0', hPad[1] || '9', mPad[0] || '3', mPad[1] || '0'];
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
  const [digits, setDigits] = useState<[string, string, string, string]>(() => parseTimeDigits(displayTime));
  const [activeSlot, setActiveSlot] = useState<number | null>(null);
  const inputRef = useRef<HTMLInputElement | null>(null);

  useEffect(() => {
    setDigits(parseTimeDigits(displayTime));
  }, [displayTime]);

  const commitTime = (d: [string, string, string, string]) => {
    const formatted = `${d[0]}${d[1]}:${d[2]}${d[3]}`;
    onChange?.(formatted);
  };

  const handleKeyDown = (event: React.KeyboardEvent<HTMLInputElement>) => {
    if (event.key === 'Tab') return;
    if (event.key === 'Enter') {
      event.preventDefault();
      setActiveSlot(null);
      inputRef.current?.blur();
      return;
    }
    if (event.key === 'Escape') {
      event.preventDefault();
      const reverted = parseTimeDigits(displayTime);
      setDigits(reverted);
      commitTime(reverted);
      setActiveSlot(null);
      inputRef.current?.blur();
      return;
    }

    const currentSlot = activeSlot ?? 0;
    if (event.key === 'ArrowLeft') {
      event.preventDefault();
      setActiveSlot(Math.max(0, currentSlot - 1));
      return;
    }
    if (event.key === 'ArrowRight') {
      event.preventDefault();
      setActiveSlot(Math.min(3, currentSlot + 1));
      return;
    }
    if (event.key === ':' || event.key === 'h' || event.key === 'H') {
      event.preventDefault();
      setActiveSlot(2);
      return;
    }
    if (event.key === 'Backspace') {
      event.preventDefault();
      const next: [string, string, string, string] = [...digits];
      next[currentSlot] = '0';
      setDigits(next);
      commitTime(next);
      setActiveSlot(Math.max(0, currentSlot - 1));
      return;
    }
    if (event.key >= '0' && event.key <= '9') {
      event.preventDefault();
      const next: [string, string, string, string] = [...digits];
      if (currentSlot === 0) {
        if (event.key <= '2') next[0] = event.key;
      } else if (currentSlot === 1) {
        if (next[0] === '2' && event.key > '3') next[1] = '3';
        else next[1] = event.key;
      } else if (currentSlot === 2) {
        if (event.key <= '5') next[2] = event.key;
      } else if (currentSlot === 3) {
        next[3] = event.key;
      }
      setDigits(next);
      commitTime(next);
      setActiveSlot(Math.min(3, currentSlot + 1));
    }
  };

  return (
    <div
      className="rvi-rythme-figma__time-chip"
      onClick={() => {
        inputRef.current?.focus();
        if (activeSlot === null) setActiveSlot(0);
      }}
      role="group"
      aria-label={ariaLabel}
    >
      <input
        ref={inputRef}
        type="text"
        className="rvi-rythme-figma__time-sr-input"
        tabIndex={0}
        onFocus={() => {
          if (activeSlot === null) setActiveSlot(0);
        }}
        onBlur={() => setActiveSlot(null)}
        onKeyDown={handleKeyDown}
        aria-label={ariaLabel}
      />
      <ClockIcon size={12} />
      <span className="rvi-rythme-figma__time-digits">
        <span className="rvi-rythme-figma__time-pill">
          <span className={activeSlot === 0 ? 'is-active' : ''}>{digits[0]}</span>
          <span className={activeSlot === 1 ? 'is-active' : ''}>{digits[1]}</span>
        </span>
        <span className="rvi-rythme-figma__time-colon">:</span>
        <span className="rvi-rythme-figma__time-pill">
          <span className={activeSlot === 2 ? 'is-active' : ''}>{digits[2]}</span>
          <span className={activeSlot === 3 ? 'is-active' : ''}>{digits[3]}</span>
        </span>
      </span>
    </div>
  );
}

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
  const [levelMenuOpen, setLevelMenuOpen] = useState(false);
  const [tiresMenuOpen, setTiresMenuOpen] = useState(false);
  const levelBtnRef = useRef<HTMLButtonElement | null>(null);
  const tiresBtnRef = useRef<HTMLButtonElement | null>(null);

  const displayTime = rhythm.startTime || '09:30';
  const hasFitFiles = Boolean(
    uploadFitLabel &&
    uploadFitLabel.length > 0 &&
    uploadFitLabel !== 'Upload .fit'
  );

  const currentLevelLabel = useMemo(() => {
    const found = PRACTICE_LEVELS.find((l) => l.id === rhythm.practiceLevel);
    if (found) return found.label;
    return 'Débutant';
  }, [rhythm.practiceLevel]);

  return (
    <div className="rvi-params">
      <div className="rvi-divider" />

      {/* ── Figma Node 6043:105672 container ── */}
      <div className="rvi-rythme-figma">
        {/* ── ROW 1 : Départ & Heure (Figma node 6025:114207) ── */}
        <div className="rvi-rythme-figma__row-datetime">
          {/* Départ */}
          <div className="rvi-rythme-figma__datetime-group">
            <span className="rvi-rythme-figma__label-sm">{t('Départ :')}</span>
            <button
              type="button"
              ref={dateChipRef}
              className="rvi-rythme-figma__chip-btn"
              onClick={() => setCalendarOpen((v) => !v)}
              aria-haspopup="dialog"
              aria-expanded={calendarOpen}
              aria-label={t('Date de départ')}
            >
              <CalendarIcon size={10} />
              <span>
                {rhythm.startDate ? formatDateForLocale(rhythm.startDate, locale) : '22/04/26'}
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

          {/* Heure */}
          <div className="rvi-rythme-figma__datetime-group">
            <span className="rvi-rythme-figma__label-sm">{t('Heure :')}</span>
            <TimeChipInput
              displayTime={displayTime}
              ariaLabel={t('Heure de départ')}
              onChange={(nextValue) => onChange?.('startTime', nextValue)}
            />
          </div>
        </div>

        {/* ── ROW 2 : Niveau de pratique & Personalisé ── */}
        <div className="rvi-rythme-figma__row-duo">
          {/* Col 1 : Niveau de pratique */}
          <div className="rvi-rythme-figma__col">
            <span className="rvi-rythme-figma__label-title">{t('Niveau de pratique')}</span>
            <button
              ref={levelBtnRef}
              type="button"
              className={`rvi-rythme-figma__card-btn${levelMenuOpen ? ' is-open' : ''}`}
              onClick={() => setLevelMenuOpen((v) => !v)}
              aria-label={t('Niveau de pratique')}
              aria-haspopup="listbox"
              aria-expanded={levelMenuOpen}
            >
              <span className="rvi-rythme-figma__card-text">{currentLevelLabel}</span>
              <ChevronSelectorVerticalIcon size={20} />
            </button>

            <PortalDropdown
              open={levelMenuOpen}
              anchorRef={levelBtnRef}
              onClose={() => setLevelMenuOpen(false)}
              minWidth={140}
              align="left"
              estimatedHeight={180}
            >
              {PRACTICE_LEVELS.map((lvl) => (
                <button
                  key={lvl.id}
                  type="button"
                  className={`rvi-tracage__mode-menu-item${
                    rhythm.practiceLevel === lvl.id ? ' is-selected' : ''
                  }`}
                  onClick={() => {
                    onChange?.('practiceLevel', lvl.id);
                    setLevelMenuOpen(false);
                  }}
                  role="option"
                  aria-selected={rhythm.practiceLevel === lvl.id}
                >
                  <span>{lvl.label}</span>
                </button>
              ))}
            </PortalDropdown>
          </div>

          {/* Col 2 : Personalisé (.fit de référence) */}
          <div className="rvi-rythme-figma__col">
            <span className="rvi-rythme-figma__label-title">{t('Personalisé')}</span>
            <button
              type="button"
              className="rvi-rythme-figma__card-btn rvi-rythme-figma__card-btn--fit"
              onClick={onUploadFit}
              aria-label={t('.fit de référence')}
              title={hasFitFiles ? t('Cliquer pour remplacer ou ajouter des fichiers .fit') : t('Uploader des fichiers .fit')}
            >
              <UploadFitIcon size={14} />
              <span className="rvi-rythme-figma__card-text">
                {hasFitFiles && uploadFitLabel
                  ? uploadFitLabel
                  : t('.fit de référence')}
              </span>
            </button>
          </div>
        </div>

        {/* ── ROW 3 : FTP / Poids / Pneus / Météo (Figma 4 columns) ── */}
        <div className="rvi-rythme-figma__row-four">
          {/* Col 1 : FTP */}
          <div className="rvi-rythme-figma__col">
            <span className="rvi-rythme-figma__label-title">{t('FTP')}</span>
            <div
              className={`rvi-rythme-figma__card-box${
                rhythm.ftp !== null && rhythm.ftp > 0 ? ' rvi-rythme-figma__card-box--has-val' : ''
              }`}
            >
              <input
                type="text"
                inputMode="numeric"
                pattern="[0-9]*"
                value={rhythm.ftp !== null && rhythm.ftp > 0 ? String(rhythm.ftp) : ''}
                placeholder="Auto"
                onKeyDown={(e) => {
                  if (
                    ['Backspace', 'Delete', 'Tab', 'Escape', 'Enter', 'ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(e.key) ||
                    e.ctrlKey ||
                    e.metaKey
                  ) {
                    return;
                  }
                  if (!/^\d$/.test(e.key)) {
                    e.preventDefault();
                  }
                }}
                onChange={(e) => {
                  const cleaned = e.target.value.replace(/\D/g, '');
                  if (!cleaned) {
                    onChange?.('ftp', null);
                  } else {
                    const n = parseInt(cleaned, 10);
                    onChange?.('ftp', Number.isFinite(n) && n > 0 ? n : null);
                  }
                }}
                aria-label={t('FTP')}
              />
              {rhythm.ftp !== null && rhythm.ftp > 0 ? (
                <span className="rvi-rythme-figma__card-unit">W</span>
              ) : null}
            </div>
          </div>

          {/* Col 2 : Poids */}
          <div className="rvi-rythme-figma__col">
            <span className="rvi-rythme-figma__label-title">{t('Poids')}</span>
            <div
              className={`rvi-rythme-figma__card-box${
                rhythm.systemWeightKg !== null && rhythm.systemWeightKg > 0
                  ? ' rvi-rythme-figma__card-box--has-val'
                  : ''
              }`}
            >
              <input
                type="text"
                inputMode="numeric"
                pattern="[0-9]*"
                value={
                  rhythm.systemWeightKg !== null && rhythm.systemWeightKg > 0
                    ? String(rhythm.systemWeightKg)
                    : ''
                }
                placeholder="Auto"
                onKeyDown={(e) => {
                  if (
                    ['Backspace', 'Delete', 'Tab', 'Escape', 'Enter', 'ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(e.key) ||
                    e.ctrlKey ||
                    e.metaKey
                  ) {
                    return;
                  }
                  if (!/^\d$/.test(e.key)) {
                    e.preventDefault();
                  }
                }}
                onChange={(e) => {
                  const cleaned = e.target.value.replace(/\D/g, '');
                  if (!cleaned) {
                    onChange?.('systemWeightKg', null);
                  } else {
                    const n = parseInt(cleaned, 10);
                    onChange?.('systemWeightKg', Number.isFinite(n) && n > 0 ? n : null);
                  }
                }}
                aria-label={t('Poids')}
              />
              {rhythm.systemWeightKg !== null && rhythm.systemWeightKg > 0 ? (
                <span className="rvi-rythme-figma__card-unit">kg</span>
              ) : null}
            </div>
          </div>

          {/* Col 3 : Pneus */}
          <div className="rvi-rythme-figma__col">
            <span className="rvi-rythme-figma__label-title">{t('Pneus')}</span>
            <button
              ref={tiresBtnRef}
              type="button"
              className={`rvi-rythme-figma__card-box${tiresMenuOpen ? ' is-open' : ''}`}
              onClick={() => setTiresMenuOpen((v) => !v)}
              aria-label={t('Largeur de pneus')}
              aria-haspopup="listbox"
              aria-expanded={tiresMenuOpen}
            >
              <span>{rhythm.tiresMm ? `${rhythm.tiresMm}mm` : '35mm'}</span>
            </button>

            <PortalDropdown
              open={tiresMenuOpen}
              anchorRef={tiresBtnRef}
              onClose={() => setTiresMenuOpen(false)}
              minWidth={80}
              align="left"
              estimatedHeight={200}
            >
              {TIRE_OPTIONS.map((mm) => (
                <button
                  key={mm}
                  type="button"
                  className={`rvi-tracage__mode-menu-item${
                    (rhythm.tiresMm ?? 35) === mm ? ' is-selected' : ''
                  }`}
                  onClick={() => {
                    onChange?.('tiresMm', mm);
                    setTiresMenuOpen(false);
                  }}
                  role="option"
                  aria-selected={(rhythm.tiresMm ?? 35) === mm}
                >
                  <span>{mm}mm</span>
                </button>
              ))}
            </PortalDropdown>
          </div>

          {/* Col 4 : Météo */}
          <div className="rvi-rythme-figma__col">
            <span className="rvi-rythme-figma__label-title">{t('Météo')}</span>
            <button
              type="button"
              className="rvi-rythme-figma__card-box rvi-rythme-figma__weather-btn"
              onClick={() => onChange?.('useWeather', !rhythm.useWeather)}
              aria-label={t('Météo')}
              role="checkbox"
              aria-checked={Boolean(rhythm.useWeather)}
            >
              <span className={`rvi-rythme-figma__checkbox-box${rhythm.useWeather ? ' is-checked' : ''}`}>
                {rhythm.useWeather && <IconFigmaCheck size={11} />}
              </span>
              <span>{rhythm.useWeather ? t('Oui') : t('Non')}</span>
            </button>
          </div>
        </div>

        {/* ── ROW 4 : Appliquer à tout les itinéraires ── */}
        <button
          type="button"
          className="rvi-rythme-figma__apply-all"
          onClick={() => onChange?.('applyToAllItineraries', !rhythm.applyToAllItineraries)}
          role="checkbox"
          aria-checked={Boolean(rhythm.applyToAllItineraries)}
        >
          <span
            className={`rvi-rythme-figma__checkbox-box${
              rhythm.applyToAllItineraries ? ' is-checked' : ''
            }`}
          >
            {rhythm.applyToAllItineraries && <IconFigmaCheck size={11} />}
          </span>
          <span className="rvi-rythme-figma__apply-all-label">
            {t('Appliquer à tout les itinéraires')}
          </span>
        </button>
      </div>

      <div className="rvi-divider" style={{ marginTop: 8 }} />

      {/* Pauses favoris */}
      <ToggleRow
        checked={rhythm.pauseAtFavoritePois}
        onChange={(v) => onChange?.('pauseAtFavoritePois', v)}
        label="Ajouter des pauses à chaque POI favori"
        trailing={<IconInfo size={14} />}
        trailingMuted
        trailingTight
      />

      <Collapse open={rhythm.pauseAtFavoritePois}>
        <PoiPauseGrid
          durations={rhythm.poiPauseDurations}
          onChange={(next) => onChange?.('poiPauseDurations', next)}
        />
      </Collapse>

      <div className="rvi-divider" />

      {/* Pauses par intervalle */}
      <ToggleRow
        checked={rhythm.pauseEveryIntervalEnabled}
        onChange={(v) => {
          onChange?.('pauseEveryIntervalEnabled', v);
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

      {/* Bouton de calcul */}
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

function createPauseRow(index: number): PauseIntervalRow {
  return {
    id: `pause-${Date.now()}-${index}`,
    label: `${translateAppText('Pause', undefined, readDocumentAppLocale())} ${index}`,
    durationMin: 5,
    intervalMin: 60,
  };
}

function relabel(rows: PauseIntervalRow[]): PauseIntervalRow[] {
  const pauseLabel = translateAppText('Pause', undefined, readDocumentAppLocale());
  return rows.map((r, i) => ({ ...r, label: `${pauseLabel} ${i + 1}` }));
}
