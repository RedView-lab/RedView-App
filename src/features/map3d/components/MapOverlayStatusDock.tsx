import type { CSSProperties } from 'react';
import { AssetIcon } from '@/shared/components/AssetIcon';

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
  if (statuses.length === 0) return null;

  return (
    <div
      style={{
        ...dockStyle,
        ...(left == null ? { right } : { left }),
        ...(top == null ? { bottom } : { top }),
        alignItems: align === 'center' ? 'center' : 'flex-end',
        transform,
        opacity: hidden ? 0 : 1,
        pointerEvents: hidden ? 'none' : 'auto',
      }}
    >
      {statuses.map((status) => {
          const compact = status.state === 'ready';
        const reloadDisabled = status.state === 'loading' || !status.reloadable;
        const showReload = status.id === 'shadow' || status.reloadable;
        const tooltip = [status.label, status.detail].filter(Boolean).join(' - ');

        if (compact) {
          return (
            <button
              key={status.id}
              type="button"
              aria-label={`Recharger ${status.label}`}
              title={tooltip || status.label}
              onClick={() => onReload?.(status.id)}
              style={compactButtonStyle}
            >
              <RefreshIcon />
            </button>
          );
        }

        const accentColor = status.state === 'error' ? 'rgba(255, 140, 92, 0.92)' : 'rgba(255, 255, 255, 0.82)';

        return (
          <div
            key={status.id}
            role="status"
            aria-live="polite"
            title={tooltip || status.label}
            style={{
              ...pillStyle,
              borderColor: status.state === 'error' ? 'rgba(255, 140, 92, 0.22)' : 'rgba(255,255,255,0.08)',
            }}
          >
            <div style={trackShellStyle}>
              <div
                style={{
                  ...trackFillStyle,
                  width: `${status.progress <= 0 ? 0 : Math.max(8, status.progress)}%`,
                  background: status.state === 'error'
                    ? 'linear-gradient(90deg, rgba(255,140,92,0.96), rgba(255,190,135,0.9))'
                    : 'rgba(255,255,255,0.8)',
                }}
              />
            </div>

            <div style={{ ...percentStyle, color: accentColor }}>
              {status.state === 'error' ? 'Err' : `${status.progress}%`}
            </div>

            {showReload ? (
              <button
                type="button"
                aria-label={`Recharger ${status.label}`}
                title={tooltip || status.label}
                disabled={reloadDisabled}
                onClick={() => onReload?.(status.id)}
                style={{
                  ...iconButtonStyle,
                  opacity: reloadDisabled ? 0.5 : 0.92,
                  cursor: reloadDisabled ? 'default' : 'pointer',
                }}
              >
                <span
                  style={{
                    display: 'inline-flex',
                    animation: status.state === 'loading' ? 'spin 1.15s linear infinite' : undefined,
                  }}
                >
                  <RefreshIcon />
                </span>
              </button>
            ) : null}
          </div>
        );
      })}
    </div>
  );
}

function RefreshIcon() {
  return (
    <AssetIcon src="/svgv2/icone/refresh-cw-05.svg" size={18} />
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
  background: 'rgba(15,15,15,0.74)',
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
  color: 'rgba(255,255,255,0.92)',
  fontFamily: '"Rethink Sans", "Segoe UI", sans-serif',
};

const trackShellStyle: CSSProperties = {
  flex: '1 1 auto',
  minWidth: 56,
  height: 18,
  borderRadius: 8,
  padding: 1,
  background: 'rgba(255,255,255,0.32)',
  overflow: 'hidden',
};

const trackFillStyle: CSSProperties = {
  height: '100%',
  borderRadius: 8,
  transition: 'width 180ms ease',
};

const percentStyle: CSSProperties = {
  fontSize: 13,
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
  color: 'rgba(255,255,255,0.88)',
  padding: 0,
  display: 'inline-flex',
  alignItems: 'center',
  justifyContent: 'center',
};

const compactButtonStyle: CSSProperties = {
  ...glassBase,
  width: 36,
  height: 36,
  borderRadius: 8,
  color: 'rgba(255,255,255,0.88)',
  padding: 0,
  display: 'inline-flex',
  alignItems: 'center',
  justifyContent: 'center',
  cursor: 'pointer',
};