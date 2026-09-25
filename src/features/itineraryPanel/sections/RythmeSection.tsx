import { useEffect, useRef, useState, useMemo } from 'react';
import { readDocumentAppLocale, translateAppText, useAppI18n } from '@/shared/i18n';
import { ActionButtonStack, ToggleRow } from '../components/controls';
import { Collapse } from '../components/shell';
import { PauseIntervalList, PoiPauseGrid } from './rythme/components';
import { CalendarPopover } from '../components/calendar';
import { IconInfo, IconPlus } from '../components/icons';
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
  { id: 'personnalise', label: 'Personnalisé' },
] as const;

const TIRE_OPTIONS = [28, 30, 32, 35, 38, 40, 45, 50];

function parseTimeDigits(timeStr: string | null | undefined): [string, string, string, string] {
  if (!timeStr) return ['0', '0', '0', '0'];
  const [h = '00', m = '00'] = timeStr.split(':');
  const hPad = h.padStart(2, '0');
  const mPad = m.padStart(2, '0');
  return [hPad[0] || '0', hPad[1] || '0', mPad[0] || '0', mPad[1] || '0'];
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
      className="rvi-rythme-figma__chip-btn"
      style={{ width: 95, flex: 'none', cursor: 'text' }}
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
        className="sr-only"
        tabIndex={0}
        onFocus={() => {
          if (activeSlot === null) setActiveSlot(0);
        }}
        onBlur={() => setActiveSlot(null)}
        onKeyDown={handleKeyDown}
        aria-label={ariaLabel}
      />
      {/* Clock Icon 12x12 */}
      <svg width="12" height="12" viewBox="0 0 12 12" fill="none" style={{ flexShrink: 0 }}>
        <circle cx="6" cy="6" r="4.5" stroke="currentColor" strokeWidth="1.2" />
        <path d="M6 3.5V6L7.5 7.5" stroke="currentColor" strokeWidth="1.2" strokeLinecap="round" strokeLinejoin="round" />
      </svg>
      <span style={{ display: 'inline-flex', alignItems: 'center', userSelect: 'none' }}>
        <span>{digits[0]}</span>
        <span>{digits[1]}</span>
        <span style={{ margin: '0 2px', opacity: 0.8 }}>:</span>
        <span>{digits[2]}</span>
        <span>{digits[3]}</span>
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
  const levelRef = useRef<HTMLDivElement | null>(null);
  const tiresRef = useRef<HTMLDivElement | null>(null);

  const displayTime = rhythm.startTime || '00:00';
  const hasFitFiles = Boolean(uploadFitLabel && uploadFitLabel.length > 0);

  // Close popovers when clicking outside
  useEffect(() => {
    const handleOutsideClick = (e: MouseEvent) => {
      if (levelRef.current && !levelRef.current.contains(e.target as Node)) {
        setLevelMenuOpen(false);
      }
      if (tiresRef.current && !tiresRef.current.contains(e.target as Node)) {
        setTiresMenuOpen(false);
      }
    };
    document.addEventListener('mousedown', handleOutsideClick);
    return () => document.removeEventListener('mousedown', handleOutsideClick);
  }, []);

  const currentLevelLabel = useMemo(() => {
    const found = PRACTICE_LEVELS.find((l) => l.id === rhythm.practiceLevel);
    if (found) return found.label;
    if (hasFitFiles) return 'Personnalisé';
    return 'Débutant';
  }, [rhythm.practiceLevel, hasFitFiles]);

  return (
    <div className="rvi-params">
      <div className="rvi-divider" />

      <div className="rvi-rythme-figma">
        {/* ── ROW 1 : Départ & Heure ── */}
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
              {/* Calendar Icon 10x10 */}
              <svg width="10" height="10" viewBox="0 0 12 12" fill="none">
                <path
                  d="M9.5 2H2.5C1.94772 2 1.5 2.44772 1.5 3V10C1.5 10.5523 1.94772 11 2.5 11H9.5C10.0523 11 10.5 10.5523 10.5 10V3C10.5 2.44772 10.0523 2 9.5 2Z"
                  stroke="currentColor"
                  strokeWidth="1.2"
                  strokeLinecap="round"
                  strokeLinejoin="round"
                />
                <path
                  d="M8 1V3M4 1V3M1.5 5H10.5"
                  stroke="currentColor"
                  strokeWidth="1.2"
                  strokeLinecap="round"
                  strokeLinejoin="round"
                />
              </svg>
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

          {/* Heure */}
          <div className="rvi-rythme-figma__datetime-group" style={{ justifyContent: 'flex-end' }}>
            <span className="rvi-rythme-figma__label-sm">{t('Heure :')}</span>
            <TimeChipInput
              displayTime={displayTime}
              ariaLabel={t('Heure de départ')}
              onChange={(nextValue) => onChange?.('startTime', nextValue)}
            />
          </div>
        </div>

        {/* ── ROW 2 : Niveau de pratique & Personnalisé ── */}
        <div className="rvi-rythme-figma__row-duo">
          {/* Col 1 : Niveau de pratique */}
          <div className="rvi-rythme-figma__col" ref={levelRef} style={{ position: 'relative' }}>
            <span className="rvi-rythme-figma__label-title">{t('Niveau de pratique')}</span>
            <button
              type="button"
              className="rvi-rythme-figma__card-btn"
              onClick={() => setLevelMenuOpen((v) => !v)}
              aria-label={t('Niveau de pratique')}
              aria-haspopup="listbox"
              aria-expanded={levelMenuOpen}
            >
              <span className="rvi-rythme-figma__card-text">{currentLevelLabel}</span>
              {/* Chevron vertical 18x18 */}
              <svg width="18" height="18" viewBox="0 0 20 20" fill="none" style={{ flexShrink: 0, opacity: 0.7 }}>
                <path
                  d="M6.5 7.5L10 4L13.5 7.5M6.5 12.5L10 16L13.5 12.5"
                  stroke="currentColor"
                  strokeWidth="1.5"
                  strokeLinecap="round"
                  strokeLinejoin="round"
                />
              </svg>
            </button>

            {levelMenuOpen && (
              <div className="rvi-rythme-figma__menu" role="listbox">
                {PRACTICE_LEVELS.map((lvl) => (
                  <button
                    key={lvl.id}
                    type="button"
                    className={`rvi-rythme-figma__menu-item${
                      rhythm.practiceLevel === lvl.id ? ' rvi-rythme-figma__menu-item--selected' : ''
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
              </div>
            )}
          </div>

          {/* Col 2 : Personnalisé (.fit de référence) */}
          <div className="rvi-rythme-figma__col">
            <span className="rvi-rythme-figma__label-title">{t('Personnalisé')}</span>
            <button
              type="button"
              className={`rvi-rythme-figma__card-btn${
                hasFitFiles ? ' rvi-rythme-figma__card-btn--fit-active' : ''
              }`}
              onClick={onUploadFit}
              aria-label={t('.fit de référence')}
              title={hasFitFiles ? t('Cliquer pour remplacer ou ajouter des fichiers .fit') : t('Uploader des fichiers .fit')}
            >
              {/* Upload Icon */}
              <svg width="14" height="14" viewBox="0 0 14 14" fill="none" style={{ flexShrink: 0 }}>
                <path
                  d="M7 9V2M7 2L4.5 4.5M7 2L9.5 4.5M2 8V11C2 11.5523 2.44772 12 3 12H11C11.5523 12 12 11.5523 12 11V8"
                  stroke="currentColor"
                  strokeWidth="1.3"
                  strokeLinecap="round"
                  strokeLinejoin="round"
                />
              </svg>
              <span className="rvi-rythme-figma__card-text">
                {hasFitFiles ? `${uploadFitLabel}` : t('.fit de référence')}
              </span>
            </button>
          </div>
        </div>

        {/* ── ROW 3 : Trio (FTP / Poids / Pneus) — MÉTÉO RETIRÉE COMME DEMANDÉ ── */}
        <div className="rvi-rythme-figma__row-trio">
          {/* Col 1 : FTP */}
          <div className="rvi-rythme-figma__col">
            <span className="rvi-rythme-figma__label-title">{t('FTP')}</span>
            <div className="rvi-rythme-figma__card-input">
              <input
                type="number"
                value={rhythm.ftp !== null ? rhythm.ftp : ''}
                placeholder={hasFitFiles ? 'Auto' : 'N/A'}
                onChange={(e) => {
                  const val = e.target.value.trim();
                  if (!val) {
                    // Non renseigné: remis à null pour utiliser les .fit automatiquement!
                    onChange?.('ftp', null);
                  } else {
                    const n = parseInt(val, 10);
                    onChange?.('ftp', Number.isFinite(n) && n > 0 ? n : null);
                  }
                }}
                aria-label={t('FTP')}
              />
              {rhythm.ftp !== null && rhythm.ftp > 0 ? (
                <span className="rvi-rythme-figma__unit">W</span>
              ) : null}
            </div>
          </div>

          {/* Col 2 : Poids */}
          <div className="rvi-rythme-figma__col">
            <span className="rvi-rythme-figma__label-title">{t('Poids')}</span>
            <div className="rvi-rythme-figma__card-input">
              <input
                type="number"
                value={rhythm.systemWeightKg !== null ? rhythm.systemWeightKg : ''}
                placeholder="Auto"
                onChange={(e) => {
                  const val = e.target.value.trim();
                  if (!val) {
                    onChange?.('systemWeightKg', null);
                  } else {
                    const n = parseInt(val, 10);
                    onChange?.('systemWeightKg', Number.isFinite(n) && n > 0 ? n : null);
                  }
                }}
                aria-label={t('Poids')}
              />
              {rhythm.systemWeightKg !== null && rhythm.systemWeightKg > 0 ? (
                <span className="rvi-rythme-figma__unit">kg</span>
              ) : null}
            </div>
          </div>

          {/* Col 3 : Pneus */}
          <div className="rvi-rythme-figma__col" ref={tiresRef} style={{ position: 'relative' }}>
            <span className="rvi-rythme-figma__label-title">{t('Pneus')}</span>
            <button
              type="button"
              className="rvi-rythme-figma__card-btn"
              style={{ padding: '0 8px' }}
              onClick={() => setTiresMenuOpen((v) => !v)}
              aria-label={t('Largeur de pneus')}
              aria-haspopup="listbox"
              aria-expanded={tiresMenuOpen}
            >
              <span className="rvi-rythme-figma__card-text">
                {rhythm.tiresMm ? `${rhythm.tiresMm}mm` : '35mm'}
              </span>
              <svg width="14" height="14" viewBox="0 0 20 20" fill="none" style={{ flexShrink: 0, opacity: 0.7 }}>
                <path d="M6.5 8L10 12L13.5 8" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
              </svg>
            </button>

            {tiresMenuOpen && (
              <div className="rvi-rythme-figma__menu" style={{ maxHeight: 180, overflowY: 'auto' }} role="listbox">
                {TIRE_OPTIONS.map((mm) => (
                  <button
                    key={mm}
                    type="button"
                    className={`rvi-rythme-figma__menu-item${
                      (rhythm.tiresMm ?? 35) === mm ? ' rvi-rythme-figma__menu-item--selected' : ''
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
              </div>
            )}
          </div>
        </div>

        {/* ── ROW 4 : Appliquer à tous les itinéraires ── */}
        <div
          className="rvi-rythme-figma__apply-all"
          onClick={() => onChange?.('applyToAllItineraries', !rhythm.applyToAllItineraries)}
          role="checkbox"
          aria-checked={Boolean(rhythm.applyToAllItineraries)}
          tabIndex={0}
          onKeyDown={(e) => {
            if (e.key === ' ' || e.key === 'Enter') {
              e.preventDefault();
              onChange?.('applyToAllItineraries', !rhythm.applyToAllItineraries);
            }
          }}
        >
          <div
            className={`rvi-rythme-figma__checkbox${
              rhythm.applyToAllItineraries ? ' rvi-rythme-figma__checkbox--checked' : ''
            }`}
          >
            {rhythm.applyToAllItineraries && (
              <svg width="10" height="10" viewBox="0 0 10 10" fill="none">
                <path d="M2 5.5L4 7.5L8 3" stroke="#FFFFFF" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
              </svg>
            )}
          </div>
          <span className="rvi-rythme-figma__apply-all-label">
            {t('Appliquer à tous les itinéraires')}
          </span>
        </div>
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
