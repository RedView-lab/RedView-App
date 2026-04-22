import { ColorPalettePicker } from '../components/ColorPalettePicker';
import { ColorSwatch } from '../components/ColorSwatch';
import { Section } from '../components/Section';
import { Select } from '../components/Select';
import { Slider } from '../components/Slider';
import { IconChevronDown, IconEye, IconEyeOff } from '../icons';
import type {
  AltitudeBand,
  AltitudeColorization,
  AltitudeResolution,
  AltitudeScaleSetting,
  ControlPanelHandlers,
  ControlPanelState,
} from '../types';

const RESOLUTION_OPTIONS: { value: AltitudeResolution; label: string }[] = [
  { value: '0.40 m (LIDAR)', label: '0.40 m (LIDAR)' },
  { value: '1 m', label: '1 m' },
  { value: '5 m', label: '5 m' },
  { value: '10 m', label: '10 m' },
];

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

function AltitudeBandRow({
  band,
  onToggleVisibility,
  onColorChange,
}: {
  band: AltitudeBand;
  onToggleVisibility: () => void;
  onColorChange: (color: string) => void;
}) {
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

      <span className="rvc-altitude__band-label">{band.label}</span>

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
  onResolutionChange?: ControlPanelHandlers['onAltitudeResolutionChange'];
  onColorizationChange?: ControlPanelHandlers['onAltitudeColorizationChange'];
  onScaleSettingChange?: ControlPanelHandlers['onAltitudeScaleSettingChange'];
  onOpacityChange?: ControlPanelHandlers['onAltitudeOpacityChange'];
  onBandColorChange?: ControlPanelHandlers['onAltitudeBandColorChange'];
  onBandVisibilityToggle?: ControlPanelHandlers['onAltitudeBandVisibilityToggle'];
}

export function AltitudeSection({
  state,
  enabled = true,
  open,
  onEnabledChange,
  onOpenChange,
  onResolutionChange,
  onColorizationChange,
  onScaleSettingChange,
  onOpacityChange,
  onBandColorChange,
  onBandVisibilityToggle,
}: AltitudeSectionProps) {
  return (
    <Section
      title="Altitude"
      toggle={{ checked: enabled, onChange: onEnabledChange }}
      open={open}
      onOpenChange={onOpenChange}
    >
      <div className="rvc-row rvc-row--split">
        <span className="rvc-row__label">Résolution</span>
        <Select
          width={140}
          value={state.resolution}
          options={RESOLUTION_OPTIONS}
          onChange={(value) => onResolutionChange?.(value as AltitudeResolution)}
        />
      </div>

      <div className="rvc-row rvc-row--split">
        <span className="rvc-row__label">Type de colorisation</span>
        <Select
          width={140}
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
          width={140}
          value={state.scaleSetting}
          options={SCALE_OPTIONS}
          onChange={(value) => onScaleSettingChange?.(value as AltitudeScaleSetting)}
        />
      </div>

      <div className="rvc-altitude__bands">
        {state.bands.map((band) => (
          <AltitudeBandRow
            key={band.id}
            band={band}
            onToggleVisibility={() => onBandVisibilityToggle?.(band.id)}
            onColorChange={(color) => onBandColorChange?.(band.id, color)}
          />
        ))}
      </div>
    </Section>
  );
}