import { Section } from '../components/Section';
import { IconCube, IconExpand, IconExternalLink, IconTrash } from '../icons';
import type { DownloadProgress } from '@/features/lidar/types';
import type { ControlPanelHandlers, ControlPanelState } from '../types';

interface Props {
  tiles: ControlPanelState['lidarTiles'];
  progress?: DownloadProgress | null;
  error?: string | null;
  downloadModeActive?: boolean;
  open?: boolean;
  onOpenChange?: (open: boolean) => void;
  onTileToggle: ControlPanelHandlers['onLidarTileToggle'];
  onTileOpen: ControlPanelHandlers['onLidarTileOpen'];
  onTileDelete: ControlPanelHandlers['onLidarTileDelete'];
  onDownload: ControlPanelHandlers['onLidarTileDownload'];
}

export function LidarTilesSection({
  tiles,
  progress,
  error,
  downloadModeActive,
  open,
  onOpenChange,
  onTileOpen,
  onTileDelete,
  onDownload,
}: Props) {
  const progressPercent = progress?.totalBytes
    ? Math.min(100, (progress.bytesDownloaded / progress.totalBytes) * 100)
    : 0;
  const progressText = !progress
    ? null
    : progress.totalBytes > 0
      ? `${formatMegabytes(progress.bytesDownloaded)} / ${formatMegabytes(progress.totalBytes)}`
      : formatMegabytes(progress.bytesDownloaded);
  const buttonLabel = progress
    ? progressText
      ? `Téléchargement ${progressText}`
      : progress.message ?? 'Téléchargement en cours'
    : downloadModeActive
      ? 'Clique sur la carte pour choisir une tuile'
      : 'Télécharger une tuile LIDAR';
  const buttonMeta = progress
    ? progress.message ?? 'Téléchargement en cours'
    : error
      ? error
      : downloadModeActive
        ? 'Mode sélection actif'
        : 'Active le mode puis clique sur la carte';

  return (
    <Section
      title={`Tuiles LIDAR ( ${tiles.length} )`}
      icon={<IconCube size={12} />}
      open={open}
      onOpenChange={onOpenChange}
    >
      <div className="rvc-lidar__list">
        {tiles.map((tile) => (
          <div key={tile.id} className="rvc-lidar__row">
            <div className="rvc-lidar__label" title={tile.label}>
              <IconCube size={12} />
              <span>{tile.label}</span>
            </div>
            <div className="rvc-lidar__actions">
              <button
                type="button"
                className="rvc-lidar__action-btn"
                onClick={() => onTileOpen?.(tile.id)}
                aria-label="Ouvrir dans le viewer 3D"
                title="Ouvrir dans le viewer 3D LIDAR"
              >
                <IconExternalLink size={14} />
              </button>
              <button
                type="button"
                className="rvc-lidar__action-btn"
                onClick={() => onTileDelete?.(tile.id)}
                aria-label="Supprimer la tuile"
                title="Supprimer la tuile"
              >
                <IconTrash size={15} />
              </button>
            </div>
          </div>
        ))}
      </div>
      <button
        type="button"
        className={`rvc-btn-primary rvc-btn-primary--lidar${progress ? ' is-busy' : ''}`}
        onClick={onDownload}
      >
        <IconExpand size={18} />
        <span className="rvc-btn-primary__content">
          <span>{buttonLabel}</span>
          <span className={`rvc-lidar__download-meta${error ? ' is-error' : ''}`}>{buttonMeta}</span>
          {progress && progress.phase === 'downloading' && progress.totalBytes > 0 ? (
            <span className="rvc-lidar__download-bar" aria-hidden="true">
              <span className="rvc-lidar__download-bar-fill" style={{ width: `${progressPercent}%` }} />
            </span>
          ) : null}
        </span>
      </button>
    </Section>
  );
}

function formatMegabytes(bytes: number): string {
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}
