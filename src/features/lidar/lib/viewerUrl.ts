import type { TileCoord } from '../types';

type ViewerTileParams = Pick<TileCoord, 'xKm' | 'yKm' | 'projection' | 'altRef'>;

export const MAX_VIEWER_SCENE_TILES = 9;

function viewerTileKey(coord: ViewerTileParams): string {
  return `${coord.xKm}_${coord.yKm}_${coord.projection}_${coord.altRef}`;
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

export function buildViewerUrl(
  coord: ViewerTileParams,
  selectedCoords?: ViewerTileParams | ViewerTileParams[] | null,
): string {
  const params = new URLSearchParams({
    x: String(coord.xKm),
    y: String(coord.yKm),
    crs: coord.projection,
    alt: coord.altRef,
  });

  const sceneTiles = normalizeViewerSceneTiles(coord, selectedCoords);
  for (let index = 1; index < sceneTiles.length; index += 1) {
    const tile = sceneTiles[index];
    params.append('tile', `${tile.xKm},${tile.yKm}`);
  }

  return `/viewer.html?${params.toString()}`;
}