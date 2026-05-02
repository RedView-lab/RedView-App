import type { TileCoord } from '../../types';

export interface TileNavigatorCell {
  coord: TileCoord;
  offsetX: number;
  offsetY: number;
}

export function tileCoordKey(coord: Pick<TileCoord, 'xKm' | 'yKm' | 'projection' | 'altRef'>): string {
  return `${coord.xKm}_${coord.yKm}_${coord.projection}_${coord.altRef}`;
}

export function buildTileNavigatorCells(center: TileCoord): TileNavigatorCell[] {
  const cells: TileNavigatorCell[] = [];

  for (let offsetY = 1; offsetY >= -1; offsetY -= 1) {
    for (let offsetX = -1; offsetX <= 1; offsetX += 1) {
      cells.push({
        coord: {
          ...center,
          xKm: center.xKm + offsetX,
          yKm: center.yKm + offsetY,
        },
        offsetX,
        offsetY,
      });
    }
  }

  return cells;
}

export function buildTileNavigatorLabel(cell: TileNavigatorCell): string {
  if (cell.offsetX === 0 && cell.offsetY === 0) {
    return `Tuile ouverte ${cell.coord.xKm}/${cell.coord.yKm}`;
  }

  const horizontal = cell.offsetX < 0 ? 'ouest' : cell.offsetX > 0 ? 'est' : 'centre';
  const vertical = cell.offsetY > 0 ? 'nord' : cell.offsetY < 0 ? 'sud' : 'centre';

  return `Tuile ${horizontal} ${vertical} ${cell.coord.xKm}/${cell.coord.yKm}`;
}