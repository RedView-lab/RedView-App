import { useRef, useState } from 'react';
import { useAppI18n } from '@/shared/i18n';
import { PortalDropdown } from '../../../components/controls/PortalDropdown';
import { RACE_DISTANCE_OPTIONS, formatRaceTime, parseRaceTime } from '../../../lib/rhythm/raceTime';
import type { RhythmState } from '../../../types';

type RhythmChange = <K extends keyof RhythmState>(key: K, value: RhythmState[K]) => void;

const NAV_KEYS = ['Backspace', 'Delete', 'Tab', 'Escape', 'Enter', 'ArrowLeft', 'ArrowRight', 'Home', 'End'];

/** Champ carte contenant un nombre positif (entiers, ou une décimale avec `decimals`). */
function NumericCardInput({
  value,
  unit,
  decimals = false,
  min,
  max,
  ariaLabel,
  onCommit,
}: {
  value: number | null | undefined;
  unit: string;
  decimals?: boolean;
  min: number;
  max: number;
  ariaLabel: string;
  onCommit: (value: number | null) => void;
}) {
  const [draft, setDraft] = useState(value ? String(value) : '');
  // Resynchroniser le brouillon quand la valeur stockée change ailleurs (ajustement pendant le rendu).
  const [syncedValue, setSyncedValue] = useState(value);
  if (value !== syncedValue) {
    setSyncedValue(value);
    setDraft(value ? String(value) : '');
  }

  const commit = (text: string) => {
    const n = Number.parseFloat(text.replace(',', '.'));
    if (!text.trim() || !Number.isFinite(n)) {
      onCommit(null);
      return;
    }
    const clamped = Math.min(max, Math.max(min, decimals ? Math.round(n * 10) / 10 : Math.round(n)));
    onCommit(clamped);
    setDraft(String(clamped));
  };

  return (
    <div className={`rvi-rythme-figma__card-box${draft ? ' rvi-rythme-figma__card-box--has-val' : ''}`}>
      <input
        type="text"
        inputMode={decimals ? 'decimal' : 'numeric'}
        value={draft}
        placeholder="N/A"
        onKeyDown={(e) => {
          if (e.key === 'Enter') {
            (e.target as HTMLInputElement).blur();
            return;
          }
          if (NAV_KEYS.includes(e.key) || e.ctrlKey || e.metaKey) return;
          if (/^\d$/.test(e.key)) return;
          if (decimals && (e.key === '.' || e.key === ',') && !/[.,]/.test(draft)) return;
          e.preventDefault();
        }}
        onChange={(e) => setDraft(e.target.value.replace(decimals ? /[^\d.,]/g : /\D/g, ''))}
        onBlur={(e) => commit(e.target.value)}
        aria-label={ariaLabel}
      />
      {draft ? <span className="rvi-rythme-figma__card-unit">{unit}</span> : null}
    </div>
  );
}

/** Race time card ("45:30", "1:45:30"); committed on blur / Enter. */
function RaceTimeInput({
  valueS,
  ariaLabel,
  onCommit,
}: {
  valueS: number | null | undefined;
  ariaLabel: string;
  onCommit: (seconds: number | null) => void;
}) {
  const [draft, setDraft] = useState(formatRaceTime(valueS));
  const [syncedValue, setSyncedValue] = useState(valueS);
  if (valueS !== syncedValue) {
    setSyncedValue(valueS);
    setDraft(formatRaceTime(valueS));
  }

  const commit = (text: string) => {
    if (!text.trim()) {
      onCommit(null);
      return;
    }
    const seconds = parseRaceTime(text);
    if (seconds == null) {
      setDraft(formatRaceTime(valueS));
      return;
    }
    onCommit(seconds);
    setDraft(formatRaceTime(seconds));
  };

  return (
    <div className="rvi-rythme-figma__card-box">
      <input
        type="text"
        inputMode="numeric"
        value={draft}
        placeholder="h:mm:ss"
        onKeyDown={(e) => {
          if (e.key === 'Enter') (e.target as HTMLInputElement).blur();
        }}
        onChange={(e) => setDraft(e.target.value.replace(/[^\dh:]/gi, ''))}
        onBlur={(e) => commit(e.target.value)}
        aria-label={ariaLabel}
      />
    </div>
  );
}

type ReferenceChoice = 'vma' | number;

/**
 * Remplacement trail / course des colonnes FTP / Poids / Pneus : référence (VMA
 * ou une distance de course), sa valeur, et le poids du coureur avec son sac.
 */
export function RunReferenceFields({
  rhythm,
  onChange,
}: {
  rhythm: RhythmState;
  onChange?: RhythmChange;
}) {
  const { t } = useAppI18n();
  const [menuOpen, setMenuOpen] = useState(false);
  const btnRef = useRef<HTMLButtonElement | null>(null);

  const mode = rhythm.runReferenceMode === 'chrono' ? 'chrono' : 'vma';
  const raceDistanceM = rhythm.refRaceDistanceM ?? 10000;
  const current: ReferenceChoice = mode === 'vma' ? 'vma' : raceDistanceM;
  const currentLabel =
    mode === 'vma'
      ? t('VMA')
      : t(RACE_DISTANCE_OPTIONS.find((o) => o.distanceM === raceDistanceM)?.label ?? '10 km');

  const select = (choice: ReferenceChoice) => {
    if (choice === 'vma') {
      onChange?.('runReferenceMode', 'vma');
    } else {
      onChange?.('runReferenceMode', 'chrono');
      onChange?.('refRaceDistanceM', choice);
    }
    setMenuOpen(false);
  };

  return (
    <>
      {/* Col 1 : Référence */}
      <div className="rvi-rythme-figma__col">
        <span className="rvi-rythme-figma__label-title">{t('Référence')}</span>
        <button
          ref={btnRef}
          type="button"
          className={`rvi-rythme-figma__card-box${menuOpen ? ' is-open' : ''}`}
          onClick={() => setMenuOpen((v) => !v)}
          aria-label={t('Référence d’allure')}
          aria-haspopup="listbox"
          aria-expanded={menuOpen}
        >
          <span className="rvi-rythme-figma__card-text rvi-rythme-figma__card-text--center">
            {currentLabel}
          </span>
        </button>
        <PortalDropdown
          open={menuOpen}
          anchorRef={btnRef}
          onClose={() => setMenuOpen(false)}
          minWidth={150}
          align="left"
          estimatedHeight={200}
        >
          <button
            type="button"
            className={`rv-dropdown__item${current === 'vma' ? ' is-selected' : ''}`}
            onClick={() => select('vma')}
            role="option"
            aria-selected={current === 'vma'}
          >
            <span>{t('VMA (km/h)')}</span>
          </button>
          <div className="rv-dropdown__divider" />
          {RACE_DISTANCE_OPTIONS.map((option) => (
            <button
              key={option.distanceM}
              type="button"
              className={`rv-dropdown__item${current === option.distanceM ? ' is-selected' : ''}`}
              onClick={() => select(option.distanceM)}
              role="option"
              aria-selected={current === option.distanceM}
            >
              <span>{t('Chrono')} {t(option.label)}</span>
            </button>
          ))}
        </PortalDropdown>
      </div>

      {/* Col 2 : VMA ou chrono */}
      <div className="rvi-rythme-figma__col">
        <span className="rvi-rythme-figma__label-title">{mode === 'vma' ? t('VMA') : t('Chrono')}</span>
        {mode === 'vma' ? (
          <NumericCardInput
            value={rhythm.vmaKmh}
            unit="km/h"
            decimals
            min={6}
            max={30}
            ariaLabel={t('VMA (km/h)')}
            onCommit={(v) => onChange?.('vmaKmh', v)}
          />
        ) : (
          <RaceTimeInput
            valueS={rhythm.refRaceTimeS}
            ariaLabel={t('Chrono de référence')}
            onCommit={(s) => onChange?.('refRaceTimeS', s)}
          />
        )}
      </div>

      {/* Col 3 : Poids avec sac */}
      <div className="rvi-rythme-figma__col">
        <span className="rvi-rythme-figma__label-title">{t('Poids (avec sac)')}</span>
        <NumericCardInput
          value={rhythm.runWeightKg}
          unit="kg"
          min={30}
          max={200}
          ariaLabel={t('Poids (avec sac)')}
          onCommit={(v) => onChange?.('runWeightKg', v)}
        />
      </div>
    </>
  );
}

const TECHNICALITY_OPTIONS = [
  { value: 0.2, label: 'Facile' },
  { value: 0.5, label: 'Moyen' },
  { value: 0.8, label: 'Technique' },
] as const;

/** Trail seulement : technicité du terrain (ralentit le plat et les descentes). */
export function TerrainTechnicalityRow({
  value,
  onChange,
}: {
  value: number | null | undefined;
  onChange?: RhythmChange;
}) {
  const { t } = useAppI18n();
  const current = typeof value === 'number' ? value : 0.5;
  const nearest = TECHNICALITY_OPTIONS.reduce((best, option) =>
    Math.abs(option.value - current) < Math.abs(best.value - current) ? option : best,
  );

  return (
    <div className="rvi-rythme-figma__col">
      <span className="rvi-rythme-figma__label-title">{t('Technicité du terrain')}</span>
      <div className="rvi-rythme-figma__segmented" role="radiogroup" aria-label={t('Technicité du terrain')}>
        {TECHNICALITY_OPTIONS.map((option) => (
          <button
            key={option.value}
            type="button"
            role="radio"
            aria-checked={nearest.value === option.value}
            className={`rvi-rythme-figma__card-box${nearest.value === option.value ? ' is-selected' : ''}`}
            onClick={() => onChange?.('terrainTechnicality', option.value)}
          >
            <span>{t(option.label)}</span>
          </button>
        ))}
      </div>
    </div>
  );
}
