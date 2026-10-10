import { useEffect, useId, useRef, useState } from 'react';
import { readDocumentAppLocale, translateAppText, useAppI18n } from '@/shared/i18n';
import { ActionButtonStack, ToggleRow } from '../components/controls';
import { PortalDropdown } from '../components/controls/PortalDropdown';
import { Collapse } from '../components/shell/Collapse';
import {
  PaceWeightControl,
  PauseIntervalList,
  PoiPauseGrid,
  PredictionResultSummary,
  RunReferenceFields,
  TerrainTechnicalityRow,
} from './rythme/components';
import { isFootDiscipline, type SportDiscipline } from '@/shared/lib/discipline';
import { CalendarPopover } from '../components/calendar';
import { IconInfo, IconPlus } from '../components/icons';
import { IconFigmaCheck, IconFigmaChevronDown, IconTrashFigma } from '../components/iconsFigma';
import { MAX_FIT_FILES, isCustomRhythmProfile } from '../lib/rhythm/profile';
import { resolveTargetSpeedKmh, targetSpeedOptionsFor } from '../lib/rhythm/pace';
import type { RhythmResultSummary } from '../lib/rhythm/resultSummary';
import {
  FTP_RULE,
  SYSTEM_WEIGHT_RULE,
  formatRiderNumber,
  isRiderNumberKey,
  parseRiderNumber,
  type RiderNumberRule,
} from '../lib/rhythm/riderNumber';
import type { PauseIntervalRow, RhythmState } from '../types';
import { createDocumentId } from '../lib/project/ids';

type RhythmChange = <K extends keyof RhythmState>(key: K, value: RhythmState[K]) => void;

interface RythmeSectionProps {
  rhythm: RhythmState;
  /** Trail / course remplacent FTP, poids et pneus par des références de course. */
  discipline?: SportDiscipline;
  onChange?: RhythmChange;
  onUploadFit?: () => void;
  /** Noms des .fit de référence chargés. */
  fitFileNames?: string[];
  onRemoveFitFile?: (index: number) => void;
  onClearFitFiles?: () => void;
  onCalculate?: () => void;
  onCancelCalculate?: () => void;
  calculateLabel?: string;
  /** Vrai pendant le calcul de la prédiction. */
  calculateDisabled?: boolean;
  /** Échec du calcul : masque le résultat, affiché sous le bouton. */
  calculateError?: string | null;
  /** Avertissement non bloquant sur les .fit, affiché sous « Activités de référence ». */
  fitNotice?: string | null;
  resultLabel?: string | null;
  /** Résultats de la prédiction affichés sous le bouton. */
  resultSummary?: RhythmResultSummary | null;
}

const PRACTICE_LEVELS = [
  { id: 'debutant', label: 'Débutant' },
  { id: 'intermediaire', label: 'Intermédiaire' },
  { id: 'avance', label: 'Avancé' },
  { id: 'expert', label: 'Expert' },
] as const;

const CUSTOM_PROFILE_LABEL = 'Personnalisé';

const TIRE_OPTIONS = [28, 30, 32, 35, 38, 40, 45, 50];

const DEFAULT_START_TIME = '09:30';

/** Créneaux de départ proposés : toutes les 30 min, de 00:00 à 23:30. */
const START_TIME_SLOTS = Array.from({ length: 48 }, (_, index) => {
  const hours = String(Math.floor(index / 2)).padStart(2, '0');
  return `${hours}:${index % 2 === 0 ? '00' : '30'}`;
});

const NUMERIC_NAV_KEYS = ['Backspace', 'Delete', 'Tab', 'Escape', 'Enter', 'ArrowLeft', 'ArrowRight', 'Home', 'End'];

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

/** Figma "share-01" : flèche d'upload 8px dans un cadre 16px. */
function UploadFitIcon({ size = 16 }: { size?: number }) {
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

/** Champ "Heure" : liste déroulante de créneaux de 30 min. */
function StartTimeSelect({
  value,
  ariaLabel,
  onChange,
}: {
  value: string;
  ariaLabel: string;
  onChange: (value: string) => void;
}) {
  const [open, setOpen] = useState(false);
  const buttonRef = useRef<HTMLButtonElement | null>(null);
  const [hours = '09', minutes = '30'] = value.split(':');

  // À l'ouverture, centre la liste sur l'heure courante.
  useEffect(() => {
    if (!open) return;
    const raf = requestAnimationFrame(() => {
      const menu = document.querySelector<HTMLElement>('.rvi-rythme-figma__time-menu');
      const selected = menu?.querySelector<HTMLElement>('[aria-selected="true"]');
      if (!menu || !selected) return;
      menu.scrollTop = selected.offsetTop - (menu.clientHeight - selected.offsetHeight) / 2;
    });
    return () => cancelAnimationFrame(raf);
  }, [open]);

  return (
    <>
      <button
        ref={buttonRef}
        type="button"
        className={`rvi-rythme-figma__time-chip${open ? ' is-open' : ''}`}
        onClick={() => setOpen((v) => !v)}
        aria-haspopup="listbox"
        aria-expanded={open}
        aria-label={`${ariaLabel} ${hours.padStart(2, '0')}:${minutes.padStart(2, '0')}`}
      >
        <ClockIcon size={12} />
        <span className="rvi-rythme-figma__time-digits">
          <span className="rvi-rythme-figma__time-pill">{hours.padStart(2, '0')}</span>
          <span className="rvi-rythme-figma__time-colon">:</span>
          <span className="rvi-rythme-figma__time-pill">{minutes.padStart(2, '0')}</span>
        </span>
      </button>

      <PortalDropdown
        open={open}
        anchorRef={buttonRef}
        onClose={() => setOpen(false)}
        minWidth={95}
        align="left"
        className="rvi-rythme-figma__time-menu"
        estimatedHeight={260}
      >
        {START_TIME_SLOTS.map((slot) => (
          <button
            key={slot}
            type="button"
            className={`rv-dropdown__item${slot === value ? ' is-selected' : ''}`}
            onClick={() => {
              onChange(slot);
              setOpen(false);
            }}
            role="option"
            aria-selected={slot === value}
          >
            <span>{slot}</span>
          </button>
        ))}
      </PortalDropdown>
    </>
  );
}

/**
 * Carte numérique (FTP, poids) : "N/A" quand vide, unité affichée sinon.
 * Brouillon local pendant la frappe (« 82, » doit rester affiché) ; seule une
 * valeur dans les bornes de `rule` est retenue (lib/rhythm/riderNumber.ts).
 */
function RiderNumberField({
  label,
  value,
  unit,
  rule,
  onCommit,
}: {
  label: string;
  value: number | null;
  unit: string;
  rule: RiderNumberRule;
  onCommit: (value: number | null) => void;
}) {
  const { t, locale } = useAppI18n();
  const [draft, setDraft] = useState<string | null>(null);
  const hasValue = value !== null && value > 0;
  const shown = draft ?? (hasValue ? formatRiderNumber(value, rule, locale) : '');
  const invalid = draft !== null && parseRiderNumber(draft, rule).kind === 'invalid';
  const hint = invalid
    ? t('Valeur attendue entre {{min}} et {{max}} {{unit}}', { min: rule.min, max: rule.max, unit })
    : undefined;
  return (
    <div className="rvi-rythme-figma__col">
      <span className="rvi-rythme-figma__label-title" title={label}>{label}</span>
      <div
        className={`rvi-rythme-figma__card-box${hasValue ? ' rvi-rythme-figma__card-box--has-val' : ''}${invalid ? ' rvi-rythme-figma__card-box--invalid' : ''}`}
      >
        <input
          type="text"
          inputMode={rule.decimals > 0 ? 'decimal' : 'numeric'}
          value={shown}
          placeholder="N/A"
          onKeyDown={(e) => {
            if (NUMERIC_NAV_KEYS.includes(e.key) || e.ctrlKey || e.metaKey) return;
            if (!isRiderNumberKey(e.key, rule)) e.preventDefault();
          }}
          onChange={(e) => {
            const text = e.target.value;
            setDraft(text);
            const parsed = parseRiderNumber(text, rule);
            if (parsed.kind === 'empty') onCommit(null);
            else if (parsed.kind === 'value' && parsed.value !== value) onCommit(parsed.value);
          }}
          // Sortie du champ : la valeur retenue reprend sa forme (une saisie
          // hors bornes est abandonnée).
          onBlur={() => setDraft(null)}
          aria-label={label}
          aria-invalid={invalid ? true : undefined}
          title={hint}
        />
        {hasValue ? <span className="rvi-rythme-figma__card-unit">{unit}</span> : null}
      </div>
    </div>
  );
}

/** "Activités de référence" : upload initial, puis ajout / gestion des .fit. */
function ReferenceActivitiesField({
  fitFileNames,
  notice,
  onUploadFit,
  onRemoveFitFile,
  onClearFitFiles,
}: {
  fitFileNames: string[];
  /** Fichiers écartés ou non enregistrés : information, pas une erreur bloquante. */
  notice?: string | null;
  onUploadFit?: () => void;
  onRemoveFitFile?: (index: number) => void;
  onClearFitFiles?: () => void;
}) {
  const { t } = useAppI18n();
  const [filesMenuOpen, setFilesMenuOpen] = useState(false);
  const filesBtnRef = useRef<HTMLButtonElement | null>(null);
  const fitCount = fitFileNames.length;
  const limitReached = fitCount >= MAX_FIT_FILES;

  return (
    <div className="rvi-rythme-figma__field">
      <span className="rvi-rythme-figma__label-title">{t('Activités de référence')}</span>

      {fitCount === 0 ? (
        <button
          type="button"
          className="rvi-rythme-figma__fit-btn"
          onClick={onUploadFit}
          aria-label={`${t('Ajouter des fichiers .fit')} — ${t('Jusqu’à {{count}} .fit', { count: MAX_FIT_FILES })}`}
        >
          <UploadFitIcon size={16} />
          <span className="rvi-rythme-figma__fit-text">
            {t('Jusqu’à {{count}} .fit', { count: MAX_FIT_FILES })}
          </span>
        </button>
      ) : (
        <div className="rvi-rythme-figma__fit-row">
          <button
            type="button"
            className="rvi-rythme-figma__fit-btn rvi-rythme-figma__fit-btn--add"
            onClick={onUploadFit}
            disabled={limitReached}
            title={
              limitReached
                ? t('Limite de {{count}} fichiers .fit atteinte', { count: MAX_FIT_FILES })
                : t('Ajouter des fichiers .fit')
            }
          >
            <UploadFitIcon size={16} />
            <span className="rvi-rythme-figma__fit-text">{t('Ajouter')}</span>
          </button>

          <button
            ref={filesBtnRef}
            type="button"
            className={`rvi-rythme-figma__fit-btn rvi-rythme-figma__fit-btn--files${filesMenuOpen ? ' is-open' : ''}`}
            onClick={() => setFilesMenuOpen((v) => !v)}
            aria-haspopup="listbox"
            aria-expanded={filesMenuOpen}
            aria-label={t('Gérer les fichiers .fit')}
          >
            <span className="rvi-rythme-figma__fit-trash">
              <IconTrashFigma size={15} />
            </span>
            <span className="rvi-rythme-figma__fit-text">
              {fitCount === 1
                ? t('1 fichier uploadé')
                : t('{{count}} fichiers uploadés', { count: fitCount })}
            </span>
          </button>

          <PortalDropdown
            open={filesMenuOpen}
            anchorRef={filesBtnRef}
            onClose={() => setFilesMenuOpen(false)}
            align="right"
            estimatedHeight={Math.min(260, 30 * (fitCount + 1) + 1)}
          >
            {fitFileNames.map((name, index) => (
              <div
                key={`${name}-${index}`}
                className="rv-dropdown__item rv-dropdown__item--no-check rvi-rythme-figma__fit-item"
              >
                <span className="rvi-rythme-figma__fit-item-name" title={name}>{name}</span>
                <button
                  type="button"
                  className="rvi-rythme-figma__fit-item-remove"
                  onClick={() => {
                    if (fitCount === 1) setFilesMenuOpen(false);
                    onRemoveFitFile?.(index);
                  }}
                  aria-label={t('Retirer {{name}}', { name })}
                >
                  <IconTrashFigma size={14} />
                </button>
              </div>
            ))}
            <div className="rv-dropdown__divider" />
            <button
              type="button"
              className="rv-dropdown__item rv-dropdown__item--danger rv-dropdown__item--no-check"
              onClick={() => {
                setFilesMenuOpen(false);
                onClearFitFiles?.();
              }}
            >
              <IconTrashFigma size={14} />
              <span>{t('Tout supprimer')}</span>
            </button>
          </PortalDropdown>
        </div>
      )}

      {notice ? (
        <p className="rvi-rythme-figma__fit-notice" role="status">
          {notice}
        </p>
      ) : null}
    </div>
  );
}

export function RythmeSection({
  rhythm,
  discipline = 'bike',
  onChange,
  onUploadFit,
  fitFileNames = [],
  onRemoveFitFile,
  onClearFitFiles,
  onCalculate,
  onCancelCalculate,
  calculateLabel,
  calculateDisabled,
  calculateError = null,
  fitNotice = null,
  resultLabel = null,
  resultSummary = null,
}: RythmeSectionProps) {
  const { locale, t } = useAppI18n();
  const dateChipRef = useRef<HTMLButtonElement | null>(null);
  const [calendarOpen, setCalendarOpen] = useState(false);
  const [profileMenuOpen, setProfileMenuOpen] = useState(false);
  const [tiresMenuOpen, setTiresMenuOpen] = useState(false);
  const profileBtnRef = useRef<HTMLButtonElement | null>(null);
  // Nom accessible du bouton = libellé + profil affiché (« Profil de rythme
  // Débutant ») : un aria-label seul cachait la valeur visible (WCAG 2.5.3).
  const profileLabelId = useId();
  const profileValueId = useId();
  const tiresBtnRef = useRef<HTMLButtonElement | null>(null);

  const displayTime = rhythm.startTime || DEFAULT_START_TIME;
  // Sans date : « Choisir », jamais une date d'exemple (« 22/04/26 », reste de
  // maquette, faisait croire la date posée alors que l'agenda, les horaires
  // d'ouverture et l'export la tenaient pour inconnue).
  const startDateText = rhythm.startDate ? formatDateForLocale(rhythm.startDate, locale) : null;
  const tiresText = rhythm.tiresMm ? `${rhythm.tiresMm}mm` : '35mm';
  const isCustom = isCustomRhythmProfile(rhythm);
  const targetSpeedKmh = resolveTargetSpeedKmh(rhythm);
  const speedOptions = targetSpeedOptionsFor(discipline);
  const presetLevel = PRACTICE_LEVELS.find((l) => l.id === rhythm.practiceLevel) ?? PRACTICE_LEVELS[0];
  const profileText = targetSpeedKmh !== null
    ? formatSpeedOption(targetSpeedKmh)
    : t(isCustom ? CUSTOM_PROFILE_LABEL : presetLevel.label);
  const isCalculating = Boolean(calculateDisabled);

  // À l'ouverture, la vitesse choisie est amenée au milieu de la liste.
  useEffect(() => {
    if (!profileMenuOpen) return;
    const raf = requestAnimationFrame(() => {
      const menu = document.querySelector<HTMLElement>('.rvi-rythme-figma__profile-menu');
      const selected = menu?.querySelector<HTMLElement>('[aria-selected="true"]');
      if (!menu || !selected || menu.scrollHeight <= menu.clientHeight) return;
      menu.scrollTop = selected.offsetTop - (menu.clientHeight - selected.offsetHeight) / 2;
    });
    return () => cancelAnimationFrame(raf);
  }, [profileMenuOpen]);

  const selectPreset = (levelId: string) => {
    onChange?.('rhythmProfile', 'preset');
    onChange?.('practiceLevel', levelId);
    setProfileMenuOpen(false);
  };

  const selectCustom = () => {
    onChange?.('rhythmProfile', 'custom');
    setProfileMenuOpen(false);
  };

  // La vitesse d'abord : un profil « vitesse » sans vitesse est ramené à un
  // niveau par la normalisation du rythme.
  const selectSpeed = (kmh: number) => {
    onChange?.('targetSpeedKmh', kmh);
    onChange?.('rhythmProfile', 'speed');
    setProfileMenuOpen(false);
  };

  return (
    <div className="rvi-params">
      <div className="rvi-rythme-figma">
        {/* ── Départ & Heure ── */}
        <div className="rvi-rythme-figma__row-datetime">
          <div className="rvi-rythme-figma__datetime-group">
            <span className="rvi-rythme-figma__label-sm">{t('Départ :')}</span>
            <button
              type="button"
              ref={dateChipRef}
              className={`rvi-rythme-figma__chip-btn${startDateText ? '' : ' rvi-rythme-figma__chip-btn--empty'}`}
              onClick={() => setCalendarOpen((v) => !v)}
              aria-haspopup="dialog"
              aria-expanded={calendarOpen}
              aria-label={startDateText ? `${t('Date de départ')} ${startDateText}` : t('Date de départ : à choisir')}
            >
              <CalendarIcon size={10} />
              <span>{startDateText ?? t('Choisir')}</span>
            </button>
            <CalendarPopover
              open={calendarOpen}
              anchorRef={dateChipRef}
              onClose={() => setCalendarOpen(false)}
              value={rhythm.startDate}
              onSelect={(iso) => {
                onChange?.('startDate', iso);
                if (!rhythm.startTime) {
                  onChange?.('startTime', DEFAULT_START_TIME);
                }
              }}
            />
          </div>

          <div className="rvi-rythme-figma__datetime-group">
            <span className="rvi-rythme-figma__label-sm">{t('Heure :')}</span>
            <StartTimeSelect
              value={displayTime}
              ariaLabel={t('Heure de départ')}
              onChange={(nextValue) => onChange?.('startTime', nextValue)}
            />
          </div>
        </div>

        {/* ── Profil de rythme + Pondérer ── */}
        <div className="rvi-rythme-figma__row-profile">
          <div className="rvi-rythme-figma__field">
            <span id={profileLabelId} className="rvi-rythme-figma__label-title">{t('Profil de rythme')}</span>
            <button
              ref={profileBtnRef}
              type="button"
              className={`rvi-rythme-figma__profile-btn${profileMenuOpen ? ' is-open' : ''}`}
              onClick={() => setProfileMenuOpen((v) => !v)}
              aria-labelledby={`${profileLabelId} ${profileValueId}`}
              aria-haspopup="listbox"
              aria-expanded={profileMenuOpen}
            >
              <span id={profileValueId} className="rvi-rythme-figma__profile-text">{profileText}</span>
              <span className={`rvi-rythme-figma__profile-chevron${profileMenuOpen ? ' is-open' : ''}`}>
                <IconFigmaChevronDown size={24} />
              </span>
            </button>

            <PortalDropdown
              open={profileMenuOpen}
              anchorRef={profileBtnRef}
              onClose={() => setProfileMenuOpen(false)}
              align="left"
              className="rvi-rythme-figma__profile-menu"
              estimatedHeight={320}
            >
              {PRACTICE_LEVELS.map((lvl) => {
                const selected = !isCustom && targetSpeedKmh === null && presetLevel.id === lvl.id;
                return (
                  <button
                    key={lvl.id}
                    type="button"
                    className={`rv-dropdown__item${selected ? ' is-selected' : ''}`}
                    onClick={() => selectPreset(lvl.id)}
                    role="option"
                    aria-selected={selected}
                  >
                    <span>{t(lvl.label)}</span>
                  </button>
                );
              })}
              <div className="rv-dropdown__divider" />
              <button
                type="button"
                className={`rv-dropdown__item${isCustom ? ' is-selected' : ''}`}
                onClick={selectCustom}
                role="option"
                aria-selected={isCustom}
              >
                <span>{t(CUSTOM_PROFILE_LABEL)}</span>
              </button>
              <div className="rv-dropdown__divider" />
              {/* Vitesse moyenne en déplacement imposée (8 → 50 km/h, pas de 2). */}
              {speedOptions.map((kmh) => {
                const selected = targetSpeedKmh === kmh;
                return (
                  <button
                    key={kmh}
                    type="button"
                    className={`rv-dropdown__item${selected ? ' is-selected' : ''}`}
                    onClick={() => selectSpeed(kmh)}
                    role="option"
                    aria-selected={selected}
                  >
                    <span>{formatSpeedOption(kmh)}</span>
                  </button>
                );
              })}
            </PortalDropdown>
          </div>

          <PaceWeightControl
            value={rhythm.paceWeightPct}
            onChange={(next) => onChange?.('paceWeightPct', next)}
          />
        </div>

        {/* ── Personnalisé : activités de référence + données du cycliste / coureur ── */}
        <Collapse open={isCustom}>
          <div className="rvi-rythme-figma__custom">
            <ReferenceActivitiesField
              fitFileNames={fitFileNames}
              notice={fitNotice}
              onUploadFit={onUploadFit}
              onRemoveFitFile={onRemoveFitFile}
              onClearFitFiles={onClearFitFiles}
            />

            <div className="rvi-rythme-figma__row-four">
              {isFootDiscipline(discipline) ? (
                <RunReferenceFields rhythm={rhythm} onChange={onChange} />
              ) : (
                <>
                  <RiderNumberField
                    label={t('FTP')}
                    value={rhythm.ftp}
                    unit="W"
                    rule={FTP_RULE}
                    onCommit={(v) => onChange?.('ftp', v)}
                  />
                  <RiderNumberField
                    label={t('Poids total')}
                    value={rhythm.systemWeightKg}
                    unit="kg"
                    rule={SYSTEM_WEIGHT_RULE}
                    onCommit={(v) => onChange?.('systemWeightKg', v)}
                  />

                  <div className="rvi-rythme-figma__col">
                    <span className="rvi-rythme-figma__label-title">{t('Pneus')}</span>
                    <button
                      ref={tiresBtnRef}
                      type="button"
                      className={`rvi-rythme-figma__card-box${tiresMenuOpen ? ' is-open' : ''}`}
                      onClick={() => setTiresMenuOpen((v) => !v)}
                      aria-label={`${t('Largeur de pneus')} ${tiresText}`}
                      aria-haspopup="listbox"
                      aria-expanded={tiresMenuOpen}
                    >
                      <span className="rvi-rythme-figma__card-value">
                        {tiresText}
                      </span>
                    </button>

                    <PortalDropdown
                      open={tiresMenuOpen}
                      anchorRef={tiresBtnRef}
                      onClose={() => setTiresMenuOpen(false)}
                      align="left"
                      estimatedHeight={200}
                    >
                      {TIRE_OPTIONS.map((mm) => (
                        <button
                          key={mm}
                          type="button"
                          className={`rv-dropdown__item${(rhythm.tiresMm ?? 35) === mm ? ' is-selected' : ''}`}
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
                </>
              )}

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
                  <span className="rvi-rythme-figma__card-value">
                    {rhythm.useWeather ? t('Oui') : t('Non')}
                  </span>
                </button>
              </div>
            </div>
          </div>
        </Collapse>

        {discipline === 'trail' && (
          <TerrainTechnicalityRow value={rhythm.terrainTechnicality} onChange={onChange} />
        )}
      </div>

      <div className="rvi-divider" />

      {/* ── Pauses ── */}
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

      {/* ── Appliquer à tout les itinéraires ── */}
      <button
        type="button"
        className="rvi-rythme-figma__apply-all"
        onClick={() => onChange?.('applyToAllItineraries', !rhythm.applyToAllItineraries)}
        role="checkbox"
        aria-checked={Boolean(rhythm.applyToAllItineraries)}
      >
        <span className={`rvi-rythme-figma__checkbox-box${rhythm.applyToAllItineraries ? ' is-checked' : ''}`}>
          {rhythm.applyToAllItineraries && <IconFigmaCheck size={11} />}
        </span>
        <span className="rvi-rythme-figma__apply-all-label">
          {t('Appliquer à tout les itinéraires')}
        </span>
      </button>

      {/* ── Action : Re-calculer → calcul en cours (survol : Interrompre) → résultat ── */}
      <ActionButtonStack
        primaryLabel={t('Re-calculer')}
        primaryIcon={<IconFigmaCheck size={16} />}
        onPrimaryClick={onCalculate}
        loadingLabel={isCalculating ? (calculateLabel ?? t('Calculer')) : null}
        onLoadingClick={onCancelCalculate}
        resultLabel={calculateError ? null : resultLabel}
      />
      {resultSummary && !calculateError ? (
        <PredictionResultSummary summary={resultSummary} stale={isCalculating} />
      ) : null}
      {calculateError && !isCalculating ? (
        <p className="rvi-rythme-figma__error" role="alert">
          {calculateError}
        </p>
      ) : null}
    </div>
  );
}

function formatSpeedOption(kmh: number): string {
  return `${kmh}\u00a0km/h`;
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
    id: createDocumentId('pause'),
    label: `${translateAppText('Pause', undefined, readDocumentAppLocale())} ${index}`,
    durationMin: 5,
    intervalMin: 60,
  };
}

function relabel(rows: PauseIntervalRow[]): PauseIntervalRow[] {
  const pauseLabel = translateAppText('Pause', undefined, readDocumentAppLocale());
  return rows.map((r, i) => ({ ...r, label: `${pauseLabel} ${i + 1}` }));
}
