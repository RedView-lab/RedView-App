import { Section } from '../components/Section';
import { Select } from '../components/Select';
import { ColorSwatch } from '../components/ColorSwatch';
import { IconEye } from '../icons';
import type { ControlPanelHandlers, ControlPanelState, RouteRenderMode } from '../types';

interface Props {
  enabled: boolean;
  items: ControlPanelState['routes']['items'];
  onEnabledChange: ControlPanelHandlers['onRoutesEnabledChange'];
  onColorChange: ControlPanelHandlers['onRouteColorChange'];
  onModeChange: ControlPanelHandlers['onRouteModeChange'];
  onOpacityChange: ControlPanelHandlers['onRouteOpacityChange'];
  onVisibilityToggle: ControlPanelHandlers['onRouteVisibilityToggle'];
}

const MODE_OPTIONS: { value: RouteRenderMode; label: string }[] = [
  { value: 'default', label: 'Défaut' },
  { value: 'slope', label: 'Pente' },
  { value: 'speedEst', label: 'Vitesse est.' },
];

export function RoutesSection({
  enabled,
  items,
  onEnabledChange,
  onModeChange,
  onOpacityChange,
  onVisibilityToggle,
}: Props) {
  return (
    <Section
      title="Itinéraires"
      toggle={{ checked: enabled, onChange: onEnabledChange }}
    >
      <div className="rvc-routes__list">
        {items.map((route) => (
          <div key={route.id} className="rvc-routes__row">
            <div className="rvc-routes__color-picker">
              {/* native color input for swatch selection */}
              <ColorSwatch color={route.color} />
            </div>
            <div className="rvc-routes__label">{route.label}</div>
            <Select
              width={80}
              value={route.mode}
              options={MODE_OPTIONS}
              onChange={(v) => onModeChange?.(route.id, v)}
            />
            <button
              type="button"
              className="rvc-routes__opacity"
              onClick={() => onVisibilityToggle?.(route.id)}
            >
              <IconEye size={10} />
              <span>{route.opacity} %</span>
              <input
                type="range"
                min={0}
                max={100}
                value={route.opacity}
                onChange={(e) => onOpacityChange?.(route.id, Number(e.target.value))}
                className="rvc-routes__opacity-range"
                aria-label="Opacité"
              />
            </button>
          </div>
        ))}
      </div>
    </Section>
  );
}
