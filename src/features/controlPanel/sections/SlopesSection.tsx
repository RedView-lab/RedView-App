import { Section } from '../components/Section';
import { Select } from '../components/Select';
import { Slider } from '../components/Slider';
import { ColorSwatch } from '../components/ColorSwatch';
import { IconEye } from '../icons';
import type {
  ControlPanelHandlers,
  ControlPanelState,
  SlopeColorization,
  SlopeResolution,
} from '../types';

interface Props {
  enabled: boolean;
  state: Omit<ControlPanelState['slopes'], 'enabled'>;
  onEnabledChange: ControlPanelHandlers['onSlopesEnabledChange'];
  onResolutionChange: ControlPanelHandlers['onSlopeResolutionChange'];
  onColorizationChange: ControlPanelHandlers['onSlopeColorizationChange'];
  onOpacityChange: ControlPanelHandlers['onSlopeOpacityChange'];
  onBandColorChange: ControlPanelHandlers['onSlopeBandColorChange'];
  onBandVisibilityToggle: ControlPanelHandlers['onSlopeBandVisibilityToggle'];
}

const RESOLUTION_OPTIONS: { value: SlopeResolution; label: string }[] = [
  { value: '1m (LIDAR)', label: '1m (LIDAR)' },
  { value: '5m', label: '5m' },
  { value: '10m', label: '10m' },
];

const COLORIZATION_OPTIONS: { value: SlopeColorization; label: string }[] = [
  { value: 'gradient', label: 'Dégradé' },
  { value: 'stepped', label: 'Par paliers' },
];

export function SlopesSection({
  enabled,
  state,
  onEnabledChange,
  onResolutionChange,
  onColorizationChange,
  onOpacityChange,
  onBandVisibilityToggle,
}: Props) {
  return (
    <Section
      title="Pentes"
      toggle={{ checked: enabled, onChange: onEnabledChange }}
    >
      <div className="rvc-row rvc-row--split">
        <span className="rvc-row__label">Résolution</span>
        <Select
          width={115}
          value={state.resolution}
          options={RESOLUTION_OPTIONS}
          onChange={(v) => onResolutionChange?.(v as SlopeResolution)}
        />
      </div>

      <div className="rvc-row rvc-row--split">
        <span className="rvc-row__label">Type de colorisation</span>
        <Select
          width={95}
          value={state.colorization}
          options={COLORIZATION_OPTIONS}
          onChange={(v) => onColorizationChange?.(v as SlopeColorization)}
        />
      </div>

      <div className="rvc-row rvc-row--split">
        <span className="rvc-row__label">Opacité</span>
        <span className="rvc-row__value-sm">{state.opacity} %</span>
        <Slider value={state.opacity} onChange={onOpacityChange} width={100} />
      </div>

      <div className="rvc-slopes__bands">
        {state.bands.map((band) => (
          <div key={band.id} className="rvc-slopes__band">
            <button
              type="button"
              className="rvc-icon-btn rvc-icon-btn--ghost"
              onClick={() => onBandVisibilityToggle?.(band.id)}
              aria-label={band.visible ? 'Masquer la bande' : 'Afficher la bande'}
            >
              <IconEye size={10} />
            </button>
            <span className="rvc-slopes__band-range">{band.percentRange}</span>
            <span className="rvc-slopes__band-sep">|</span>
            <span className="rvc-slopes__band-range">{band.degreeRange}</span>
            <div className="rvc-slopes__band-color">
              <ColorSwatch color={band.color} />
              <span>{band.color.replace('#', '').toUpperCase()}</span>
            </div>
          </div>
        ))}
      </div>
    </Section>
  );
}
