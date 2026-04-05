import { useRef, useMemo, useState, useEffect } from 'react';
import type { TileCoord } from '../types/geometry';
import { buildTileFileName } from '../processing/coord-transform';
import { useLidarViewer } from '../hooks/useLidarViewer';
import { useStorageQuota } from '../hooks/useStorageQuota';

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(0)} KB`;
  if (bytes < 1024 * 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
  return `${(bytes / (1024 * 1024 * 1024)).toFixed(2)} GB`;
}

export default function LidarViewerPage() {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const params = new URLSearchParams(window.location.search);
  const [overlayHidden, setOverlayHidden] = useState(false);

  const tileCoord = useMemo<TileCoord | null>(() => {
    const x = params.get('x');
    const y = params.get('y');
    const t = params.get('t') ?? 'FXX';
    if (!x || !y) return null;
    return {
      xKm: parseInt(x, 10),
      yKm: parseInt(y, 10),
      territory: t as TileCoord['territory'],
      projection: t === 'REU' ? 'RGR92UTM40S' : 'LAMB93',
      altRef: t === 'REU' ? 'REUN89' : 'IGN69',
    };
  }, []);

  const { status, progress } = useLidarViewer(canvasRef, tileCoord);
  const quota = useStorageQuota();

  const isLoading = status !== 'ready' && status !== 'idle' && !status.startsWith('error');
  const isError = status.startsWith('error');
  const tileName = tileCoord ? buildTileFileName(tileCoord) : '';

  // Fade out overlay when rendering is ready
  useEffect(() => {
    if (status === 'ready') {
      const t = setTimeout(() => setOverlayHidden(true), 600);
      return () => clearTimeout(t);
    }
    setOverlayHidden(false);
  }, [status]);

  return (
    <div style={containerStyle}>
      <canvas ref={canvasRef} style={canvasStyle} />

      {/* Loading overlay */}
      {!overlayHidden && (isLoading || isError) && (
        <div style={{
          ...overlayStyle,
          opacity: status === 'ready' ? 0 : 1,
        }}>
          <div style={loaderStyle}>
            <h1 style={titleStyle}>LiDAR HD Viewer</h1>
            {isError ? (
              <p style={{ ...statusTextStyle, color: '#ef4444' }}>{status}</p>
            ) : (
              <>
                <p style={statusTextStyle}>{status}</p>
                <div style={barBgStyle}>
                  <div style={{ ...barFillStyle, width: `${Math.max(2, progress)}%` }} />
                </div>
              </>
            )}
          </div>
        </div>
      )}

      {/* Controls hint */}
      <div style={controlsHintStyle}>
        🖱️ Clic gauche : orbiter · Clic droit : déplacer · Molette : zoom
      </div>

      {/* Bottom info bar */}
      <div style={infoBarStyle}>
        {tileCoord && <span>{tileName}</span>}
        <span style={{ marginLeft: 'auto', opacity: 0.5 }}>
          {formatBytes(quota.used)} / {formatBytes(quota.quota)}
        </span>
      </div>

      {/* Watermark */}
      <div style={watermarkStyle}>
        <span style={{ color: '#ef4444', fontWeight: 700, fontSize: '1.8rem' }}>red</span>
        <span style={{ color: '#f1f1f1', fontWeight: 700, fontSize: '1.8rem' }}>view</span>
      </div>
    </div>
  );
}

/* ---- Styles ---- */

const containerStyle: React.CSSProperties = {
  position: 'fixed',
  inset: 0,
  background: '#111',
  overflow: 'hidden',
};

const canvasStyle: React.CSSProperties = {
  display: 'block',
  width: '100%',
  height: '100%',
};

const overlayStyle: React.CSSProperties = {
  position: 'absolute',
  top: 0,
  left: 0,
  width: '100%',
  height: '100%',
  display: 'flex',
  alignItems: 'center',
  justifyContent: 'center',
  background: '#111',
  zIndex: 10,
  transition: 'opacity 0.5s',
};

const loaderStyle: React.CSSProperties = {
  textAlign: 'center',
};

const titleStyle: React.CSSProperties = {
  fontSize: '1.5rem',
  marginBottom: 12,
  fontWeight: 600,
  color: '#eee',
};

const statusTextStyle: React.CSSProperties = {
  fontSize: '0.85rem',
  color: '#888',
  marginBottom: 8,
  textTransform: 'capitalize',
};

const barBgStyle: React.CSSProperties = {
  width: 300,
  height: 6,
  background: '#333',
  borderRadius: 3,
  overflow: 'hidden',
  margin: '0 auto',
};

const barFillStyle: React.CSSProperties = {
  height: '100%',
  background: '#ef4444',
  transition: 'width 0.2s',
};

const controlsHintStyle: React.CSSProperties = {
  position: 'absolute',
  bottom: 12,
  left: 12,
  zIndex: 5,
  background: 'rgba(0,0,0,0.7)',
  padding: '8px 14px',
  borderRadius: 6,
  fontSize: 11,
  color: '#888',
};

const infoBarStyle: React.CSSProperties = {
  position: 'absolute',
  top: 12,
  left: 12,
  zIndex: 5,
  display: 'flex',
  gap: 16,
  background: 'rgba(0,0,0,0.7)',
  padding: '8px 14px',
  borderRadius: 6,
  fontSize: 12,
  color: '#ccc',
  fontFamily: 'ui-monospace, "SF Mono", monospace',
};

const watermarkStyle: React.CSSProperties = {
  position: 'absolute',
  bottom: 12,
  right: 16,
  zIndex: 5,
  pointerEvents: 'none',
  userSelect: 'none',
};
