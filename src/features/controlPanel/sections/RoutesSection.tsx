import { useEffect, useRef, useState } from 'react';
import type { RouteDisplayQuality } from '@/features/itineraryPanel/types';
import { useAppI18n } from '@/shared/i18n';
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
  quality: RouteDisplayQuality;
  open?: boolean;
  onOpenChange?: (open: boolean) => void;
  onEnabledChange: ControlPanelHandlers['onRoutesEnabledChange'];
  onColorChange: ControlPanelHandlers['onRouteColorChange'];
  onModeChange: ControlPanelHandlers['onRouteModeChange'];
  onOpacityChange: ControlPanelHandlers['onRouteOpacityChange'];
  onVisibilityToggle: ControlPanelHandlers['onRouteVisibilityToggle'];
  onTraceWidthChange?: ControlPanelHandlers['onRouteTraceWidthChange'];
  onQualityChange?: ControlPanelHandlers['onRouteQualityChange'];
}

const QUALITY_OPTIONS: { value: RouteDisplayQuality; label: string }[] = [
  { value: 'auto', label: 'Auto' },
  { value: 'default', label: 'Rapide' },
  { value: 'balanced', label: 'Équilibré' },
  { value: 'max', label: 'Maximum' },
];

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
 * Pastille « 52 % » — un clic transforme le libellé en champ modifiable.
 * Valide à la perte du focus ou sur Entrée, annule sur Échap. Les valeurs sont
 * bornées à 0–100 et arrondies à l'entier.
 */
function OpacityPill({ value, onChange }: OpacityPillProps) {
  const { t } = useAppI18n();
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(String(value));
  const inputRef = useRef<HTMLInputElement | null>(null);

  // Hors édition, le brouillon suit la valeur reçue.
  if (!editing && draft !== String(value)) setDraft(String(value));

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
          aria-label={t('Opacité')}
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
      title={t('Cliquer pour éditer l’opacité')}
    >
      <span>{value} %</span>
    </button>
  );
}

export function RoutesSection({
  enabled,
  items,
  traceWidthPx,
  quality,
  open,
  onOpenChange,
  onEnabledChange,
  onColorChange,
  onModeChange,
  onOpacityChange,
  onVisibilityToggle,
  onTraceWidthChange,
  onQualityChange,
}: Props) {
  const { t } = useAppI18n();

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
              ariaLabel={t('Choisir la couleur de {{name}}', { name: route.label })}
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
                aria-label={route.visible ? t('Masquer la trace') : t('Afficher la trace')}
                title={route.visible ? t('Masquer la trace') : t('Afficher la trace')}
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
          <span className="rvc-row__label">{t('Épaisseur des tracés')}</span>
          <div className="rvc-routes__trace-width-control">
            <div className="rvc-routes__trace-width-slider-wrap">
              <Slider
                value={traceWidthPx}
                min={1}
                max={20}
                step={1}
                onChange={onTraceWidthChange}
                width="100%"
              />
            </div>
            <span className="rvc-routes__trace-width-value">{traceWidthPx} px</span>
          </div>
        </div>

        <div
          className="rvc-row rvc-row--split rvc-routes__quality-row"
          title={t('Auto : rapide en 2D et sur le relief 30 m, maximum en 3D sur le relief HD (1 m, 0,40 m).')}
        >
          <span className="rvc-row__label">{t('Qualité tracé')}</span>
          <Select
            className="rvc-routes__quality-select"
            width="140px"
            value={quality}
            options={QUALITY_OPTIONS}
            onChange={onQualityChange}
          />
        </div>
      </div>
    </Section>
  );
}

