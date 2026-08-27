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

export function buildTileNavigatorLabel(
  cell: TileNavigatorCell,
  state?: { isCurrent?: boolean; isActiveSecondary?: boolean; isCached?: boolean; isPreviewing?: boolean },
): string {
  if (state?.isCurrent || (cell.offsetX === 0 && cell.offsetY === 0)) {
    return `Tuile principale ${cell.coord.xKm}/${cell.coord.yKm}`;
  }

  const horizontal = cell.offsetX < 0 ? 'ouest' : cell.offsetX > 0 ? 'est' : 'centre';
  const vertical = cell.offsetY > 0 ? 'nord' : cell.offsetY < 0 ? 'sud' : 'centre';
  const loc = `Tuile ${horizontal} ${vertical} ${cell.coord.xKm}/${cell.coord.yKm}`;

  if (state?.isActiveSecondary) {
    return `${loc} · Affichée (clic pour masquer)`;
  }
  if (state?.isPreviewing) {
    return state.isCached
      ? `${loc} · En prévisualisation 3D (cliquez à nouveau pour afficher)`
      : `${loc} · En prévisualisation 3D (cliquez à nouveau pour confirmer et télécharger)`;
  }
  if (state?.isCached) {
    return `${loc} · Téléchargée (clic pour prévisualiser en 3D)`;
  }
  return `${loc} · Clic pour prévisualiser en 3D`;
}