import type { CSSProperties } from 'react';
import { AssetIcon } from '@/shared/components/AssetIcon';
import { useAppI18n } from '@/shared/i18n';

import type { OverlayStatusId, OverlayStatusSnapshot } from '../lib/overlayStatus';

interface MapOverlayStatusDockProps {
  statuses: OverlayStatusSnapshot[];
  right: number;
  left?: number;
  top?: number;
  bottom?: number;
  hidden?: boolean;
  align?: 'end' | 'center';
  transform?: string;
  onReload?: (id: OverlayStatusId) => void;
}

/**
 * Un seul contrôle pour tous les overlays (carte, pentes, altitude, météo…) :
 * un bouton ↻ par overlay s'empilait sans libellé, impossible de savoir lequel
 * rechargeait quoi. Tant que tout est prêt → un bouton qui recharge tout ; dès
 * qu'un overlay charge ou échoue → une pilule agrégée (progression moyenne) dont
 * le ↻ recharge en priorité les overlays en erreur.
 */
export default function MapOverlayStatusDock({
  statuses,
  right,
  left,
  top,
  bottom = 88,
  hidden = false,
  align = 'end',
  transform,
  onReload,
}: MapOverlayStatusDockProps) {
  const { t } = useAppI18n();
  if (statuses.length === 0) return null;

  const loading = statuses.filter((status) => status.state === 'loading');
  const errored = statuses.filter((status) => status.state === 'error');
  const reloadable = statuses.filter((status) => status.reloadable);
  const erroredReloadable = errored.filter((status) => status.reloadable);
  const reloadTargets = erroredReloadable.length > 0 ? erroredReloadable : reloadable;
  const busy = loading.length > 0 || errored.length > 0;

  const reloadTargetsLabel = reloadTargets.map((status) => t(status.label)).join(', ');
  const reloadLabel = reloadTargets.length > 0
    ? t('Recharger : {{list}}', { list: reloadTargetsLabel })
    : t('Recharger');
  const handleReload = () => {
    for (const status of reloadTargets) onReload?.(status.id);
  };

  const containerStyle: CSSProperties = {
    ...dockStyle,
    ...(left == null ? { right } : { left }),
    ...(top == null ? { bottom } : { top }),
    alignItems: align === 'center' ? 'center' : 'flex-end',
    transform,
    opacity: hidden ? 0 : 1,
    pointerEvents: hidden ? 'none' : 'auto',
  };

  if (!busy) {
    if (reloadable.length === 0) return null;
    return (
      <div style={containerStyle}>
        <button
          type="button"
          aria-label={reloadLabel}
          title={reloadLabel}
          onClick={handleReload}
          style={compactButtonStyle}
        >
          <RefreshIcon />
        </button>
      </div>
    );
  }

  const progress = loading.length > 0
    ? Math.round(loading.reduce((sum, status) => sum + status.progress, 0) / loading.length)
    : 100;
  const hasError = errored.length > 0;
  const accentColor = hasError ? 'light-dark(#c4320a, rgba(255, 140, 92, 0.92))' : 'rgb(var(--rv-ink) / 0.82)';
  const reloadDisabled = reloadTargets.length === 0
    || reloadTargets.every((status) => status.state === 'loading');
  const tooltip = [
    loading.length > 0 ? t('Chargement : {{list}}', { list: loading.map((s) => t(s.label)).join(', ') }) : null,
    hasError ? t('Erreur : {{list}}', { list: errored.map((s) => (s.detail ? `${t(s.label)} (${t(s.detail)})` : t(s.label))).join(', ') }) : null,
  ].filter(Boolean).join('\n');

  return (
    <div style={containerStyle}>
      <div
        role="status"
        aria-live="polite"
        title={tooltip}
        style={{
          ...pillStyle,
          borderColor: hasError ? 'rgba(255, 140, 92, 0.22)' : 'rgb(var(--rv-ink) / 0.08)',
        }}
      >
        <div style={trackShellStyle}>
          <div
            style={{
              ...trackFillStyle,
              width: `${progress <= 0 ? 0 : Math.max(8, progress)}%`,
              background: hasError
                ? 'linear-gradient(90deg, rgba(255,140,92,0.96), rgba(255,190,135,0.9))'
                : 'rgb(var(--rv-ink) / 0.8)',
            }}
          />
        </div>

        <div style={{ ...percentStyle, color: accentColor }}>
          {loading.length > 0 ? `${progress}%` : 'Err'}
        </div>

        {reloadTargets.length > 0 ? (
          <button
            type="button"
            aria-label={reloadLabel}
            title={reloadLabel}
            disabled={reloadDisabled}
            onClick={handleReload}
            style={{
              ...iconButtonStyle,
              opacity: reloadDisabled ? 0.5 : 0.92,
              cursor: reloadDisabled ? 'default' : 'pointer',
            }}
          >
            <span
              style={{
                display: 'inline-flex',
                animation: loading.length > 0 ? 'spin 1.15s linear infinite' : undefined,
              }}
            >
              <RefreshIcon />
            </span>
          </button>
        ) : null}
      </div>
    </div>
  );
}

function RefreshIcon() {
  return (
    <AssetIcon src="/icons/ui/refresh-cw-05.svg" size={18} />
  );
}

const dockStyle: CSSProperties = {
  position: 'absolute',
  zIndex: 31,
  display: 'flex',
  flexDirection: 'column',
  alignItems: 'flex-end',
  gap: 8,
  transition: 'opacity 220ms ease, right 220ms ease, top 220ms ease, bottom 220ms ease',
};

const glassBase: CSSProperties = {
  background: 'light-dark(rgba(255, 255, 255, 0.86), rgba(15, 15, 15, 0.74))',
  boxShadow: 'var(--rv-float-shadow)',
  backdropFilter: 'blur(24px)',
  WebkitBackdropFilter: 'blur(24px)',
};

const pillStyle: CSSProperties = {
  ...glassBase,
  minWidth: 148,
  height: 36,
  borderRadius: 8,
  padding: 8,
  display: 'flex',
  alignItems: 'center',
  gap: 8,
  color: 'rgb(var(--rv-ink) / 0.92)',
  fontFamily: 'var(--rv-font-sans)',
};

const trackShellStyle: CSSProperties = {
  flex: '1 1 auto',
  minWidth: 56,
  height: 18,
  borderRadius: 8,
  padding: 1,
  background: 'rgb(var(--rv-ink) / 0.16)',
  overflow: 'hidden',
};

const trackFillStyle: CSSProperties = {
  height: '100%',
  borderRadius: 8,
  transition: 'width 180ms ease',
};

const percentStyle: CSSProperties = {
  fontSize: 'var(--rv-font-size-md)',
  lineHeight: 1,
  minWidth: 28,
  textAlign: 'right',
  letterSpacing: '-0.01em',
};

const iconButtonStyle: CSSProperties = {
  width: 20,
  height: 20,
  border: 'none',
  background: 'transparent',
  color: 'rgb(var(--rv-ink) / 0.88)',
  padding: 0,
  display: 'inline-flex',
  alignItems: 'center',
  justifyContent: 'center',
};

const compactButtonStyle: CSSProperties = {
  ...glassBase,
  width: 36,
  height: 36,
  border: 'none',
  borderRadius: 8,
  color: 'rgb(var(--rv-ink) / 0.88)',
  padding: 0,
  display: 'inline-flex',
  alignItems: 'center',
  justifyContent: 'center',
  cursor: 'pointer',
};