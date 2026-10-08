import type { TileCoord } from '../../types';
import { translateAppText } from '@/shared/i18n/config';
import { kmTileCoord, tileFootprintSuffix } from '../../lib/coordConvert';

export interface TileNavigatorCell {
  coord: TileCoord;
  offsetX: number;
  offsetY: number;
}

export function tileCoordKey(coord: Pick<TileCoord, 'xKm' | 'yKm' | 'projection' | 'altRef' | 'footprint'>): string {
  return `${coord.xKm}_${coord.yKm}_${coord.projection}_${coord.altRef}${tileFootprintSuffix(coord)}`;
}

export function buildTileNavigatorCells(center: TileCoord): TileNavigatorCell[] {
  const cells: TileNavigatorCell[] = [];

  for (let offsetY = 1; offsetY >= -1; offsetY -= 1) {
    for (let offsetX = -1; offsetX <= 1; offsetX += 1) {
      // Les voisines sont des dalles de 1 km, même autour d'une dalle-fichier (Japon, NZ).
      cells.push({
        coord: offsetX === 0 && offsetY === 0
          ? center
          : kmTileCoord({ ...center, xKm: center.xKm + offsetX, yKm: center.yKm + offsetY }),
        offsetX,
        offsetY,
      });
    }
  }

  return cells;
}

/** Libellés des tuiles voisines, indexés par le décalage `<vertical>-<horizontal>`. */
const NEIGHBOUR_TILE_LABELS: Record<string, string> = {
  'north-west': 'Tuile nord-ouest {{x}}/{{y}}',
  'north-center': 'Tuile nord {{x}}/{{y}}',
  'north-east': 'Tuile nord-est {{x}}/{{y}}',
  'center-west': 'Tuile ouest {{x}}/{{y}}',
  'center-east': 'Tuile est {{x}}/{{y}}',
  'south-west': 'Tuile sud-ouest {{x}}/{{y}}',
  'south-center': 'Tuile sud {{x}}/{{y}}',
  'south-east': 'Tuile sud-est {{x}}/{{y}}',
};

export function buildTileNavigatorLabel(
  cell: TileNavigatorCell,
  state?: { isCurrent?: boolean; isActiveSecondary?: boolean; isCached?: boolean; isPreviewing?: boolean },
): string {
  if (state?.isCurrent || (cell.offsetX === 0 && cell.offsetY === 0)) {
    return translateAppText('Tuile principale {{x}}/{{y}}', { x: cell.coord.xKm, y: cell.coord.yKm });
  }

  const vertical = cell.offsetY > 0 ? 'north' : cell.offsetY < 0 ? 'south' : 'center';
  const horizontal = cell.offsetX < 0 ? 'west' : cell.offsetX > 0 ? 'east' : 'center';
  const locTemplate = NEIGHBOUR_TILE_LABELS[`${vertical}-${horizontal}`] ?? 'Tuile {{x}}/{{y}}';
  const tile = translateAppText(locTemplate, { x: cell.coord.xKm, y: cell.coord.yKm });

  if (state?.isActiveSecondary) {
    return translateAppText('{{tile}} · Affichée (clic pour masquer)', { tile });
  }
  if (state?.isPreviewing) {
    return state.isCached
      ? translateAppText('{{tile}} · En prévisualisation 3D (cliquez à nouveau pour afficher)', { tile })
      : translateAppText('{{tile}} · En prévisualisation 3D (cliquez à nouveau pour confirmer et télécharger)', { tile });
  }
  if (state?.isCached) {
    return translateAppText('{{tile}} · Téléchargée (clic pour prévisualiser en 3D)', { tile });
  }
  return translateAppText('{{tile}} · Clic pour prévisualiser en 3D', { tile });
}