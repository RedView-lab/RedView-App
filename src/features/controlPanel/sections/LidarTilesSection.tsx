import { useEffect, useRef, useState } from 'react';
import { useAppI18n } from '@/shared/i18n';
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
  onTileRename?: ControlPanelHandlers['onLidarTileRename'];
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
  onTileRename,
  onDownload,
}: Props) {
  const { t } = useAppI18n();
  const [editingId, setEditingId] = useState<string | null>(null);
  const [draft, setDraft] = useState('');
  const inputRef = useRef<HTMLInputElement | null>(null);

  useEffect(() => {
    if (!editingId) return;
    const el = inputRef.current;
    if (el) {
      el.focus();
      el.select();
    }
  }, [editingId]);

  const startEdit = (id: string, currentLabel: string) => {
    if (!onTileRename) return;
    setEditingId(id);
    setDraft(currentLabel);
  };

  const commit = (id: string) => {
    const trimmed = draft.trim();
    if (trimmed && onTileRename) onTileRename(id, trimmed);
    setEditingId(null);
  };

  const cancel = () => setEditingId(null);
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
      ? t('Téléchargement {{progress}}', { progress: progressText })
      : progress.message ?? t('Téléchargement en cours')
    : downloadModeActive
      ? t('Clique sur la carte pour choisir une tuile')
      : t('Télécharger une tuile LIDAR');
  const buttonMeta = progress
    ? progress.message ?? t('Téléchargement en cours')
    : error
      ? error
      : downloadModeActive
        ? t('Mode sélection actif')
        : t('Active le mode puis clique sur la carte');

  return (
    <Section
      title={t('Tuiles LIDAR ( {{count}} )', { count: tiles.length })}
      icon={<IconCube size={16} />}
      open={open}
      onOpenChange={onOpenChange}
    >
      <div className="rvc-lidar__list">
        {tiles.map((tile) => {
          const isEditing = editingId === tile.id;
          return (
            <div key={tile.id} className="rvc-lidar__row">
              <div className="rvc-lidar__label" title={tile.label}>
                <IconCube size={12} />
                {isEditing ? (
                  <input
                    ref={inputRef}
                    className="rvc-lidar__label-input"
                    value={draft}
                    onChange={(e) => setDraft(e.target.value)}
                    onClick={(e) => e.stopPropagation()}
                    onBlur={() => commit(tile.id)}
                    onKeyDown={(e) => {
                      if (e.key === 'Enter') {
                        e.preventDefault();
                        commit(tile.id);
                      } else if (e.key === 'Escape') {
                        e.preventDefault();
                        cancel();
                      }
                    }}
                  />
                ) : (
                  <span
                    className={
                      onTileRename
                        ? 'rvc-lidar__label-text is-editable'
                        : 'rvc-lidar__label-text'
                    }
                    onClick={() => startEdit(tile.id, tile.label)}
                    title={onTileRename ? t('Cliquer pour renommer') : tile.label}
                  >
                    {tile.label}
                  </span>
                )}
              </div>
              <div className="rvc-lidar__actions">
                <button
                  type="button"
                  className="rvc-lidar__action-btn"
                  onClick={() => onTileOpen?.(tile.id)}
                  aria-label={t('Ouvrir dans le viewer 3D')}
                  title={t('Ouvrir dans le viewer 3D LIDAR')}
                >
                  <IconExternalLink size={14} />
                </button>
                <button
                  type="button"
                  className="rvc-lidar__action-btn"
                  onClick={() => onTileDelete?.(tile.id)}
                  aria-label={t('Supprimer la tuile')}
                  title={t('Supprimer la tuile')}
                >
                  <IconTrash size={15} />
                </button>
              </div>
            </div>
          );
        })}
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
