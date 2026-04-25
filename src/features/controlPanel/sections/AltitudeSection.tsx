import { useCallback, useEffect, useRef, useState } from 'react';
import { ColorPalettePicker } from '../components/ColorPalettePicker';
import { ColorSwatch } from '../components/ColorSwatch';
import { Section } from '../components/Section';
import { Select } from '../components/Select';
import { Slider } from '../components/Slider';
import { IconChevronDown, IconEye, IconEyeOff } from '../icons';
import type {
  AltitudeBand,
  AltitudeColorization,
  AltitudeScaleSetting,
  ControlPanelHandlers,
  ControlPanelState,
} from '../types';

const COLORIZATION_OPTIONS: { value: AltitudeColorization; label: string }[] = [
  { value: 'gradient', label: 'Dégradé' },
  { value: 'stepped', label: 'Remplissage' },
];

const SCALE_OPTIONS: { value: AltitudeScaleSetting; label: string }[] = [
  { value: '2 couleurs', label: '2 couleurs' },
  { value: '3 couleurs', label: '3 couleurs' },
  { value: '4 couleurs', label: '4 couleurs' },
  { value: '6 couleurs', label: '6 couleurs' },
];

function hexLabel(color: string): string {
  return color.replace('#', '').toUpperCase();
}

interface InlineAltitudeInputProps {
  valueMeters: number;
  editable: boolean;
  onCommit: (meters: number) => void;
  className?: string;
}

function InlineAltitudeInput({
  valueMeters,
  editable,
  onCommit,
  className,
}: InlineAltitudeInputProps) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(String(valueMeters));
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (editing && inputRef.current) {
      inputRef.current.focus();
      inputRef.current.select();
    }
  }, [editing]);

  const commit = useCallback(() => {
    setEditing(false);
    const parsed = parseInt(draft, 10);
    if (Number.isNaN(parsed)) return;
    const nextMeters = Math.max(0, Math.min(5000, parsed));
    if (nextMeters !== valueMeters) onCommit(nextMeters);
  }, [draft, onCommit, valueMeters]);

  const handleKeyDown = useCallback(
    (e: React.KeyboardEvent) => {
      if (e.key === 'Enter') {
        e.preventDefault();
        commit();
      } else if (e.key === 'Escape') {
        setDraft(String(valueMeters));
        setEditing(false);
      }
    },
    [commit, valueMeters],
  );

  if (!editable) {
    return <span className={`rvc-altitude__meter-value ${className ?? ''}`}>{valueMeters} m</span>;
  }

  if (!editing) {
    return (
      <button
        type="button"
        className={`rvc-altitude__meter-btn ${className ?? ''}`}
        onClick={() => {
          setDraft(String(valueMeters));
          setEditing(true);
        }}
        title="Cliquer pour modifier l'altitude"
      >
        {valueMeters} m
      </button>
    );
  }

  return (
    <input
      ref={inputRef}
      type="text"
      inputMode="numeric"
      className={`rvc-altitude__meter-input ${className ?? ''}`}
      value={draft}
      onChange={(e) => setDraft(e.target.value.replace(/[^\d]/g, ''))}
      onBlur={commit}
      onKeyDown={handleKeyDown}
      maxLength={4}
      aria-label="Altitude en mètres"
    />
  );
}

function AltitudeBandRow({
  band,
  bandIndex,
  isFirst,
  isLast,
  onToggleVisibility,
  onColorChange,
  onBreakpointChange,
}: {
  band: AltitudeBand;
  bandIndex: number;
  isFirst: boolean;
  isLast: boolean;
  onToggleVisibility: () => void;
  onColorChange: (color: string) => void;
  onBreakpointChange?: (bandIndex: number, field: 'min' | 'max', valueMeters: number) => void;
}) {
  const handleMinCommit = useCallback(
    (meters: number) => onBreakpointChange?.(bandIndex, 'min', meters),
    [bandIndex, onBreakpointChange],
  );
  const handleMaxCommit = useCallback(
    (meters: number) => onBreakpointChange?.(bandIndex, 'max', meters),
    [bandIndex, onBreakpointChange],
  );

  return (
    <div className={`rvc-altitude__band-row${band.visible ? '' : ' is-hidden'}`}>
      <button
        type="button"
        className="rvc-icon-btn rvc-icon-btn--ghost rvc-altitude__band-eye"
        onClick={onToggleVisibility}
        aria-label={band.visible ? 'Masquer le niveau' : 'Afficher le niveau'}
      >
        {band.visible ? <IconEye size={12} /> : <IconEyeOff size={12} />}
      </button>

      <div className="rvc-altitude__band-label-editable">
        <InlineAltitudeInput
          valueMeters={band.minMeters}
          editable={!isFirst}
          onCommit={handleMinCommit}
        />
        <span className="rvc-altitude__meter-sep">–</span>
        <InlineAltitudeInput
          valueMeters={band.maxMeters}
          editable={!isLast}
          onCommit={handleMaxCommit}
        />
      </div>

      <ColorPalettePicker
        color={band.color}
        onChange={onColorChange}
        className="rvc-altitude__color-chip"
        ariaLabel={`Choisir la couleur du niveau ${band.label}`}
      >
        <ColorSwatch color={band.color} size={12} />
        <span className="rvc-altitude__color-hex">{hexLabel(band.color)}</span>
        <IconChevronDown size={20} className="rvc-altitude__color-chevron" />
      </ColorPalettePicker>
    </div>
  );
}

interface AltitudeSectionProps {
  state: Omit<ControlPanelState['altitude'], 'enabled'>;
  enabled?: boolean;
  open?: boolean;
  onEnabledChange?: (enabled: boolean) => void;
  onOpenChange?: (open: boolean) => void;
  onColorizationChange?: ControlPanelHandlers['onAltitudeColorizationChange'];
  onScaleSettingChange?: ControlPanelHandlers['onAltitudeScaleSettingChange'];
  onOpacityChange?: ControlPanelHandlers['onAltitudeOpacityChange'];
  onBandColorChange?: ControlPanelHandlers['onAltitudeBandColorChange'];
  onBandVisibilityToggle?: ControlPanelHandlers['onAltitudeBandVisibilityToggle'];
  onBandBreakpointChange?: ControlPanelHandlers['onAltitudeBandBreakpointChange'];
}

export function AltitudeSection({
  state,
  enabled = true,
  open,
  onEnabledChange,
  onOpenChange,
  onColorizationChange,
  onScaleSettingChange,
  onOpacityChange,
  onBandColorChange,
  onBandVisibilityToggle,
  onBandBreakpointChange,
}: AltitudeSectionProps) {
  return (
    <Section
      title="Altitude"
      toggle={{ checked: enabled, onChange: onEnabledChange }}
      open={open}
      onOpenChange={onOpenChange}
    >
      <div className="rvc-row rvc-row--split">
        <span className="rvc-row__label">Type de colorisation</span>
        <Select
          width="var(--rvc-panel-select-md)"
          value={state.colorization}
          options={COLORIZATION_OPTIONS}
          onChange={(value) => onColorizationChange?.(value as AltitudeColorization)}
        />
      </div>

      <div className="rvc-row rvc-row--split rvc-altitude__opacity-row">
        <span className="rvc-row__label">Opacité</span>
        <div className="rvc-altitude__opacity-control">
          <div className="rvc-altitude__opacity-slider-wrap">
            <Slider value={state.opacity} onChange={onOpacityChange} width="100%" />
          </div>
          <span className="rvc-altitude__opacity-value">{state.opacity} %</span>
        </div>
      </div>

      <div className="rvc-row rvc-row--split">
        <span className="rvc-row__label">Échelle</span>
        <Select
          width="var(--rvc-panel-select-md)"
          value={state.scaleSetting}
          options={SCALE_OPTIONS}
          onChange={(value) => onScaleSettingChange?.(value as AltitudeScaleSetting)}
        />
      </div>

      <div className="rvc-altitude__bands">
        {state.bands.map((band, index) => (
          <AltitudeBandRow
            key={band.id}
            band={band}
            bandIndex={index}
            isFirst={index === 0}
            isLast={index === state.bands.length - 1}
            onToggleVisibility={() => onBandVisibilityToggle?.(band.id)}
            onColorChange={(color) => onBandColorChange?.(band.id, color)}
            onBreakpointChange={onBandBreakpointChange}
          />
        ))}
      </div>
    </Section>
  );
}