import { useState, useRef, useEffect, useCallback } from 'react';
import { useAppI18n } from '@/shared/i18n';
import { Section } from '../components/Section';
import { Select } from '../components/Select';
import { Slider } from '../components/Slider';
import { ColorSwatch } from '../components/ColorSwatch';
import { ColorPalettePicker } from '../components/ColorPalettePicker';
import { IconChevronDown, IconEye, IconEyeOff, IconSlope } from '../icons';
import { formatSlopeDegreeLabel } from '@/features/slope/lib/slope-config';
import type {
  ControlPanelHandlers,
  ControlPanelState,
  SlopeBand,
  SlopeColorization,
  SlopeResolution,
  SlopeScale,
  SlopeScaleSetting,
} from '../types';

interface Props {
  enabled: boolean;
  state: Omit<ControlPanelState['slopes'], 'enabled'>;
  open?: boolean;
  onOpenChange?: (open: boolean) => void;
  onEnabledChange: ControlPanelHandlers['onSlopesEnabledChange'];
  onResolutionChange: ControlPanelHandlers['onSlopeResolutionChange'];
  onColorizationChange: ControlPanelHandlers['onSlopeColorizationChange'];
  onScaleChange: ControlPanelHandlers['onSlopeScaleChange'];
  onScaleSettingChange: ControlPanelHandlers['onSlopeScaleSettingChange'];
  onOpacityChange: ControlPanelHandlers['onSlopeOpacityChange'];
  onBandColorChange: ControlPanelHandlers['onSlopeBandColorChange'];
  onBandVisibilityToggle: ControlPanelHandlers['onSlopeBandVisibilityToggle'];
  onBandBreakpointChange?: ControlPanelHandlers['onSlopeBandBreakpointChange'];
  noTopBorder?: boolean;
  showResolution?: boolean;
}

const RESOLUTION_OPTIONS: { value: SlopeResolution; label: string }[] = [
  { value: '0.40m (LIDAR SURFACE)', label: '0.40m LIDAR SURFACE' },
  { value: '1m (LIDAR TERRAIN)', label: '1m LIDAR TERRAIN' },
];

// Figma node 1792:73116 — dropdown options "Remplissage" / "Dégradé"
const COLORIZATION_OPTIONS: { value: SlopeColorization; label: string }[] = [
  { value: 'stepped', label: 'Remplissage' },
  { value: 'gradient', label: 'Dégradé' },
];

// Figma node 1792:73208 — dropdown options "Pourcentage" / "Inclinaison (°)"
const SCALE_OPTIONS: { value: SlopeScale; label: string }[] = [
  { value: 'percent', label: 'Pourcentage' },
  { value: 'degree', label: 'Inclinaison (°)' },
];

const SCALE_SETTING_OPTIONS: { value: SlopeScaleSetting; label: string }[] = [
  { value: '2 couleurs', label: '2 couleurs' },
  { value: '3 couleurs', label: '3 couleurs' },
  { value: '4 couleurs', label: '4 couleurs' },
  { value: '6 couleurs', label: '6 couleurs' },
  { value: '8 couleurs', label: '8 couleurs' },
  { value: '10 couleurs', label: '10 couleurs' },
];

function hexLabel(color: string): string {
  return color.replace('#', '').toUpperCase();
}

// ── Inline editable numeric input ─────────────────────────────────────
// Renders as text by default. Click to enter edit mode, type a number,
// commit on Enter / blur, cancel on Escape. Supports two units:
//   - 'degree' : raw degrees, range 0..90, suffix "°", maxLength 2
//   - 'percent': percent slope, range 0..1000, suffix "%", maxLength 4
// On commit, the value is converted back to degrees (the canonical unit)
// before being passed to the parent via `onCommit`.

type InlineUnit = 'degree' | 'percent';

interface InlineNumericInputProps {
  /** Current value in degrees (canonical unit). */
  valueDeg: number;
  /** Display unit. */
  unit: InlineUnit;
  /** Is this value editable? First band min (0°) and last band max (90°) are not. */
  editable: boolean;
  /** Called with the new value in DEGREES on commit. */
  onCommit: (deg: number) => void;
  className?: string;
}

function degToPct(deg: number): number {
  if (deg >= 90) return 9999; // sentinel — caller never commits this
  return Math.round(Math.tan((deg * Math.PI) / 180) * 100);
}
function pctToDeg(pct: number): number {
  const rad = Math.atan(pct / 100);
  return Math.round(((rad * 180) / Math.PI) * 10) / 10;
}

function InlineNumericInput({
  valueDeg,
  unit,
  editable,
  onCommit,
  className,
}: InlineNumericInputProps) {
  const { t } = useAppI18n();
  const [editing, setEditing] = useState(false);
  const isPercent = unit === 'percent';

  const display = isPercent ? String(degToPct(valueDeg)) : formatSlopeDegreeLabel(valueDeg);
  const suffix = isPercent ? '%' : '°';
  const maxLength = isPercent ? 4 : 5;

  const [draft, setDraft] = useState(display);
  const inputRef = useRef<HTMLInputElement>(null);

  // Auto-focus & select when entering edit mode
  useEffect(() => {
    if (editing && inputRef.current) {
      inputRef.current.focus();
      inputRef.current.select();
    }
  }, [editing]);

  const commit = useCallback(() => {
    setEditing(false);
    const normalizedDraft = draft.replace(',', '.');
    const parsed = isPercent ? parseInt(normalizedDraft, 10) : parseFloat(normalizedDraft);
    if (Number.isNaN(parsed)) return; // revert silently
    let nextDeg: number;
    if (isPercent) {
      // Clamp percent to [0, 9999] then convert to degrees
      const pct = Math.max(0, Math.min(9999, parsed));
      nextDeg = Math.max(0, Math.min(90, pctToDeg(pct)));
    } else {
      nextDeg = Math.max(0, Math.min(90, Math.round(parsed * 10) / 10));
    }
    if (nextDeg !== valueDeg) onCommit(nextDeg);
  }, [draft, valueDeg, onCommit, isPercent]);

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
      <span className={`rvc-slopes__deg-value ${className ?? ''}`}>
        {display}{suffix}
      </span>
    );
  }

  if (!editing) {
    return (
      <button
        type="button"
        className={`rvc-slopes__deg-btn ${className ?? ''}`}
        onClick={() => {
          setDraft(display);
          setEditing(true);
        }}
        title={isPercent ? t('Cliquer pour modifier le pourcentage') : t("Cliquer pour modifier l'angle")}
      >
        {display}{suffix}
      </button>
    );
  }

  return (
    <input
      ref={inputRef}
      type="text"
      inputMode="numeric"
      className={`rvc-slopes__deg-input ${className ?? ''}`}
      value={draft}
      onChange={(e) => {
        const v = isPercent
          ? e.target.value.replace(/[^\d]/g, '')
          : e.target.value.replace(/[^\d.,]/g, '');
        setDraft(v);
      }}
      onBlur={commit}
      onKeyDown={handleKeyDown}
      maxLength={maxLength}
      aria-label={isPercent ? t('Pourcentage de pente') : t('Angle en degrés')}
    />
  );
}

// ── Band row component ────────────────────────────────────────────────

interface BandRowProps {
  band: SlopeBand;
  bandIndex: number;
  isFirst: boolean;
  isLast: boolean;
  scale: SlopeScale;
  onColorChange?: (id: string, color: string) => void;
  onVisibilityToggle?: (id: string) => void;
  onBreakpointChange?: (bandIndex: number, field: 'min' | 'max', valueDeg: number) => void;
}

function BandRow({
  band,
  bandIndex,
  isFirst,
  isLast,
  scale,
  onColorChange,
  onVisibilityToggle,
  onBreakpointChange,
}: BandRowProps) {
  const { t } = useAppI18n();
  const handleMinCommit = useCallback(
    (deg: number) => onBreakpointChange?.(bandIndex, 'min', deg),
    [bandIndex, onBreakpointChange],
  );
  const handleMaxCommit = useCallback(
    (deg: number) => onBreakpointChange?.(bandIndex, 'max', deg),
    [bandIndex, onBreakpointChange],
  );

  // Build the label — show range with inline editable values
  const minEditable = !isFirst; // first band always starts at 0°
  const maxEditable = !isLast;  // last band always ends at 90°

  // Category name from label, e.g. "0 - 7% (Modéré)" → "Modéré"
  const categoryMatch = band.label?.match(/\(([^)]+)\)/);
  const category = categoryMatch ? categoryMatch[1] : '';

  // The displayed unit (% or °) toggles via `scale`. The breakpoints stored
  // in the container are always in degrees — InlineNumericInput converts
  // back to degrees on commit so the canonical state stays unit-free.
  const unit: InlineUnit = scale === 'percent' ? 'percent' : 'degree';

  return (
    <div className={`rvc-slopes__band-row${band.visible ? '' : ' is-hidden'}`}>
      <button
        type="button"
        className="rvc-icon-btn rvc-icon-btn--ghost rvc-slopes__band-eye"
        onClick={() => onVisibilityToggle?.(band.id)}
        aria-label={band.visible ? t('Masquer la bande') : t('Afficher la bande')}
      >
        {band.visible ? <IconEye size={10} /> : <IconEyeOff size={10} />}
      </button>

      <div className="rvc-slopes__band-label-editable">
        <InlineNumericInput
          valueDeg={band.minDeg}
          unit={unit}
          editable={minEditable}
          onCommit={handleMinCommit}
        />
        <span className="rvc-slopes__deg-sep">–</span>
        <InlineNumericInput
          valueDeg={band.maxDeg}
          unit={unit}
          editable={maxEditable}
          onCommit={handleMaxCommit}
        />
        {category && (
          <span className="rvc-slopes__band-category">({category})</span>
        )}
      </div>

      <ColorPalettePicker
        color={band.color}
        onChange={(color) => onColorChange?.(band.id, color)}
        className="rvc-slopes__color-chip"
        ariaLabel={t('Choisir la couleur de {{name}}', { name: category || band.label || band.id })}
      >
        <ColorSwatch color={band.color} size={12} />
        <span className="rvc-slopes__color-hex">{hexLabel(band.color)}</span>
        <IconChevronDown size={20} className="rvc-slopes__color-chevron" />
      </ColorPalettePicker>
    </div>
  );
}

// ── Main section ──────────────────────────────────────────────────────

export function SlopesSection({
  enabled,
  state,
  open,
  onOpenChange,
  onEnabledChange,
  onResolutionChange,
  onColorizationChange,
  onScaleChange,
  onScaleSettingChange,
  onOpacityChange,
  onBandColorChange,
  onBandVisibilityToggle,
  onBandBreakpointChange,
  noTopBorder,
  showResolution = true,
}: Props) {
  const { t } = useAppI18n();
  const visibleBands = state.bands;

  return (
    <Section
      title="Pentes"
      icon={<IconSlope size={16} />}
      noTopBorder={noTopBorder}
      toggle={{ checked: enabled, onChange: onEnabledChange }}
      open={open}
      onOpenChange={onOpenChange}
    >
      {showResolution ? (
        <div className="rvc-row rvc-row--split">
          <span className="rvc-row__label">{t('Résolution')}</span>
          <Select
            width="var(--rvc-panel-select-md)"
            value={state.resolution}
            options={RESOLUTION_OPTIONS}
            onChange={(v) => onResolutionChange?.(v as SlopeResolution)}
          />
        </div>
      ) : null}

      <div className="rvc-row rvc-row--split">
        <span className="rvc-row__label">{t('Type de colorisation')}</span>
        <Select
          width="var(--rvc-panel-select-md)"
          value={state.colorization}
          options={COLORIZATION_OPTIONS}
          onChange={(v) => onColorizationChange?.(v as SlopeColorization)}
        />
      </div>

      <div className="rvc-row rvc-row--split">
        <span className="rvc-row__label">{t('Échelle')}</span>
        <Select
          width="var(--rvc-panel-select-md)"
          value={state.scale}
          options={SCALE_OPTIONS}
          onChange={(v) => onScaleChange?.(v as SlopeScale)}
        />
      </div>

      <div className="rvc-row rvc-row--split">
        <span className="rvc-row__label">{t('Réglage échelle')}</span>
        <Select
          width="var(--rvc-panel-select-md)"
          value={state.scaleSetting}
          options={SCALE_SETTING_OPTIONS}
          onChange={(v) => onScaleSettingChange?.(v as SlopeScaleSetting)}
        />
      </div>

      <div className="rvc-row rvc-row--split rvc-slopes__opacity-row">
        <span className="rvc-row__label">{t('Opacité')}</span>
        <div className="rvc-slopes__opacity-control">
          <div className="rvc-slopes__opacity-slider-wrap">
            <Slider
              min={0}
              max={100}
              value={state.opacity}
              onChange={onOpacityChange}
              width="100%"
            />
          </div>
          <span className="rvc-slopes__opacity-value">{state.opacity} %</span>
        </div>
      </div>

      <div className="rvc-slopes__bands">
        {visibleBands.map((band, i) => (
          <BandRow
            key={band.id}
            band={band}
            bandIndex={i}
            isFirst={i === 0}
            isLast={i === visibleBands.length - 1}
            scale={state.scale}
            onColorChange={onBandColorChange}
            onVisibilityToggle={onBandVisibilityToggle}
            onBreakpointChange={onBandBreakpointChange}
          />
        ))}
      </div>
    </Section>
  );
}
