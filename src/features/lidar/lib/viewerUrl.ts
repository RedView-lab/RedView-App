import type { TileCoord } from '../types';

type ViewerTileParams = Pick<TileCoord, 'xKm' | 'yKm' | 'projection' | 'altRef'>;

export function buildViewerUrl(coord: ViewerTileParams, secondaryCoord?: ViewerTileParams | null): string {
  const params = new URLSearchParams({
    x: String(coord.xKm),
    y: String(coord.yKm),
    crs: coord.projection,
    alt: coord.altRef,
  });

  if (secondaryCoord) {
    params.set('sx', String(secondaryCoord.xKm));
    params.set('sy', String(secondaryCoord.yKm));
  }

  return `/viewer.html?${params.toString()}`;
}