import { useEffect, useRef, useState } from 'react';
import { Section } from '../components/Section';
import { Select } from '../components/Select';
import { Slider } from '../components/Slider';
import { ColorSwatch } from '../components/ColorSwatch';
import { ColorPalettePicker } from '../components/ColorPalettePicker';
import { IconChevronDown, IconEye, IconRoute } from '../icons';
import type { ControlPanelHandlers, ControlPanelState, RouteRenderMode } from '../types';

interface Props {
  enabled: boolean;
  items: ControlPanelState['routes']['items'];
  traceWidthPx: number;
  open?: boolean;
  onOpenChange?: (open: boolean) => void;
  onEnabledChange: ControlPanelHandlers['onRoutesEnabledChange'];
  onColorChange: ControlPanelHandlers['onRouteColorChange'];
  onModeChange: ControlPanelHandlers['onRouteModeChange'];
  onOpacityChange: ControlPanelHandlers['onRouteOpacityChange'];
  onVisibilityToggle: ControlPanelHandlers['onRouteVisibilityToggle'];
  onTraceWidthChange?: ControlPanelHandlers['onRouteTraceWidthChange'];
}

const MODE_OPTIONS: { value: RouteRenderMode; label: string }[] = [
  { value: 'default', label: 'Défaut' },
  { value: 'slope', label: 'Pente' },
  { value: 'speedEst', label: 'Vitesse est.' },
];

interface OpacityPillProps {
  value: number;
  onChange: (next: number) => void;
}

/**
 * "52 %" pill — clicking turns the label into an inline editable input.
 * Commits on blur or Enter, cancels on Escape. Values are clamped to
 * 0–100 and rounded to integers.
 */
function OpacityPill({ value, onChange }: OpacityPillProps) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(String(value));
  const inputRef = useRef<HTMLInputElement | null>(null);

  useEffect(() => {
    if (!editing) setDraft(String(value));
  }, [value, editing]);

  useEffect(() => {
    if (editing && inputRef.current) {
      inputRef.current.focus();
      inputRef.current.select();
    }
  }, [editing]);

  const commit = () => {
    const n = Number(draft);
    if (Number.isFinite(n)) {
      const clamped = Math.max(0, Math.min(100, Math.round(n)));
      if (clamped !== value) onChange(clamped);
    }
    setEditing(false);
  };

  if (editing) {
    return (
      <span className="rvc-routes__opacity rvc-routes__opacity--editing">
        <input
          ref={inputRef}
          type="number"
          min={0}
          max={100}
          step={1}
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          onBlur={commit}
          onKeyDown={(e) => {
            if (e.key === 'Enter') commit();
            else if (e.key === 'Escape') {
              setDraft(String(value));
              setEditing(false);
            }
          }}
          className="rvc-routes__opacity-input"
          aria-label="Opacité"
        />
        <span>%</span>
      </span>
    );
  }

  return (
    <button
      type="button"
      className="rvc-routes__opacity"
      onClick={() => setEditing(true)}
      title="Cliquer pour éditer l’opacité"
    >
      <span>{value} %</span>
    </button>
  );
}

export function RoutesSection({
  enabled,
  items,
  traceWidthPx,
  open,
  onOpenChange,
  onEnabledChange,
  onColorChange,
  onModeChange,
  onOpacityChange,
  onVisibilityToggle,
  onTraceWidthChange,
}: Props) {
  return (
    <Section
      title="Itinéraires"
      icon={<IconRoute size={16} />}
      toggle={{ checked: enabled, onChange: onEnabledChange }}
      open={open}
      onOpenChange={onOpenChange}
    >
      <div className="rvc-routes__list">
        {items.map((route) => (
          <div key={route.id} className="rvc-routes__row">
            <ColorPalettePicker
              color={route.color}
              onChange={(nextColor) => onColorChange?.(route.id, nextColor)}
              className="rvc-routes__color-picker"
              ariaLabel={`Choisir la couleur de ${route.label}`}
            >
              <ColorSwatch color={route.color} size={12} />
              <IconChevronDown size={20} />
            </ColorPalettePicker>
            <div className="rvc-routes__label">{route.label}</div>
            <Select
              className="rvc-routes__mode-select"
              width="var(--rvc-panel-route-mode-width)"
              value={route.mode}
              options={MODE_OPTIONS}
              onChange={(v) => onModeChange?.(route.id, v)}
            />
            <div className="rvc-routes__visibility-group" data-visible={route.visible ? 'true' : 'false'}>
              <button
                type="button"
                className="rvc-routes__eye"
                onClick={() => onVisibilityToggle?.(route.id)}
                aria-pressed={route.visible}
                aria-label={route.visible ? 'Masquer la trace' : 'Afficher la trace'}
                title={route.visible ? 'Masquer la trace' : 'Afficher la trace'}
              >
                <IconEye size={14} />
              </button>
              <OpacityPill
                value={route.opacity}
                onChange={(next) => onOpacityChange?.(route.id, next)}
              />
            </div>
          </div>
        ))}

        <div className="rvc-row rvc-row--split rvc-routes__trace-width-row">
          <span className="rvc-row__label">Épaisseur des tracés</span>
          <div className="rvc-routes__trace-width-control">
            <div className="rvc-routes__trace-width-slider-wrap">
              <Slider
                value={traceWidthPx}
                min={1}
                max={8}
                step={1}
                onChange={onTraceWidthChange}
                width="100%"
              />
            </div>
            <span className="rvc-routes__trace-width-value">{traceWidthPx} px</span>
          </div>
        </div>
      </div>
    </Section>
  );
}
