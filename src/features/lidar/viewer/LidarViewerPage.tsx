import { useRef, useMemo } from 'react';
import type { TileCoord } from '../types/geometry';
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

  return (
    <div style={containerStyle}>
      <canvas ref={canvasRef} style={canvasStyle} />

      {isLoading && (
        <div style={overlayStyle}>
          <div style={progressBarBg}>
            <div style={{ ...progressBarFill, width: `${Math.max(2, progress)}%` }} />
          </div>
          <span style={statusText}>{status} {progress > 0 ? `${progress.toFixed(0)}%` : ''}</span>
        </div>
      )}

      {status.startsWith('error') && (
        <div style={{ ...overlayStyle, color: '#ff6060' }}>
          {status}
        </div>
      )}

      <div style={infoBarStyle}>
        {tileCoord && (
          <span>Tile {tileCoord.xKm}_{tileCoord.yKm} ({tileCoord.territory})</span>
        )}
        <span style={{ marginLeft: 'auto', opacity: 0.5 }}>
          {formatBytes(quota.used)} / {formatBytes(quota.quota)}
        </span>
      </div>
    </div>
  );
}

const containerStyle: React.CSSProperties = {
  position: 'fixed',
  inset: 0,
  background: '#0d0d12',
  display: 'flex',
  flexDirection: 'column',
};

const canvasStyle: React.CSSProperties = {
  flex: 1,
  width: '100%',
  display: 'block',
};

const overlayStyle: React.CSSProperties = {
  position: 'absolute',
  top: '50%',
  left: '50%',
  transform: 'translate(-50%, -50%)',
  display: 'flex',
  flexDirection: 'column',
  alignItems: 'center',
  gap: 8,
  color: '#ccc',
  fontFamily: 'system-ui, sans-serif',
  fontSize: 13,
};

const progressBarBg: React.CSSProperties = {
  width: 200,
  height: 3,
  background: 'rgba(255,255,255,0.1)',
  borderRadius: 2,
};

const progressBarFill: React.CSSProperties = {
  height: '100%',
  background: '#6496ff',
  borderRadius: 2,
  transition: 'width 0.3s',
};

const statusText: React.CSSProperties = {
  opacity: 0.6,
  textTransform: 'capitalize',
};

const infoBarStyle: React.CSSProperties = {
  display: 'flex',
  padding: '6px 12px',
  fontSize: 11,
  color: '#888',
  fontFamily: 'system-ui, sans-serif',
  background: '#111118',
  borderTop: '1px solid #222',
};
