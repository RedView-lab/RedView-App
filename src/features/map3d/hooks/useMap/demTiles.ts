import type { MapSourceDataEvent } from 'mapbox-gl';
import { unifiedDEMSource } from '../../lib/sources';
import { MAP_CACHE_EPOCH } from '../../lib/mapCacheEpoch';

export type DemTileProfile = 'default' | 'terrain';

export type DemSourceDataLike = MapSourceDataEvent & {
  coord?: {
    canonical?: { z: number; x: number; y: number };
    overscaledZ?: number;
    wrap?: number;
  };
  tile?: {
    tileID?: {
      canonical?: { z: number; x: number; y: number };
      overscaledZ?: number;
      wrap?: number;
    };
  };
};

export function getDemTileKey(event: DemSourceDataLike): string | null {
  const directCanonical = event.coord?.canonical;
  if (directCanonical) {
    return `${event.coord?.overscaledZ ?? directCanonical.z}/${directCanonical.x}/${directCanonical.y}/${event.coord?.wrap ?? 0}`;
  }

  const tileId = event.tile?.tileID;
  const tileCanonical = tileId?.canonical;
  if (tileCanonical) {
    return `${tileId?.overscaledZ ?? tileCanonical.z}/${tileCanonical.x}/${tileCanonical.y}/${tileId?.wrap ?? 0}`;
  }

  return null;
}

export function buildDemTilesTemplate(
  cacheBust: number,
  profile: DemTileProfile = 'default',
): string[] {
  const queryParams = [
    `rv-map-cache-epoch=${encodeURIComponent(MAP_CACHE_EPOCH)}`,
    // Marque les requêtes propres à la source de terrain : le SW garde leur
    // travail LiDAR vivant jusqu'à ce que la carte n'attende plus la tuile
    // (demWantedTiles.ts).
    'rv-src=map',
    ...(profile === 'terrain' ? ['rv-dem-profile=terrain'] : []),
    ...(cacheBust > 0 ? [`rv-dem=${cacheBust}`] : []),
  ];

  return unifiedDEMSource.tiles.map((tile) => `${tile}?${queryParams.join('&')}`);
}