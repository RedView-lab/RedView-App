import { memo, useEffect, useRef, useState } from 'react';
import { Section } from '@/features/controlPanel/components/Section';
import { Select } from '@/features/controlPanel/components/Select';
import { Slider } from '@/features/controlPanel/components/Slider';
import { ColorSwatch } from '@/features/controlPanel/components/ColorSwatch';
import { ColorPalettePicker } from '@/features/controlPanel/components/ColorPalettePicker';
import { IconChevronDown, IconEye, IconRoute } from '@/features/controlPanel/icons';
import { IconPlus } from '@/features/itineraryPanel/components/icons';
import type { ViewerRouteState } from '../route/types';

export interface RouteSectionProps {
  state: ViewerRouteState;
  open?: boolean;
  onOpenChange?: (open: boolean) => void;
  onEnabledChange: (enabled: boolean) => void;
  onSelectRouteId?: (id: string) => void;
  onCreateRoute?: () => void;
  onColorChange?: (id: string, color: string) => void;
  onRouteOpacityChange?: (id: string, opacity: number) => void;
  onVisibilityToggle?: (id: string) => void;
  onRibbonWidthChange: (widthM: number) => void;
  onToggleEditMode?: (id: string) => void;
}

const MODE_OPTIONS = [
  { value: 'default', label: 'Défaut' },
  { value: 'slope', label: 'Pente' },
  { value: 'speedEst', label: 'Vitesse est.' },
];

interface OpacityPillProps {
  value: number;
  onChange: (next: number) => void;
}

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

export const RouteSection = memo(function RouteSection({
  state,
  open = true,
  onOpenChange,
  onEnabledChange,
  onSelectRouteId,
  onCreateRoute,
  onColorChange,
  onRouteOpacityChange,
  onVisibilityToggle,
  onRibbonWidthChange,
  onToggleEditMode,
}: RouteSectionProps) {
  const { enabled, ribbonWidthM, routes, activeRoute, editMode } = state;

  const handleRouteClick = (routeId: string) => {
    if (activeRoute?.id === routeId && editMode) {
      // Toggle off if already active
      onToggleEditMode?.(routeId);
    } else {
      // Select and activate 3D tracing on tiles
      onSelectRouteId?.(routeId);
      onToggleEditMode?.(routeId);
    }
  };

  return (
    <Section
      title="Itinéraires"
      icon={<IconRoute size={16} />}
      toggle={{ checked: enabled, onChange: onEnabledChange }}
      open={open}
      onOpenChange={onOpenChange}
    >
      <div className="rvc-routes__list">

        {routes.map((route) => {
          const isActive = activeRoute?.id === route.id;
          const isDrawing = isActive && editMode;

          return (
            <div key={route.id} className="rvc-routes__row">
              <ColorPalettePicker
                color={route.color}
                onChange={(nextColor) => onColorChange?.(route.id, nextColor)}
                className="rvc-routes__color-picker"
                ariaLabel={`Choisir la couleur de ${route.name}`}
              >
                <ColorSwatch color={route.color} size={12} />
                <IconChevronDown size={20} />
              </ColorPalettePicker>

              <div
                className="rvc-routes__label"
                onClick={() => handleRouteClick(route.id)}
                style={{
                  cursor: 'pointer',
                  color: isDrawing ? '#4ade80' : isActive ? '#fff' : undefined,
                  fontWeight: isActive ? 700 : 600,
                  opacity: isDrawing || isActive ? 1 : 0.64,
                }}
                title={isDrawing ? 'En cours de tracé 3D (cliquez sur les dalles)' : 'Cliquer pour tracer sur les dalles 3D'}
              >
                {isDrawing ? `● ${route.name}` : route.name}
              </div>

              <Select
                className="rvc-routes__mode-select"
                width="var(--rvc-panel-route-mode-width)"
                value="default"
                options={MODE_OPTIONS}
                onChange={() => {}}
              />

              <div className="rvc-routes__visibility-group" data-visible={route.visible !== false ? 'true' : 'false'}>
                <button
                  type="button"
                  className="rvc-routes__eye"
                  onClick={() => onVisibilityToggle?.(route.id)}
                  aria-pressed={route.visible !== false}
                  aria-label={route.visible !== false ? 'Masquer la trace' : 'Afficher la trace'}
                  title={route.visible !== false ? 'Masquer la trace' : 'Afficher la trace'}
                >
                  <IconEye size={14} />
                </button>
                <OpacityPill
                  value={Math.round((route.opacity ?? 1) * 100)}
                  onChange={(next) => onRouteOpacityChange?.(route.id, next)}
                />
              </div>
            </div>
          );
        })}

        <button
          type="button"
          className="rvc-routes__add-btn"
          onClick={onCreateRoute}
          title="Créer un nouvel itinéraire sur les dalles 3D"
        >
          <span className="rvc-routes__add-icon" aria-hidden>
            <IconPlus size={13} />
          </span>
          <span className="rvc-routes__add-label">Nouvel itinéraire</span>
        </button>

        <div className="rvc-row rvc-row--split rvc-routes__trace-width-row">
          <span className="rvc-row__label">Épaisseur des tracés</span>
          <div className="rvc-routes__trace-width-control">
            <div className="rvc-routes__trace-width-slider-wrap">
              <Slider
                value={ribbonWidthM}
                min={1}
                max={20}
                step={1}
                onChange={onRibbonWidthChange}
                width="100%"
              />
            </div>
            <span className="rvc-routes__trace-width-value">{Math.round(ribbonWidthM)} px</span>
          </div>
        </div>
      </div>
    </Section>
  );
});
