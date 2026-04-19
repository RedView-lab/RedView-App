import { useState, useRef, useEffect, useCallback } from 'react';
import { Section } from '../components/Section';
import { Select } from '../components/Select';
import { Slider } from '../components/Slider';
import { ColorSwatch } from '../components/ColorSwatch';
import { IconChevronDown, IconEye, IconEyeOff } from '../icons';
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
  onEnabledChange: ControlPanelHandlers['onSlopesEnabledChange'];
  onResolutionChange: ControlPanelHandlers['onSlopeResolutionChange'];
  onColorizationChange: ControlPanelHandlers['onSlopeColorizationChange'];
  onScaleChange: ControlPanelHandlers['onSlopeScaleChange'];
  onScaleSettingChange: ControlPanelHandlers['onSlopeScaleSettingChange'];
  onOpacityChange: ControlPanelHandlers['onSlopeOpacityChange'];
  onBandColorChange: ControlPanelHandlers['onSlopeBandColorChange'];
  onBandVisibilityToggle: ControlPanelHandlers['onSlopeBandVisibilityToggle'];
  onBandBreakpointChange?: ControlPanelHandlers['onSlopeBandBreakpointChange'];
}

const RESOLUTION_OPTIONS: { value: SlopeResolution; label: string }[] = [
  { value: '1m (LIDAR)', label: '1m (LIDAR)' },
  { value: '5m', label: '5m' },
  { value: '10m', label: '10m' },
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

// ── Inline editable degree input ──────────────────────────────────────
// Renders as text by default. Click to enter edit mode, type a number,
// commit on Enter / blur, cancel on Escape. Validates 0–90 range.

interface InlineDegreeInputProps {
  value: number;
  /** Is this value editable? First band min (0°) and last band max (90°) are not. */
  editable: boolean;
  /** Called with new degree value on commit */
  onCommit: (deg: number) => void;
  className?: string;
}

function InlineDegreeInput({ value, editable, onCommit, className }: InlineDegreeInputProps) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(String(value));
  const inputRef = useRef<HTMLInputElement>(null);

  // Sync draft when external value changes (e.g. after clamping)
  useEffect(() => {
    if (!editing) setDraft(String(value));
  }, [value, editing]);

  // Auto-focus & select when entering edit mode
  useEffect(() => {
    if (editing && inputRef.current) {
      inputRef.current.focus();
      inputRef.current.select();
    }
  }, [editing]);

  const commit = useCallback(() => {
    setEditing(false);
    const parsed = parseInt(draft, 10);
    if (Number.isNaN(parsed)) return; // revert silently
    // Clamp to valid range — the backend will also clamp, but give user immediate feedback
    const clamped = Math.max(0, Math.min(90, parsed));
    if (clamped !== value) onCommit(clamped);
  }, [draft, value, onCommit]);

  const handleKeyDown = useCallback(
    (e: React.KeyboardEvent) => {
      if (e.key === 'Enter') {
        e.preventDefault();
        commit();
      } else if (e.key === 'Escape') {
        setDraft(String(value));
        setEditing(false);
      }
    },
    [commit, value],
  );

  if (!editable) {
    return <span className={`rvc-slopes__deg-value ${className ?? ''}`}>{value}°</span>;
  }

  if (!editing) {
    return (
      <button
        type="button"
        className={`rvc-slopes__deg-btn ${className ?? ''}`}
        onClick={() => setEditing(true)}
        title="Cliquer pour modifier l'angle"
      >
        {value}°
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
        // Allow only digits
        const v = e.target.value.replace(/[^\d]/g, '');
        setDraft(v);
      }}
      onBlur={commit}
      onKeyDown={handleKeyDown}
      maxLength={2}
      aria-label="Angle en degrés"
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
  onVisibilityToggle?: (id: string) => void;
  onBreakpointChange?: (bandIndex: number, field: 'min' | 'max', valueDeg: number) => void;
}

function BandRow({
  band,
  bandIndex,
  isFirst,
  isLast,
  scale,
  onVisibilityToggle,
  onBreakpointChange,
}: BandRowProps) {
  const handleMinCommit = useCallback(
    (deg: number) => onBreakpointChange?.(bandIndex, 'min', deg),
    [bandIndex, onBreakpointChange],
  );
  const handleMaxCommit = useCallback(
    (deg: number) => onBreakpointChange?.(bandIndex, 'max', deg),
    [bandIndex, onBreakpointChange],
  );

  // Build the label — show degree range with inline editable values
  const minEditable = !isFirst; // first band always starts at 0°
  const maxEditable = !isLast;  // last band always ends at 90°

  // Category name from label, e.g. "0 - 7% (Modéré)" → "Modéré"
  const categoryMatch = band.label?.match(/\(([^)]+)\)/);
  const category = categoryMatch ? categoryMatch[1] : '';

  return (
    <div className={`rvc-slopes__band-row${band.visible ? '' : ' is-hidden'}`}>
      <button
        type="button"
        className="rvc-icon-btn rvc-icon-btn--ghost rvc-slopes__band-eye"
        onClick={() => onVisibilityToggle?.(band.id)}
        aria-label={band.visible ? 'Masquer la bande' : 'Afficher la bande'}
      >
        {band.visible ? <IconEye size={10} /> : <IconEyeOff size={10} />}
      </button>

      <div className="rvc-slopes__band-label-editable">
        <InlineDegreeInput
          value={band.minDeg}
          editable={minEditable}
          onCommit={handleMinCommit}
        />
        <span className="rvc-slopes__deg-sep">–</span>
        <InlineDegreeInput
          value={band.maxDeg}
          editable={maxEditable}
          onCommit={handleMaxCommit}
        />
        {category && (
          <span className="rvc-slopes__band-category">({category})</span>
        )}
      </div>

      <div className="rvc-slopes__color-chip">
        <ColorSwatch color={band.color} size={12} />
        <span className="rvc-slopes__color-hex">{hexLabel(band.color)}</span>
        <IconChevronDown size={20} className="rvc-slopes__color-chevron" />
      </div>
    </div>
  );
}

// ── Main section ──────────────────────────────────────────────────────

export function SlopesSection({
  enabled,
  state,
  onEnabledChange,
  onResolutionChange,
  onColorizationChange,
  onScaleChange,
  onScaleSettingChange,
  onOpacityChange,
  onBandVisibilityToggle,
  onBandBreakpointChange,
}: Props) {
  const visibleBands = state.bands;

  return (
    <Section
      title="Pentes"
      toggle={{ checked: enabled, onChange: onEnabledChange }}
    >
      <div className="rvc-row rvc-row--split">
        <span className="rvc-row__label">Résolution</span>
        <Select
          width={140}
          value={state.resolution}
          options={RESOLUTION_OPTIONS}
          onChange={(v) => onResolutionChange?.(v as SlopeResolution)}
        />
      </div>

      <div className="rvc-row rvc-row--split">
        <span className="rvc-row__label">Type de colorisation</span>
        <Select
          width={140}
          value={state.colorization}
          options={COLORIZATION_OPTIONS}
          onChange={(v) => onColorizationChange?.(v as SlopeColorization)}
        />
      </div>

      <div className="rvc-row rvc-row--split">
        <span className="rvc-row__label">Échelle</span>
        <Select
          width={140}
          value={state.scale}
          options={SCALE_OPTIONS}
          onChange={(v) => onScaleChange?.(v as SlopeScale)}
        />
      </div>

      <div className="rvc-row rvc-row--split">
        <span className="rvc-row__label">Réglage échelle</span>
        <Select
          width={140}
          value={state.scaleSetting}
          options={SCALE_SETTING_OPTIONS}
          onChange={(v) => onScaleSettingChange?.(v as SlopeScaleSetting)}
        />
      </div>

      <div className="rvc-row rvc-row--split rvc-slopes__opacity-row">
        <span className="rvc-row__label">Opacité</span>
        <div className="rvc-slopes__opacity-control">
          <span className="rvc-row__value-sm">{state.opacity} %</span>
          <Slider value={state.opacity} onChange={onOpacityChange} />
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
            onVisibilityToggle={onBandVisibilityToggle}
            onBreakpointChange={onBandBreakpointChange}
          />
        ))}
      </div>
    </Section>
  );
}
