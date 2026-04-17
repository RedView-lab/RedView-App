import { Section } from '../components/Section';
import { VisibilityButton } from '../components/VisibilityButton';
import { IconCube, IconExpand, IconTrash } from '../icons';
import type { ControlPanelHandlers, ControlPanelState } from '../types';

interface Props {
  tiles: ControlPanelState['lidarTiles'];
  onTileToggle: ControlPanelHandlers['onLidarTileToggle'];
  onTileDelete: ControlPanelHandlers['onLidarTileDelete'];
  onDownload: ControlPanelHandlers['onLidarTileDownload'];
}

export function LidarTilesSection({ tiles, onTileToggle, onTileDelete, onDownload }: Props) {
  return (
    <Section title={`Tuiles LIDAR ( ${tiles.length} )`} icon={<IconCube size={12} />}>
      <div className="rvc-lidar__list">
        {tiles.map((tile) => (
          <div key={tile.id} className="rvc-lidar__row">
            <VisibilityButton
              visible={tile.visible}
              onChange={() => onTileToggle?.(tile.id)}
              variant="chip"
            />
            <div className="rvc-lidar__label">
              <IconCube size={12} />
              <span>{tile.label}</span>
            </div>
            <button
              type="button"
              className="rvc-icon-btn rvc-icon-btn--ghost"
              onClick={() => onTileDelete?.(tile.id)}
              aria-label="Supprimer la tuile"
            >
              <IconTrash size={10} />
            </button>
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
