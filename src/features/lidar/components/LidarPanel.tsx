import { useLidar } from './useLidar';

export function LidarPanel({ onFlyTo }: { onFlyTo?: (lon: number, lat: number) => void }) {
  const {
    cachedTiles,
    storageUsed,
    storageQuota,
    progress,
    error,
    removeTile,
    openViewer,
    getTileCenter,
  } = useLidar();

  const formatSize = (bytes: number): string => {
    if (bytes < 1024) return `${bytes} B`;
    if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
    if (bytes < 1024 * 1024 * 1024) return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
    return `${(bytes / 1024 / 1024 / 1024).toFixed(2)} GB`;
  };

  return (
    <div style={panelStyle}>
      <h2 style={titleStyle}>🛰️ LiDAR HD IGN</h2>

      {/* Error */}
      {error && (
        <div style={errorStyle}>❌ {error}</div>
      )}

      {/* Progress */}
      {progress && (
        <div style={cardStyle}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 6 }}>
            <span style={spinnerStyle}>⏳</span>
            <span style={{ fontSize: 12, color: '#ccc' }}>
              {progress.phase === 'downloading' ? '📥 Téléchargement' : progress.phase}
            </span>
          </div>
          {progress.message && (
            <p style={{ fontSize: 10, color: '#888', marginBottom: 4 }}>{progress.message}</p>
          )}
          {progress.totalBytes > 0 && progress.phase === 'downloading' && (
            <div style={barBgStyle}>
              <div
                style={{
                  ...barFillStyle,
                  width: `${Math.min(100, (progress.bytesDownloaded / progress.totalBytes) * 100)}%`,
                }}
              />
            </div>
          )}
        </div>
      )}

      {/* Cached tiles */}
      {cachedTiles.length > 0 && (
        <div>
          <h3 style={sectionTitle}>
            Tuiles en cache ({cachedTiles.length})
          </h3>
          <div style={{ maxHeight: 200, overflowY: 'auto', display: 'flex', flexDirection: 'column', gap: 4 }}>
            {cachedTiles.map((tile) => {
              const key = `${tile.coord.xKm}_${tile.coord.yKm}`;
              const [lon, lat] = getTileCenter(tile.coord);
              return (
                <div key={key} style={tileRowStyle}>
                  <div
                    style={{ flex: 1, minWidth: 0, cursor: 'pointer' }}
                    onClick={() => onFlyTo?.(lon, lat)}
                    title="Aller à cette tuile"
                  >
                    <div style={{ fontSize: 12, color: '#ddd', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                      📍 {tile.fileName}
                    </div>
                    <div style={{ fontSize: 10, color: '#888' }}>
                      {formatSize(tile.sizeBytes)} · {lat.toFixed(4)}°N {lon.toFixed(4)}°E
                    </div>
                  </div>
                  <div style={{ display: 'flex', gap: 4, marginLeft: 8, flexShrink: 0 }}>
                    <button
                      onClick={() => openViewer(tile.coord)}
                      style={iconBtnStyle}
                      title="Visualiser en 3D (nouvel onglet)"
                    >
                      👁️
                    </button>
                    <button
                      onClick={() => removeTile(tile.coord)}
                      style={iconBtnStyle}
                      title="Supprimer du cache"
                    >
                      🗑️
                    </button>
                  </div>
                </div>
              );
            })}
          </div>
        </div>
      )}

      {/* Storage */}
      <div style={cardStyle}>
        <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: 10, color: '#888', marginBottom: 4 }}>
          <span>💾 Stockage OPFS</span>
          <span>{formatSize(storageUsed)} / {formatSize(storageQuota)}</span>
        </div>
        {storageQuota > 0 && (
          <div style={barBgStyle}>
            <div
              style={{
                ...barFillStyle,
                width: `${Math.min(100, (storageUsed / storageQuota) * 100)}%`,
              }}
            />
          </div>
        )}
      </div>

      {/* Info */}
      <div style={{ ...cardStyle, borderColor: '#444' }}>
        <p style={{ fontSize: 10, color: '#e97878', fontWeight: 600, marginBottom: 4 }}>
          ℹ️ LiDAR HD IGN
        </p>
        <p style={{ fontSize: 10, color: '#999', lineHeight: 1.5 }}>
          Clic droit sur la carte → "Charger LiDAR HD" pour télécharger et visualiser les données LiDAR haute définition (10-50 pts/m²) de l'IGN dans un viewer WebGPU dédié.
        </p>
      </div>
    </div>
  );
}

// --- Inline styles (matches the dark theme of RedView-App) ---

const panelStyle: React.CSSProperties = {
  padding: 16,
  display: 'flex',
  flexDirection: 'column',
  gap: 12,
  fontFamily: 'system-ui, sans-serif',
};

const titleStyle: React.CSSProperties = {
  fontSize: 13,
  fontWeight: 600,
  color: '#ccc',
  letterSpacing: '0.05em',
  textTransform: 'uppercase',
  margin: 0,
};

const sectionTitle: React.CSSProperties = {
  fontSize: 10,
  color: '#888',
  textTransform: 'uppercase',
  letterSpacing: '0.08em',
  marginBottom: 6,
  fontWeight: 500,
};

const cardStyle: React.CSSProperties = {
  padding: 10,
  background: '#222',
  borderRadius: 6,
  border: '1px solid #333',
};

const errorStyle: React.CSSProperties = {
  padding: 8,
  background: 'rgba(220,38,38,0.15)',
  borderRadius: 6,
  border: '1px solid rgba(220,38,38,0.3)',
  fontSize: 11,
  color: '#f87171',
};

const tileRowStyle: React.CSSProperties = {
  display: 'flex',
  alignItems: 'center',
  justifyContent: 'space-between',
  padding: '6px 8px',
  background: '#252525',
  borderRadius: 4,
};

const iconBtnStyle: React.CSSProperties = {
  background: 'transparent',
  border: 'none',
  cursor: 'pointer',
  fontSize: 14,
  padding: 4,
  borderRadius: 4,
  lineHeight: 1,
};

const barBgStyle: React.CSSProperties = {
  width: '100%',
  height: 4,
  background: '#333',
  borderRadius: 2,
  overflow: 'hidden',
};

const barFillStyle: React.CSSProperties = {
  height: '100%',
  background: 'linear-gradient(90deg, #3b82f6, #06b6d4)',
  borderRadius: 2,
  transition: 'width 0.3s',
};

const spinnerStyle: React.CSSProperties = {
  animation: 'spin 1s linear infinite',
  display: 'inline-block',
  fontSize: 14,
};
