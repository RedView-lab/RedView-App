import { useState, useCallback } from 'react';
import type { TileCoord } from '../types/geometry';
import type { PickingState } from '../hooks/useLidarPicking';
import { buildTileFileName } from '../processing/coord-transform';

interface LidarPanelProps {
  picking: PickingState;
  onView: (coord: TileCoord) => void;
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(0)} KB`;
  if (bytes < 1024 ** 3) return `${(bytes / 1024 ** 2).toFixed(1)} MB`;
  return `${(bytes / 1024 ** 3).toFixed(2)} GB`;
}

function phaseLabel(phase: string, downloaded: number, total: number): string {
  switch (phase) {
    case 'cached': return 'Chargement depuis le cache local...';
    case 'downloading': {
      if (total > 0) return `Téléchargement ${formatBytes(downloaded)} / ${formatBytes(total)}`;
      return 'Téléchargement...';
    }
    case 'parsing': return 'Décompression LAZ...';
    case 'colorizing': return 'Colorisation orthophoto...';
    case 'computing-normals': return 'Calcul des normales...';
    case 'rendering': return 'Préparation du rendu...';
    default: return phase;
  }
}

export function LidarPanel({ picking, onView }: LidarPanelProps) {
  const [open, setOpen] = useState(true);

  const handleToggle = useCallback(() => setOpen(o => !o), []);

  const isDownloading = !!picking.downloading;

  return (
    <div style={panelStyle}>
      {/* Header */}
      <button onClick={handleToggle} style={headerStyle}>
        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="#ef4444" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
          <path d="M21 10c0 7-9 13-9 13s-9-6-9-13a9 9 0 0 1 18 0z" />
          <circle cx="12" cy="10" r="3" />
        </svg>
        <span style={headerTitleStyle}>LIDAR HD</span>
        <svg
          width="10" height="10" viewBox="0 0 10 10" fill="none"
          stroke="rgba(255,255,255,0.4)" strokeWidth="1.5" strokeLinecap="round"
          style={{ marginLeft: 'auto', transform: open ? 'rotate(180deg)' : 'none', transition: 'transform 0.2s' }}
        >
          <path d="M2 3.5L5 6.5L8 3.5" />
        </svg>
      </button>

      {open && (
        <div style={bodyStyle}>
          {/* Download button */}
          <button
            onClick={picking.isPicking ? picking.stopPicking : picking.startPicking}
            disabled={isDownloading}
            style={{
              ...downloadBtnStyle,
              opacity: isDownloading ? 0.5 : 1,
              background: picking.isPicking ? '#a30000' : '#890000',
            }}
          >
            {isDownloading
              ? 'Téléchargement...'
              : picking.isPicking
                ? 'Annuler la sélection'
                : 'Télécharger une tuile LIDAR'}
          </button>

          {/* Download progress */}
          {isDownloading && picking.progress && (
            <div style={progressSection}>
              <div style={progressBarBg}>
                <div
                  style={{
                    ...progressBarFill,
                    width: picking.progress.totalBytes > 0
                      ? `${Math.max(2, (picking.progress.bytesDownloaded / picking.progress.totalBytes) * 100)}%`
                      : '100%',
                    animation: picking.progress.totalBytes === 0 ? 'lidar-indeterminate 1.5s ease-in-out infinite' : undefined,
                  }}
                />
              </div>
              <div style={progressLabelStyle}>
                {phaseLabel(picking.progress.phase, picking.progress.bytesDownloaded, picking.progress.totalBytes)}
              </div>
            </div>
          )}

          {/* Cached tiles list */}
          {picking.cachedTiles.length > 0 && (
            <div style={listSection}>
              <div style={listHeaderStyle}>
                Tuiles en cache ({picking.cachedTiles.length})
              </div>
              {picking.cachedTiles.map((tile) => {
                const key = `${tile.coord.xKm}_${tile.coord.yKm}`;
                return (
                  <div key={key} style={tileRowStyle}>
                    <div style={tileNameStyle}>
                      {buildTileFileName(tile.coord)}
                    </div>
                    <div style={tileSizeStyle}>{formatBytes(tile.sizeBytes)}</div>
                    <div style={tileActionsStyle}>
                      {/* View button */}
                      <button
                        onClick={() => onView(tile.coord)}
                        style={iconBtnStyle}
                        title="Visualiser"
                      >
                        <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round">
                          <path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z" />
                          <circle cx="12" cy="12" r="3" />
                        </svg>
                      </button>
                      {/* Delete button */}
                      <button
                        onClick={() => picking.deleteTile(tile.coord)}
                        style={iconBtnStyle}
                        title="Supprimer"
                      >
                        <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round">
                          <polyline points="3 6 5 6 21 6" />
                          <path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2" />
                        </svg>
                      </button>
                    </div>
                  </div>
                );
              })}
            </div>
          )}
        </div>
      )}
    </div>
  );
}

/* ---- Styles ---- */

const panelStyle: React.CSSProperties = {
  position: 'absolute',
  bottom: 16,
  left: 16,
  zIndex: 30,
  width: 260,
  background: 'rgba(30, 30, 34, 0.65)',
  backdropFilter: 'blur(16px)',
  WebkitBackdropFilter: 'blur(16px)',
  border: '1px solid rgba(255, 255, 255, 0.08)',
  borderRadius: 12,
  overflow: 'hidden',
  fontFamily: 'system-ui, -apple-system, sans-serif',
  color: 'rgba(255, 255, 255, 0.85)',
};

const headerStyle: React.CSSProperties = {
  display: 'flex',
  alignItems: 'center',
  gap: 8,
  width: '100%',
  padding: '10px 14px',
  background: 'transparent',
  border: 'none',
  cursor: 'pointer',
  color: 'inherit',
  fontFamily: 'inherit',
};

const headerTitleStyle: React.CSSProperties = {
  fontSize: 11,
  fontWeight: 600,
  letterSpacing: '0.06em',
  textTransform: 'uppercase' as const,
  color: 'rgba(255, 255, 255, 0.7)',
};

const bodyStyle: React.CSSProperties = {
  padding: '0 14px 14px',
  display: 'flex',
  flexDirection: 'column',
  gap: 10,
};

const downloadBtnStyle: React.CSSProperties = {
  width: '100%',
  padding: '8px 0',
  border: 'none',
  borderRadius: 6,
  fontSize: 11,
  fontWeight: 600,
  color: '#fff',
  cursor: 'pointer',
  letterSpacing: '0.01em',
  transition: 'background 0.15s',
};

const progressSection: React.CSSProperties = {
  display: 'flex',
  flexDirection: 'column',
  gap: 4,
};

const progressBarBg: React.CSSProperties = {
  width: '100%',
  height: 3,
  background: '#333',
  borderRadius: 2,
  overflow: 'hidden',
};

const progressBarFill: React.CSSProperties = {
  height: '100%',
  background: '#b91c1c',
  borderRadius: 2,
  transition: 'width 0.3s',
};

const progressLabelStyle: React.CSSProperties = {
  fontSize: 10,
  color: 'rgba(255, 255, 255, 0.45)',
  lineHeight: 1.3,
};

const listSection: React.CSSProperties = {
  display: 'flex',
  flexDirection: 'column',
  gap: 2,
  marginTop: 2,
};

const listHeaderStyle: React.CSSProperties = {
  fontSize: 10,
  fontWeight: 600,
  color: 'rgba(255, 255, 255, 0.35)',
  textTransform: 'uppercase' as const,
  letterSpacing: '0.05em',
  marginBottom: 4,
};

const tileRowStyle: React.CSSProperties = {
  display: 'flex',
  alignItems: 'center',
  gap: 6,
  padding: '5px 6px',
  borderRadius: 6,
  background: 'rgba(255, 255, 255, 0.03)',
};

const tileNameStyle: React.CSSProperties = {
  flex: 1,
  fontSize: 10,
  fontFamily: 'ui-monospace, "SF Mono", monospace',
  color: 'rgba(255, 255, 255, 0.6)',
  overflow: 'hidden',
  textOverflow: 'ellipsis',
  whiteSpace: 'nowrap',
};

const tileSizeStyle: React.CSSProperties = {
  fontSize: 9,
  color: 'rgba(255, 255, 255, 0.3)',
  whiteSpace: 'nowrap',
};

const tileActionsStyle: React.CSSProperties = {
  display: 'flex',
  gap: 2,
};

const iconBtnStyle: React.CSSProperties = {
  display: 'flex',
  alignItems: 'center',
  justifyContent: 'center',
  width: 24,
  height: 24,
  padding: 0,
  background: 'transparent',
  border: 'none',
  borderRadius: 4,
  color: 'rgba(255, 255, 255, 0.4)',
  cursor: 'pointer',
};
