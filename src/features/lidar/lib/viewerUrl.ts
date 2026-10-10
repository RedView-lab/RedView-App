import type { TileCoord } from '../types';
import { formatTileFootprint, tileFootprintSuffix } from './coordConvert';
import { getLidarRouteSyncProject } from './routeOverlaySync';

type ViewerTileParams = Pick<TileCoord, 'xKm' | 'yKm' | 'projection' | 'altRef' | 'footprint'>;

export const MAX_VIEWER_SCENE_TILES = 9;

function viewerTileKey(coord: ViewerTileParams): string {
  return `${coord.xKm}_${coord.yKm}_${coord.projection}_${coord.altRef}${tileFootprintSuffix(coord)}`;
}

function normalizeViewerSceneTiles(
  coord: ViewerTileParams,
  selectedCoords?: ViewerTileParams | ViewerTileParams[] | null,
): ViewerTileParams[] {
  const extras = Array.isArray(selectedCoords)
    ? selectedCoords
    : selectedCoords
      ? [selectedCoords]
      : [];

  const seen = new Set<string>([viewerTileKey(coord)]);
  const tiles: ViewerTileParams[] = [coord];

  for (const extra of extras) {
    const key = viewerTileKey(extra);
    if (seen.has(key)) continue;
    tiles.push(extra);
    seen.add(key);
    if (tiles.length >= MAX_VIEWER_SCENE_TILES) break;
  }

  return tiles;
}

/**
 * `projectId` : projet d'où le visualiseur est ouvert (par défaut celui de la
 * page : le projet ouvert dans l'app, ou celui du visualiseur qui change de
 * dalle) ; ses traces et commentaires ne parlent qu'à ce projet (C2-1, C2-2).
 */
export function buildViewerUrl(
  coord: ViewerTileParams,
  selectedCoords?: ViewerTileParams | ViewerTileParams[] | null,
  projectId: string | null = getLidarRouteSyncProject(),
): string {
  const params = new URLSearchParams({
    x: String(coord.xKm),
    y: String(coord.yKm),
    crs: coord.projection,
    alt: coord.altRef,
  });
  if (projectId) params.set('project', projectId);
  // Dalle-fichier (Japon, NZ) : emprise du fichier, `x`/`y` étant le km de son centre.
  if (coord.footprint) params.set('fp', formatTileFootprint(coord.footprint));

  const sceneTiles = normalizeViewerSceneTiles(coord, selectedCoords);
  for (let index = 1; index < sceneTiles.length; index += 1) {
    const tile = sceneTiles[index];
    params.append('tile', tile.footprint ? `${tile.xKm},${tile.yKm},${formatTileFootprint(tile.footprint)}` : `${tile.xKm},${tile.yKm}`);
  }

  return `/viewer.html?${params.toString()}`;
}