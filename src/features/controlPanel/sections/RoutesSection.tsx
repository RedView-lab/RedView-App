import { useEffect, useMemo, useRef, useState } from 'react';
import {
  GPX_QUALITY_EXPERT_MAX_POINTS_PER_KM,
  GPX_QUALITY_EXPERT_MIN_POINTS_PER_KM,
  GPX_QUALITY_PRESET_POINTS_PER_KM,
  type GpxQualityStats,
} from '@/features/itineraryPanel/lib/routes';
import type { GpxQualityMode } from '@/features/itineraryPanel/types';
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
  gpxQuality?: GpxQualityMode | null;
  gpxQualityAvailable?: boolean;
  gpxQualityPointsPerKm?: number | null;
  gpxQualityStats?: GpxQualityStats | null;
  open?: boolean;
  onOpenChange?: (open: boolean) => void;
  onEnabledChange: ControlPanelHandlers['onRoutesEnabledChange'];
  onColorChange: ControlPanelHandlers['onRouteColorChange'];
  onModeChange: ControlPanelHandlers['onRouteModeChange'];
  onOpacityChange: ControlPanelHandlers['onRouteOpacityChange'];
  onVisibilityToggle: ControlPanelHandlers['onRouteVisibilityToggle'];
  onTraceWidthChange?: ControlPanelHandlers['onRouteTraceWidthChange'];
  onGpxQualityChange?: (quality: GpxQualityMode) => void;
  onGpxQualityExpertApply?: (pointsPerKm: number) => void;
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
  const { t } = useAppI18n();
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
  gpxQuality,
  gpxQualityAvailable = false,
  gpxQualityPointsPerKm,
  gpxQualityStats,
  open,
  onOpenChange,
  onEnabledChange,
  onColorChange,
  onModeChange,
  onOpacityChange,
  onVisibilityToggle,
  onTraceWidthChange,
  onGpxQualityChange,
  onGpxQualityExpertApply,
}: Props) {
  const { t } = useAppI18n();
  const [expertOpen, setExpertOpen] = useState(false);
  const [expertPointsPerKm, setExpertPointsPerKm] = useState(
    gpxQualityPointsPerKm ?? GPX_QUALITY_PRESET_POINTS_PER_KM.balanced,
  );
  const effectiveQuality = gpxQuality ?? 'default';

  useEffect(() => {
    if (gpxQuality === 'expert') {
      setExpertOpen(true);
    }
  }, [gpxQuality]);

  useEffect(() => {
    const nextPointsPerKm = gpxQuality === 'expert'
      ? gpxQualityPointsPerKm ?? GPX_QUALITY_PRESET_POINTS_PER_KM.balanced
      : gpxQuality != null
        ? GPX_QUALITY_PRESET_POINTS_PER_KM[gpxQuality]
        : GPX_QUALITY_PRESET_POINTS_PER_KM.balanced;
    setExpertPointsPerKm(nextPointsPerKm);
  }, [gpxQuality, gpxQualityPointsPerKm]);

  const previewTargetPointCount = useMemo(() => {
    if (!gpxQualityStats) return null;
    const rawTarget = Math.round(Math.max(gpxQualityStats.distanceKm, 0.25) * expertPointsPerKm);
    return Math.max(2, Math.min(gpxQualityStats.originalPointCount, rawTarget));
  }, [expertPointsPerKm, gpxQualityStats]);

  const previewReductionPercent = useMemo(() => {
    if (!gpxQualityStats || previewTargetPointCount == null || gpxQualityStats.originalPointCount <= 0) {
      return null;
    }
    return Math.max(
      0,
      Math.min(
        100,
        Math.round((1 - previewTargetPointCount / gpxQualityStats.originalPointCount) * 100),
      ),
    );
  }, [gpxQualityStats, previewTargetPointCount]);

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
                min={8}
                max={20}
                step={1}
                onChange={onTraceWidthChange}
                width="100%"
              />
            </div>
            <span className="rvc-routes__trace-width-value">{traceWidthPx} px</span>
          </div>
        </div>

        {gpxQuality != null && (
          <>
            <div className="rvc-row rvc-row--split rvc-routes__quality-row">
              <span className="rvc-row__label">{t('Qualité tracé')}</span>
              <Select
                className="rvc-routes__quality-select"
                width="140px"
                value={effectiveQuality}
                options={[
                  { value: 'default', label: 'Défaut (rapide)' },
                  { value: 'balanced', label: 'Équilibré' },
                  { value: 'max', label: 'Maximum' },
                  { value: 'expert', label: 'Expert' },
                ]}
                onChange={onGpxQualityChange}
                disabled={!gpxQualityAvailable}
              />
            </div>

            {!gpxQualityAvailable ? (
              <div className="rvc-routes__quality-unavailable">
                {t('L’itinéraire actif n’a pas encore de trace GPX exploitable.')}
              </div>
            ) : null}

            <div className="rvc-routes__quality-meta" aria-live="polite">
              <div className="rvc-routes__quality-metric">
                <span className="rvc-routes__quality-metric-label">{t('Paramètre GPX')}</span>
                <span className="rvc-routes__quality-metric-value">{expertPointsPerKm} pts/km</span>
              </div>
              {gpxQualityStats ? (
                <div className="rvc-routes__quality-metric">
                  <span className="rvc-routes__quality-metric-label">{t('Réduction')}</span>
                  <span className="rvc-routes__quality-metric-value">{gpxQualityStats.reductionPercent} %</span>
                </div>
              ) : null}
              <button
                type="button"
                className="rvc-routes__quality-expert-toggle"
                onClick={() => setExpertOpen((current) => !current)}
                disabled={!gpxQualityAvailable}
              >
                {expertOpen ? t('Fermer expert GPX') : t('Ouvrir expert GPX')}
              </button>
            </div>

            {expertOpen && gpxQualityAvailable ? (
              <div className="rvc-routes__quality-expert-panel">
                <div className="rvc-routes__quality-expert-head">
                  <span className="rvc-routes__quality-expert-title">{t('Mode Expert GPX')}</span>
                  <span className="rvc-routes__quality-expert-subtitle">
                    {t('Préserver le profil tout en réduisant le nombre de points affichés.')}
                  </span>
                </div>

                <div className="rvc-routes__quality-expert-slider">
                  <span className="rvc-routes__quality-expert-caption">{t('Densité cible')}</span>
                  <div className="rvc-routes__quality-expert-slider-wrap">
                    <Slider
                      value={expertPointsPerKm}
                      min={GPX_QUALITY_EXPERT_MIN_POINTS_PER_KM}
                      max={GPX_QUALITY_EXPERT_MAX_POINTS_PER_KM}
                      step={1}
                      width="100%"
                      onChange={setExpertPointsPerKm}
                      onCommit={setExpertPointsPerKm}
                    />
                  </div>
                  <span className="rvc-routes__quality-expert-value">{expertPointsPerKm} pts/km</span>
                </div>

                {gpxQualityStats ? (
                  <div className="rvc-routes__quality-expert-stats">
                    <span>{t('Points source')}: {gpxQualityStats.originalPointCount.toLocaleString('fr-FR')}</span>
                    <span>{t('Points rendus')}: {gpxQualityStats.renderedPointCount.toLocaleString('fr-FR')}</span>
                    <span>{t('Cible expert')}: {previewTargetPointCount?.toLocaleString('fr-FR') ?? '-'}</span>
                    <span>{t('Réduction')}: {previewReductionPercent != null ? `${previewReductionPercent} %` : '-'}</span>
                  </div>
                ) : null}

                <div className="rvc-routes__quality-expert-actions">
                  <button
                    type="button"
                    className="rvc-routes__quality-apply"
                    onClick={() => onGpxQualityExpertApply?.(expertPointsPerKm)}
                    disabled={!gpxQualityAvailable}
                  >
                    {t('Appliquer expert GPX')}
                  </button>
                </div>
              </div>
            ) : null}
          </>
        )}
      </div>
    </Section>
  );
}
