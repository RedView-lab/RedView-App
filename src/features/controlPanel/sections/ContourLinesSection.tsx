import { Section } from '../components/Section';
import { Select } from '../components/Select';
import { Slider } from '../components/Slider';
import { IconContourLines } from '../icons';
import type { ControlPanelHandlers, ContourIntervalSetting } from '../types';

const INTERVAL_OPTIONS: { value: ContourIntervalSetting; label: string }[] = [
  { value: '20m', label: '20m' },
  { value: '50m', label: '50m' },
  { value: '100m', label: '100m' },
  { value: '200m', label: '200m' },
];

interface Props {
  enabled: boolean;
  interval: ContourIntervalSetting;
  opacity: number;
  available?: boolean;
  open?: boolean;
  onOpenChange?: (open: boolean) => void;
  onEnabledChange?: ControlPanelHandlers['onContourLinesEnabledChange'];
  onIntervalChange?: ControlPanelHandlers['onContourLinesIntervalChange'];
  onOpacityChange?: ControlPanelHandlers['onContourLinesOpacityChange'];
}

export function ContourLinesSection({
  enabled,
  interval,
  opacity,
  available = true,
  open,
  onOpenChange,
  onEnabledChange,
  onIntervalChange,
  onOpacityChange,
}: Props) {
  return (
    <Section
      title="Courbes de niveau"
      icon={<IconContourLines size={16} />}
      toggle={{ checked: enabled, onChange: onEnabledChange, disabled: !available }}
      open={open}
      onOpenChange={onOpenChange}
    >
      <div className={`rvc-contour-lines${available ? '' : ' is-unavailable'}`}>
        {!available ? (
          <p className="rvc-contour-lines__hint">
            Disponible uniquement avec le fond Topographique.
          </p>
        ) : null}

        <div className="rvc-row rvc-row--split">
          <span className="rvc-row__label">Courbes de niveau</span>
          <Select
            width={140}
            value={interval}
            options={INTERVAL_OPTIONS}
            onChange={(value) => onIntervalChange?.(value as ContourIntervalSetting)}
            className="rvc-contour-lines__select"
            disabled={!available}
          />
        </div>

        <div className="rvc-row rvc-row--split rvc-contour-lines__opacity-row">
          <span className="rvc-row__label">Opacité</span>
          <div className="rvc-contour-lines__opacity-control">
            <div className="rvc-contour-lines__opacity-slider-wrap">
              <Slider
                value={opacity}
                onChange={onOpacityChange}
                width="100%"
                disabled={!available}
              />
            </div>
            <span className="rvc-contour-lines__opacity-value">{opacity}%</span>
          </div>
        </div>
      </div>
    </Section>
  );
}