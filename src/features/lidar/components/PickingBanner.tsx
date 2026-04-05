import { createPortal } from 'react-dom';

interface PickingBannerProps {
  active: boolean;
}

export function PickingBanner({ active }: PickingBannerProps) {
  if (!active) return null;

  return createPortal(
    <div style={bannerStyle}>
      <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="#ef4444" strokeWidth="2" strokeLinecap="round">
        <circle cx="12" cy="12" r="10" />
        <line x1="12" y1="8" x2="12" y2="16" />
        <line x1="8" y1="12" x2="16" y2="12" />
      </svg>
      <span>Cliquez sur la carte pour sélectionner une zone 1km × 1km</span>
    </div>,
    document.body,
  );
}

const bannerStyle: React.CSSProperties = {
  position: 'fixed',
  top: 0,
  left: 0,
  right: 0,
  zIndex: 9999,
  display: 'flex',
  alignItems: 'center',
  justifyContent: 'center',
  gap: 8,
  padding: '10px 16px',
  background: 'rgba(15, 15, 20, 0.85)',
  backdropFilter: 'blur(12px)',
  borderBottom: '1px solid rgba(239, 68, 68, 0.3)',
  color: 'rgba(255, 255, 255, 0.85)',
  fontFamily: 'system-ui, -apple-system, sans-serif',
  fontSize: 13,
  fontWeight: 500,
  letterSpacing: '0.01em',
};
