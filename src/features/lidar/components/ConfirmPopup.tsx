import { createPortal } from 'react-dom';
import type { TileCoord } from '../types/geometry';
import { buildTileFileName } from '../processing/coord-transform';

interface ConfirmPopupProps {
  coord: TileCoord | null;
  screenPos: { x: number; y: number } | null;
  onConfirm: () => void;
  onCancel: () => void;
}

export function ConfirmPopup({ coord, screenPos, onConfirm, onCancel }: ConfirmPopupProps) {
  if (!coord || !screenPos) return null;

  const fileName = buildTileFileName(coord);

  // Position popup near click but keep on-screen
  const popupX = Math.min(screenPos.x + 12, window.innerWidth - 280);
  const popupY = Math.min(screenPos.y - 60, window.innerHeight - 160);

  return createPortal(
    <div style={{ ...popupStyle, left: Math.max(8, popupX), top: Math.max(8, popupY) }}>
      <div style={filenameStyle}>{fileName}</div>
      <div style={coordsStyle}>
        X: {coord.xKm} km &nbsp;·&nbsp; Y: {coord.yKm} km &nbsp;·&nbsp; {coord.projection}
      </div>
      <div style={actionsStyle}>
        <button onClick={onCancel} style={cancelBtnStyle}>
          Annuler
        </button>
        <button onClick={onConfirm} style={confirmBtnStyle}>
          Confirmer
        </button>
      </div>
    </div>,
    document.body,
  );
}

const popupStyle: React.CSSProperties = {
  position: 'fixed',
  zIndex: 10000,
  width: 260,
  padding: '14px 16px',
  background: 'rgba(20, 20, 24, 0.92)',
  backdropFilter: 'blur(16px)',
  border: '1px solid rgba(255, 255, 255, 0.08)',
  borderRadius: 10,
  boxShadow: '0 8px 32px rgba(0, 0, 0, 0.5)',
  fontFamily: 'system-ui, -apple-system, sans-serif',
  color: 'rgba(255, 255, 255, 0.85)',
};

const filenameStyle: React.CSSProperties = {
  fontFamily: 'ui-monospace, "SF Mono", "Cascadia Mono", monospace',
  fontSize: 10,
  color: 'rgba(255, 255, 255, 0.5)',
  wordBreak: 'break-all',
  lineHeight: 1.4,
};

const coordsStyle: React.CSSProperties = {
  marginTop: 8,
  fontSize: 12,
  color: 'rgba(255, 255, 255, 0.7)',
};

const actionsStyle: React.CSSProperties = {
  display: 'flex',
  gap: 8,
  marginTop: 14,
};

const baseBtnStyle: React.CSSProperties = {
  flex: 1,
  padding: '7px 0',
  borderRadius: 6,
  border: 'none',
  fontSize: 11,
  fontWeight: 600,
  cursor: 'pointer',
  letterSpacing: '0.02em',
};

const cancelBtnStyle: React.CSSProperties = {
  ...baseBtnStyle,
  background: 'rgba(255, 255, 255, 0.08)',
  color: 'rgba(255, 255, 255, 0.6)',
};

const confirmBtnStyle: React.CSSProperties = {
  ...baseBtnStyle,
  background: '#890000',
  color: '#fff',
};
