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
];

function bandCountForSetting(setting: SlopeScaleSetting): number {
  const m = /^(\d+)/.exec(setting);
  return m ? Number(m[1]) : 4;
}

function hexLabel(color: string): string {
  return color.replace('#', '').toUpperCase();
}

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
}: Props) {
  const isGradient = state.colorization === 'gradient';
  const visibleBands: SlopeBand[] = isGradient
    ? state.bands.slice(0, bandCountForSetting(state.scaleSetting))
    : state.bands;

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

      {isGradient && (
        <>
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
        </>
      )}

      <div className="rvc-row rvc-row--split rvc-slopes__opacity-row">
        <span className="rvc-row__label">Opacité</span>
        <div className="rvc-slopes__opacity-control">
          <span className="rvc-row__value-sm">{state.opacity} %</span>
          <Slider value={state.opacity} onChange={onOpacityChange} />
        </div>
      </div>

      <div className="rvc-slopes__bands">
        {visibleBands.map((band) => (
          <div
            key={band.id}
            className={`rvc-slopes__band-row${band.visible ? '' : ' is-hidden'}`}
          >
            <button
              type="button"
              className="rvc-icon-btn rvc-icon-btn--ghost rvc-slopes__band-eye"
              onClick={() => onBandVisibilityToggle?.(band.id)}
              aria-label={band.visible ? 'Masquer la bande' : 'Afficher la bande'}
              title={band.label ?? band.percentRange}
            >
              {band.visible ? <IconEye size={10} /> : <IconEyeOff size={10} />}
            </button>
            <span
              className="rvc-slopes__band-label"
              title={band.label ?? band.percentRange}
            >
              {band.label ?? band.percentRange}
            </span>
            <div className="rvc-slopes__color-chip">
              <ColorSwatch color={band.color} size={12} />
              <span className="rvc-slopes__color-hex">{hexLabel(band.color)}</span>
              <IconChevronDown size={20} className="rvc-slopes__color-chevron" />
            </div>
          </div>
        ))}
      </div>
    </Section>
  );
}
