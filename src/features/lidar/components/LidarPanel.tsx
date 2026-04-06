import { useLidar } from './useLidar';

interface LidarPanelProps {
  modeActive: boolean;
  detailsOpen: boolean;
  onToggleMode: () => void;
  onToggleDetails: () => void;
  onFlyTo?: (lon: number, lat: number) => void;
}

export function LidarPanel({
  modeActive,
  detailsOpen,
  onToggleMode,
  onToggleDetails,
  onFlyTo,
}: LidarPanelProps) {
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

  const isPanelVisible = detailsOpen || Boolean(progress) || Boolean(error);
  const usagePercent = storageQuota > 0 ? Math.min(100, (storageUsed / storageQuota) * 100) : 0;
  const progressPercent = progress?.totalBytes
    ? Math.min(100, (progress.bytesDownloaded / progress.totalBytes) * 100)
    : 0;

  return (
    <div style={dockStyle}>
      <div style={toolbarStyle}>
        <button onClick={onToggleMode} style={{ ...modeButtonStyle, ...(modeActive ? modeButtonActiveStyle : null) }}>
          {modeActive ? 'LiDAR on' : 'LiDAR'}
        </button>
        <button onClick={onToggleDetails} style={secondaryButtonStyle}>
          {detailsOpen ? 'Masquer' : `Infos ${cachedTiles.length}`}
        </button>
        {progress && (
          <div style={statusChipStyle}>
            {progress.phase === 'downloading' ? 'Download' : progress.phase}
          </div>
        )}
        {error && <div style={errorChipStyle}>Erreur</div>}
      </div>

      {isPanelVisible && (
        <div style={panelStyle}>
          <div style={summaryRowStyle}>
            <div style={summaryCardStyle}>
              <span style={summaryLabelStyle}>Mode</span>
              <strong style={summaryValueStyle}>{modeActive ? 'Selection active' : 'Activer pour viser une tuile'}</strong>
            </div>
            <div style={summaryCardStyle}>
              <span style={summaryLabelStyle}>Cache</span>
              <strong style={summaryValueStyle}>{cachedTiles.length} tuiles</strong>
            </div>
            <div style={summaryCardStyle}>
              <span style={summaryLabelStyle}>Stockage</span>
              <strong style={summaryValueStyle}>{formatSize(storageUsed)}</strong>
            </div>
          </div>

          {error && <div style={errorStyle}>{error}</div>}

          {progress && (
            <div style={cardStyle}>
              <div style={cardHeaderStyle}>
                <span style={sectionTitle}>Telechargement</span>
                <span style={mutedTextStyle}>{progress.phase}</span>
              </div>
              {progress.message && <p style={messageStyle}>{progress.message}</p>}
              {progress.totalBytes > 0 && progress.phase === 'downloading' && (
                <div style={barBgStyle}>
                  <div style={{ ...barFillStyle, width: `${progressPercent}%` }} />
                </div>
              )}
            </div>
          )}

          <div style={cardStyle}>
            <div style={cardHeaderStyle}>
              <span style={sectionTitle}>Stockage local</span>
              <span style={mutedTextStyle}>{formatSize(storageUsed)} / {formatSize(storageQuota)}</span>
            </div>
            {storageQuota > 0 && (
              <div style={barBgStyle}>
                <div style={{ ...barFillStyle, width: `${usagePercent}%` }} />
              </div>
            )}
          </div>

          <div style={hintStyle}>
            {modeActive
              ? 'Deplace la souris sur la carte puis clique gauche pour telecharger une tuile 1 km.'
              : 'Active LiDAR pour afficher la tuile 1 km sous la souris.'}
          </div>

          {detailsOpen && cachedTiles.length > 0 && (
            <div style={cardStyle}>
              <div style={cardHeaderStyle}>
                <span style={sectionTitle}>Tuiles en cache</span>
                <span style={mutedTextStyle}>{cachedTiles.length}</span>
              </div>
              <div style={tilesListStyle}>
                {cachedTiles.map((tile) => {
                  const key = `${tile.coord.xKm}_${tile.coord.yKm}_${tile.coord.projection}`;
                  const [lon, lat] = getTileCenter(tile.coord);
                  return (
                    <div key={key} style={tileRowStyle}>
                      <button
                        type="button"
                        style={tileMetaButtonStyle}
                        onClick={() => onFlyTo?.(lon, lat)}
                        title="Aller a cette tuile"
                      >
                        <div style={tileNameStyle}>{tile.fileName}</div>
                        <div style={tileMetaStyle}>{formatSize(tile.sizeBytes)} · {lat.toFixed(4)} {lon.toFixed(4)}</div>
                      </button>
                      <div style={tileActionsStyle}>
                        <button
                          type="button"
                          onClick={() => openViewer(tile.coord)}
                          style={iconBtnStyle}
                          title="Ouvrir le viewer 3D"
                        >
                          3D
                        </button>
                        <button
                          type="button"
                          onClick={() => removeTile(tile.coord)}
                          style={iconBtnStyle}
                          title="Supprimer du cache"
                        >
                          Del
                        </button>
                      </div>
                    </div>
                  );
                })}
              </div>
            </div>
          )}
        </div>
      )}
    </div>
  );
}

const dockStyle: React.CSSProperties = {
  display: 'flex',
  flexDirection: 'column',
  gap: 8,
  fontFamily: 'system-ui, sans-serif',
};

const toolbarStyle: React.CSSProperties = {
  display: 'flex',
  alignItems: 'center',
  gap: 6,
  flexWrap: 'wrap',
};

const modeButtonStyle: React.CSSProperties = {
  background: 'rgba(12, 16, 24, 0.8)',
  color: 'rgba(255,255,255,0.92)',
  border: '1px solid rgba(255,255,255,0.12)',
  borderRadius: 999,
  padding: '8px 12px',
  fontSize: 12,
  cursor: 'pointer',
  backdropFilter: 'blur(16px)',
};

const modeButtonActiveStyle: React.CSSProperties = {
  background: 'rgba(177, 34, 34, 0.86)',
  borderColor: 'rgba(255,114,114,0.44)',
};

const secondaryButtonStyle: React.CSSProperties = {
  background: 'rgba(12, 16, 24, 0.62)',
  color: 'rgba(255,255,255,0.78)',
  border: '1px solid rgba(255,255,255,0.1)',
  borderRadius: 999,
  padding: '8px 11px',
  fontSize: 11,
  cursor: 'pointer',
  backdropFilter: 'blur(16px)',
};

const statusChipStyle: React.CSSProperties = {
  padding: '7px 10px',
  borderRadius: 999,
  background: 'rgba(15, 23, 42, 0.78)',
  border: '1px solid rgba(59,130,246,0.24)',
  color: '#d6e6ff',
  fontSize: 11,
};

const errorChipStyle: React.CSSProperties = {
  padding: '7px 10px',
  borderRadius: 999,
  background: 'rgba(78, 14, 14, 0.85)',
  border: '1px solid rgba(248,113,113,0.24)',
  color: '#ffd3d3',
  fontSize: 11,
};

const panelStyle: React.CSSProperties = {
  width: 'min(320px, calc(100vw - 24px))',
  padding: 12,
  display: 'flex',
  flexDirection: 'column',
  gap: 10,
  background: 'rgba(12, 14, 20, 0.84)',
  border: '1px solid rgba(255,255,255,0.1)',
  borderRadius: 16,
  backdropFilter: 'blur(18px)',
  boxShadow: '0 18px 48px rgba(0,0,0,0.36)',
};

const summaryRowStyle: React.CSSProperties = {
  display: 'grid',
  gridTemplateColumns: 'repeat(3, minmax(0, 1fr))',
  gap: 6,
};

const summaryCardStyle: React.CSSProperties = {
  padding: '8px 9px',
  borderRadius: 12,
  background: 'rgba(255,255,255,0.035)',
  border: '1px solid rgba(255,255,255,0.06)',
  display: 'flex',
  flexDirection: 'column',
  gap: 4,
};

const summaryLabelStyle: React.CSSProperties = {
  fontSize: 9,
  textTransform: 'uppercase',
  letterSpacing: '0.08em',
  color: '#8d97a7',
};

const summaryValueStyle: React.CSSProperties = {
  fontSize: 11,
  color: '#f4f7fb',
  fontWeight: 600,
};

const sectionTitle: React.CSSProperties = {
  fontSize: 10,
  color: '#b7c1d4',
  textTransform: 'uppercase',
  letterSpacing: '0.08em',
  fontWeight: 500,
};

const cardStyle: React.CSSProperties = {
  padding: 10,
  background: 'rgba(255,255,255,0.035)',
  borderRadius: 12,
  border: '1px solid rgba(255,255,255,0.06)',
};

const cardHeaderStyle: React.CSSProperties = {
  display: 'flex',
  justifyContent: 'space-between',
  alignItems: 'center',
  gap: 8,
  marginBottom: 6,
};

const errorStyle: React.CSSProperties = {
  padding: 8,
  background: 'rgba(220,38,38,0.16)',
  borderRadius: 12,
  border: '1px solid rgba(220,38,38,0.26)',
  fontSize: 11,
  color: '#fecaca',
  lineHeight: 1.45,
};

const tileRowStyle: React.CSSProperties = {
  display: 'flex',
  alignItems: 'stretch',
  justifyContent: 'space-between',
  gap: 8,
  padding: 8,
  background: 'rgba(255,255,255,0.03)',
  borderRadius: 10,
  border: '1px solid rgba(255,255,255,0.05)',
};

const tileMetaButtonStyle: React.CSSProperties = {
  flex: 1,
  minWidth: 0,
  border: 'none',
  background: 'transparent',
  textAlign: 'left',
  padding: 0,
  cursor: 'pointer',
};

const tileNameStyle: React.CSSProperties = {
  fontSize: 11,
  color: '#f0f4fa',
  overflow: 'hidden',
  textOverflow: 'ellipsis',
  whiteSpace: 'nowrap',
};

const tileMetaStyle: React.CSSProperties = {
  fontSize: 10,
  color: '#8d97a7',
  marginTop: 2,
};

const tileActionsStyle: React.CSSProperties = {
  display: 'flex',
  gap: 6,
  alignItems: 'center',
};

const iconBtnStyle: React.CSSProperties = {
  minWidth: 34,
  background: 'rgba(255,255,255,0.04)',
  border: '1px solid rgba(255,255,255,0.08)',
  cursor: 'pointer',
  fontSize: 10,
  color: '#f5f7fb',
  padding: '8px 9px',
  borderRadius: 9,
  lineHeight: 1,
};

const barBgStyle: React.CSSProperties = {
  width: '100%',
  height: 5,
  background: 'rgba(255,255,255,0.08)',
  borderRadius: 999,
  overflow: 'hidden',
};

const barFillStyle: React.CSSProperties = {
  height: '100%',
  background: 'linear-gradient(90deg, #ff453a, #ff8a5b)',
  borderRadius: 999,
  transition: 'width 0.3s',
};

const mutedTextStyle: React.CSSProperties = {
  fontSize: 10,
  color: '#8d97a7',
};

const messageStyle: React.CSSProperties = {
  margin: '0 0 8px',
  fontSize: 10,
  color: '#d6dce8',
  lineHeight: 1.45,
};

const hintStyle: React.CSSProperties = {
  fontSize: 10,
  color: '#b6becf',
  lineHeight: 1.5,
  padding: '0 2px',
};

const tilesListStyle: React.CSSProperties = {
  maxHeight: 220,
  overflowY: 'auto',
  display: 'flex',
  flexDirection: 'column',
  gap: 6,
};
