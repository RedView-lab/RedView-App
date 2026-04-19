import { Section } from '../components/Section';
import { IconCube, IconExpand, IconExternalLink, IconTrash } from '../icons';
import type { ControlPanelHandlers, ControlPanelState } from '../types';

interface Props {
  tiles: ControlPanelState['lidarTiles'];
  onTileToggle: ControlPanelHandlers['onLidarTileToggle'];
  onTileOpen: ControlPanelHandlers['onLidarTileOpen'];
  onTileDelete: ControlPanelHandlers['onLidarTileDelete'];
  onDownload: ControlPanelHandlers['onLidarTileDownload'];
}

export function LidarTilesSection({ tiles, onTileOpen, onTileDelete, onDownload }: Props) {
  return (
    <Section title={`Tuiles LIDAR ( ${tiles.length} )`} icon={<IconCube size={12} />}>
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
      <button type="button" className="rvc-btn-primary" onClick={onDownload}>
        <IconExpand size={18} />
        <span>Télécharger une tuile LIDAR</span>
      </button>
    </Section>
  );
}
